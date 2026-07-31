/**
 * 换行分隔 JSON-RPC peer（ticket #22，codex app-server 协议传输层）。
 *
 * codex app-server（--listen stdio://，默认）在 stdio 上跑 newline-delimited JSON-RPC：
 * - client → server：request {id, method, params} / notification {method}（无 id）；
 * - server → client：response {id, result|error} / notification {method, params} /
 *   server 反向 request {id, method, params}（审批请求走这里，client 须回 {id, result}）。
 *
 * 本类只做帧分派与 id 配对，不认识任何具体 method（协议归一在 codex.driver.ts）。
 * 纯 Node 可测：feedLine 手动喂帧即可驱动全部分支（含乱序通知）。
 */

export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcPeerHandlers {
  /** server → client 通知（无 id） */
  onNotification: (method: string, params: unknown) => void;
  /**
   * server → client 反向请求（须回执）。handler 返回值作为 result 回发；
   * 抛错则回 JSON-RPC error（fail-closed：对端视为请求失败）。
   */
  onServerRequest: (req: JsonRpcServerRequest) => Promise<unknown>;
  /** 帧解析失败（坏行）——协议鲁棒性：记后不中断 */
  onParseError?: (line: string, error: Error) => void;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingCall>();
  private closed = false;

  constructor(
    private readonly send: (message: unknown) => void,
    private readonly handlers: JsonRpcPeerHandlers,
  ) {}

  /** client 请求：id 配对等待 result；对端 error 帧 reject */
  call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC 传输已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /** client 通知（无 id，无回执） */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ method, ...(params !== undefined ? { params } : {}) });
  }

  /** 应答 server 反向请求 */
  respond(id: string | number, result: unknown): void {
    if (this.closed) return;
    this.send({ id, result });
  }

  /** 喂入一行 wire 帧（换行切分由调用方做）。乱序通知/请求交错安全：响应按 id 配对 */
  feedLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      this.handlers.onParseError?.(trimmed, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
    const hasMethod = typeof msg.method === 'string';

    if (hasId && hasMethod) {
      // server → client 反向请求（审批等）
      const req: JsonRpcServerRequest = {
        id: msg.id as string | number,
        method: msg.method as string,
        params: msg.params,
      };
      void this.handlers
        .onServerRequest(req)
        .then((result) => this.respond(req.id, result))
        .catch((err: unknown) => {
          if (!this.closed) {
            this.send({
              id: req.id,
              error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
            });
          }
        });
      return;
    }
    if (hasId && !hasMethod) {
      // 我方 call 的响应
      const id = msg.id as string | number;
      const call = this.pending.get(id);
      if (!call) return; // 迟到/陌生响应：吞掉（可能在我方取消后到达）
      this.pending.delete(id);
      if (msg.error && typeof msg.error === 'object') {
        const e = msg.error as { code?: number; message?: string };
        call.reject(new Error(e.message ?? `JSON-RPC 错误 ${e.code ?? 'unknown'}`));
      } else {
        call.resolve(msg.result);
      }
      return;
    }
    if (!hasId && hasMethod) {
      this.handlers.onNotification(msg.method as string, msg.params);
      return;
    }
    // 既无 id 又无 method 的帧：协议外噪音，忽略
  }

  /** 传输死亡：所有在途 call 一律 reject（调用方负责后续归一） */
  destroy(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}

/** 行切分器：处理跨 chunk 粘包/分包（\r\n 兼容） */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  };
}
