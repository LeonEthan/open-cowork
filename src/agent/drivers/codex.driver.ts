import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentDriver,
  AgentEvent,
  DriverSession,
  DriverStartParams,
  NormalizedToolCall,
  PermissionRequestPayload,
  SessionEndReason,
} from '../events';
import { deriveToolTarget } from './claude.driver';
import { JsonRpcPeer, createLineSplitter } from './jsonRpcPeer';
import { resolvePermission } from './permission';
import type { AgentDriverDefinition } from './registry';

/**
 * Codex driver（ticket #22）：spawn `codex app-server`，stdio 上跑换行分隔 JSON-RPC。
 * 协议形状以本机 codex 0.146.0 `app-server generate-ts` 生成的绑定与实测握手为准：
 *
 *   client → server：
 *     initialize {clientInfo, capabilities} → {userAgent, codexHome, …}
 *     initialized（通知）
 *     thread/start {cwd, model?, approvalPolicy, sandbox, ephemeral} → {thread, model, cwd, …}
 *     turn/start {threadId, input:[{type:'text',text,text_elements:[]}]} → {turn}
 *     turn/interrupt {threadId, turnId}（取消用，尽力而为）
 *   server → client 通知：
 *     item/agentMessage/delta {delta}        → text_delta
 *     item/reasoning/(summary)textDelta      → thinking_delta
 *     item/started | item/completed          → tool_call（commandExecution/fileChange/mcpToolCall）
 *     thread/tokenUsage/updated              → 暂存，turn/completed 时归一 usage（ARCHITECTURE §9）
 *     turn/completed {turn.status}           → turn_end（completed/failed/interrupted→cancelled）
 *     error {willRetry}                      → error（非致命；轮次终态以 turn/completed 为准）
 *   server → client 反向请求（审批，原生能力）：
 *     item/commandExecution/requestApproval  → {decision: accept|acceptForSession|decline}
 *     item/fileChange/requestApproval        → 同上
 *     execCommandApproval / applyPatchApproval（旧版）→ ReviewDecision
 *     其余（elicitation 等）一律回 JSON-RPC error —— fail-closed（§10）。
 *
 * 注入点（DriverStartParams）：executablePath（缺省 OPEN_COWORK_CODEX_CLI，再缺省 'codex'）/
 * env（#21 provider 密钥）/ cwd / model。
 * 约定同 claude driver：session_ended 由宿主在 done 结算时补发，driver 不发。
 */

const KILL_GRACE_MS = 2_000;

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface CodexState {
  child: ChildProcess;
  peer: JsonRpcPeer;
  threadId: string | null;
  turnId: string | null;
  turnActive: boolean;
  cancelled: boolean;
  /** 进行中的工具调用快照（itemId → NormalizedToolCall） */
  toolCalls: Map<string, NormalizedToolCall>;
  /** 当前轮次最近一次 tokenUsage/updated 的 last 段 */
  lastUsage: TurnUsage | null;
  model: string | null;
  cwd: string;
  /** 子进程 stderr 尾部（排障） */
  stderrTail: string;
}

/** commandExecution/fileChange/mcpToolCall item → 归一 tool_call(running) */
function toolCallFromItem(item: Record<string, unknown>): NormalizedToolCall | null {
  const id = typeof item.id === 'string' ? item.id : null;
  if (!id) return null;
  switch (item.type) {
    case 'commandExecution': {
      const command = typeof item.command === 'string' ? item.command : '';
      return {
        id,
        name: 'Bash',
        target: deriveToolTarget('Bash', { command }),
        status: 'running',
        input: { command },
      };
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first = changes[0] as { path?: unknown } | undefined;
      const filePath = typeof first?.path === 'string' ? first.path : null;
      return {
        id,
        name: 'Edit',
        target: deriveToolTarget('Edit', { file_path: filePath }),
        status: 'running',
        input: { file_path: filePath },
      };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const tool = typeof item.tool === 'string' ? item.tool : 'mcp';
      const server =
        typeof item.server === 'string'
          ? item.server
          : typeof item.namespace === 'string'
            ? item.namespace
            : null;
      return {
        id,
        name: tool,
        target: server,
        status: 'running',
        input: item.arguments ?? null,
      };
    }
    default:
      return null;
  }
}

/** item/completed → 归一 tool_call(done|error)（未知 item 以先前快照补齐） */
function toolResultFromItem(
  item: Record<string, unknown>,
  prev: NormalizedToolCall | undefined,
): NormalizedToolCall | null {
  const id = typeof item.id === 'string' ? item.id : null;
  if (!id) return null;
  const base: NormalizedToolCall =
    prev ?? toolCallFromItem(item) ?? { id, name: 'unknown', target: null, status: 'running' };
  const truncate = (s: string): string => (s.length > 2000 ? `${s.slice(0, 2000)}…` : s);
  switch (item.type) {
    case 'commandExecution': {
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
      const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null;
      const isError = exitCode !== null ? exitCode !== 0 : item.status === 'failed';
      return {
        ...base,
        status: isError ? 'error' : 'done',
        output: output ? truncate(output) : null,
        ...(isError ? { error: output ? truncate(output) : `exit code ${exitCode ?? '?'}` } : {}),
      };
    }
    case 'fileChange': {
      const isError = item.status === 'failed' || item.status === 'declined';
      return { ...base, status: isError ? 'error' : 'done', output: null };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const isError = item.status === 'failed' || item.error != null;
      const resultText =
        item.result != null ? truncate(JSON.stringify(item.result)) : null;
      return {
        ...base,
        status: isError ? 'error' : 'done',
        output: resultText,
        ...(isError ? { error: resultText ?? 'tool call failed' } : {}),
      };
    }
    default:
      return null;
  }
}

function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  // 宽限后 SIGKILL（真实 server 可能优雅退出挂起）
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }, KILL_GRACE_MS);
  child.once('exit', () => clearTimeout(timer));
}

class CodexDriverSession implements DriverSession {
  readonly done: Promise<{ reason: SessionEndReason; error?: string }>;
  /** ticket #30：自 spawn 的 `codex app-server` 子进程 pid（进程注册表二级清扫用） */
  readonly pid: number | undefined;
  private readonly state: CodexState;
  private alive = true;

  constructor(
    private readonly params: DriverStartParams,
    private readonly emit: (e: AgentEvent) => void,
  ) {
    const executable =
      params.executablePath ?? process.env.OPEN_COWORK_CODEX_CLI ?? 'codex';
    const child = spawn(executable, ['app-server'], {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // spawn 失败（ENOENT 等）时 child.pid 为 undefined——保持缺省，二级清扫无 pid 可登记
    this.pid = child.pid;

    const peer = new JsonRpcPeer(
      (msg) => {
        try {
          child.stdin.write(`${JSON.stringify(msg)}\n`);
        } catch {
          // 进程已死：done 流程收尾
        }
      },
      {
        onNotification: (method, p) => this.onNotification(method, p),
        onServerRequest: (req) => this.onServerRequest(req),
        onParseError: (line) =>
          this.emit({ type: 'error', message: `codex 协议帧解析失败: ${line.slice(0, 200)}`, fatal: false }),
      },
    );

    this.state = {
      child,
      peer,
      threadId: null,
      turnId: null,
      turnActive: false,
      cancelled: false,
      toolCalls: new Map(),
      lastUsage: null,
      model: params.model ?? null,
      cwd: params.cwd,
      stderrTail: '',
    };

    child.stdout.setEncoding('utf8');
    const feed = createLineSplitter((line) => peer.feedLine(line));
    child.stdout.on('data', (chunk: string) => feed(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.state.stderrTail = (this.state.stderrTail + chunk).slice(-2000);
    });

    let resolveDone!: (v: { reason: SessionEndReason; error?: string }) => void;
    this.done = new Promise((r) => {
      resolveDone = r;
    });

    child.once('error', (err) => {
      // spawn 失败（ENOENT 等）：exit 不一定触发，这里兜底
      this.alive = false;
      const message = `codex 启动失败: ${err.message}`;
      emit({ type: 'error', message, fatal: true });
      emit({ type: 'turn_end', status: 'failed', reason: message });
      resolveDone({ reason: 'failed', error: message });
    });

    child.once('exit', (code, signal) => {
      this.alive = false;
      peer.destroy(new Error('codex 进程已退出'));
      const s = this.state;
      if (s.cancelled) {
        if (s.turnActive) {
          s.turnActive = false;
          emit({ type: 'turn_end', status: 'cancelled' });
        }
        resolveDone({ reason: 'cancelled' });
        return;
      }
      if (s.turnActive || (code !== 0 && code !== null) || signal) {
        const detail =
          this.state.stderrTail.trim() ||
          `codex 进程退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        const message = `codex 会话异常终止: ${detail}`;
        emit({ type: 'error', message, fatal: true });
        if (s.turnActive) {
          s.turnActive = false;
          emit({ type: 'turn_end', status: 'failed', reason: message });
        }
        resolveDone({ reason: 'failed', error: message });
        return;
      }
      resolveDone({ reason: 'completed' });
    });

    void this.handshake(params).catch((err: unknown) => {
      // 握手失败：杀掉进程，exit 流程统一结算（turnActive 尚未置位则直接结算）
      const message = err instanceof Error ? err.message : String(err);
      if (this.alive) {
        this.alive = false;
        emit({ type: 'error', message, fatal: true });
        emit({ type: 'turn_end', status: 'failed', reason: message });
        killChild(child);
        resolveDone({ reason: 'failed', error: message });
      }
    });
  }

  /** initialize → initialized → thread/start → 首轮 turn/start */
  private async handshake(params: DriverStartParams): Promise<void> {
    const s = this.state;
    await s.peer.call('initialize', {
      clientInfo: { name: 'open-cowork', title: null, version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    s.peer.notify('initialized');
    const threadResult = (await s.peer.call('thread/start', {
      cwd: params.cwd,
      ...(params.model ? { model: params.model } : {}),
      // 审批走原生：请求路由回本 driver（fail-closed 链路由 permissionHandler 决议）
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      // 任务会话不写入用户 codex 历史（不碰全局的保守面；resume 属后续票据）
      ephemeral: true,
    })) as { thread?: { id?: string }; model?: string; cwd?: string };
    const threadId = threadResult?.thread?.id;
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error('codex thread/start 未返回 thread.id');
    }
    s.threadId = threadId;
    if (typeof threadResult.model === 'string') s.model = threadResult.model;
    if (typeof threadResult.cwd === 'string') s.cwd = threadResult.cwd;
    this.emit({
      type: 'session_started',
      sessionId: threadId,
      model: s.model,
      cwd: s.cwd,
    });
    await this.startTurn(params.prompt);
  }

  private async startTurn(text: string): Promise<void> {
    const s = this.state;
    if (!s.threadId) throw new Error('thread 尚未建立');
    s.turnActive = true;
    s.lastUsage = null;
    const result = (await s.peer.call('turn/start', {
      threadId: s.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })) as { turn?: { id?: string } };
    if (typeof result?.turn?.id === 'string') s.turnId = result.turn.id;
  }

  // ── server → client 通知归一 ───────────────────────────────────────────

  private onNotification(method: string, params: unknown): void {
    const s = this.state;
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'turn/started': {
        const turn = p.turn as { id?: unknown } | undefined;
        if (typeof turn?.id === 'string') s.turnId = turn.id;
        s.turnActive = true;
        break;
      }

      case 'item/agentMessage/delta': {
        if (typeof p.delta === 'string' && p.delta.length > 0) {
          s.turnActive = true;
          this.emit({ type: 'text_delta', delta: p.delta });
        }
        break;
      }

      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        if (typeof p.delta === 'string' && p.delta.length > 0) {
          s.turnActive = true;
          this.emit({ type: 'thinking_delta', delta: p.delta });
        }
        break;
      }

      case 'item/started': {
        const item = p.item as Record<string, unknown> | undefined;
        if (!item) break;
        if (item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'commandExecution') {
          s.turnActive = true;
        }
        const call = toolCallFromItem(item);
        if (call) {
          s.toolCalls.set(call.id, call);
          this.emit({ type: 'tool_call', call });
        }
        break;
      }

      case 'item/completed': {
        const item = p.item as Record<string, unknown> | undefined;
        if (!item) break;
        const id = typeof item.id === 'string' ? item.id : null;
        const prev = id ? s.toolCalls.get(id) : undefined;
        const call = toolResultFromItem(item, prev);
        if (call) {
          s.toolCalls.set(call.id, call);
          this.emit({ type: 'tool_call', call });
        }
        // agentMessage/reasoning 完成帧忽略——流式增量已发（防双份）
        break;
      }

      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage as { last?: Record<string, unknown> } | undefined;
        const last = usage?.last;
        if (last) {
          s.lastUsage = {
            inputTokens: typeof last.inputTokens === 'number' ? last.inputTokens : 0,
            outputTokens: typeof last.outputTokens === 'number' ? last.outputTokens : 0,
            cacheReadTokens:
              typeof last.cachedInputTokens === 'number' ? last.cachedInputTokens : 0,
            cacheWriteTokens:
              typeof last.cacheWriteInputTokens === 'number' ? last.cacheWriteInputTokens : 0,
          };
        }
        break;
      }

      case 'turn/completed': {
        const turn = p.turn as
          | { id?: unknown; status?: unknown; error?: { message?: unknown } | null }
          | undefined;
        const status = turn?.status;
        s.turnActive = false;
        if (status === 'interrupted') {
          this.emit({ type: 'turn_end', status: 'cancelled' });
          break;
        }
        const u = s.lastUsage;
        this.emit({
          type: 'usage',
          usage: {
            inputTokens: u?.inputTokens ?? 0,
            outputTokens: u?.outputTokens ?? 0,
            cacheReadTokens: u?.cacheReadTokens ?? 0,
            cacheWriteTokens: u?.cacheWriteTokens ?? 0,
            model: s.model,
            raw: p,
          },
        });
        if (status === 'completed' || status == null) {
          this.emit({ type: 'turn_end', status: 'completed' });
        } else {
          const reason =
            typeof turn?.error?.message === 'string'
              ? turn.error.message
              : `codex 轮次失败 (${String(status)})`;
          this.emit({ type: 'turn_end', status: 'failed', reason });
        }
        break;
      }

      case 'error': {
        // willRetry 的重连噪音与轮次错误同通道；轮次终态以 turn/completed 为准
        const errObj = p.error as { message?: unknown } | undefined;
        const message =
          typeof errObj?.message === 'string' ? errObj.message : 'codex 错误通知';
        this.emit({ type: 'error', message, fatal: false });
        break;
      }

      default:
        // 其余通知（thread/* / mcpServer/* / warning…）不归一
        break;
    }
  }

  // ── server → client 反向请求（审批） ─────────────────────────────────────

  private async onServerRequest(req: {
    id: string | number;
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case 'item/commandExecution/requestApproval': {
        const input = { command: typeof p.command === 'string' ? p.command : '' };
        const decision = await this.askPermission({
          toolName: 'Bash',
          target: deriveToolTarget('Bash', input),
          reason: typeof p.reason === 'string' ? p.reason : null,
          input,
          requestKey: String(req.id),
        });
        return { decision: mapExecDecision(decision) };
      }

      case 'item/fileChange/requestApproval': {
        const input = { grantRoot: p.grantRoot ?? null };
        const decision = await this.askPermission({
          toolName: 'Edit',
          target: typeof p.grantRoot === 'string' ? p.grantRoot : null,
          reason: typeof p.reason === 'string' ? p.reason : null,
          input,
          requestKey: String(req.id),
        });
        return { decision: mapExecDecision(decision) };
      }

      // 旧版审批方法（老 codex 兼容面）
      case 'execCommandApproval': {
        const command = Array.isArray(p.command) ? p.command.join(' ') : '';
        const decision = await this.askPermission({
          toolName: 'Bash',
          target: deriveToolTarget('Bash', { command }),
          reason: typeof p.reason === 'string' ? p.reason : null,
          input: { command },
          requestKey: String(req.id),
        });
        return { decision: mapReviewDecision(decision) };
      }
      case 'applyPatchApproval': {
        const decision = await this.askPermission({
          toolName: 'Edit',
          target: typeof p.grantRoot === 'string' ? p.grantRoot : null,
          reason: typeof p.reason === 'string' ? p.reason : null,
          input: { grantRoot: p.grantRoot ?? null },
          requestKey: String(req.id),
        });
        return { decision: mapReviewDecision(decision) };
      }

      default:
        // 未接入的反向请求（elicitation/userInput/tool/call…）：fail-closed 抛错 → JSON-RPC error
        throw new Error(`open-cowork 未接入的 codex 请求: ${req.method}（fail-closed）`);
    }
  }

  /** 审批公共路径：发事件 → 规则/handler 决议（fail-closed）→ 回执事件 */
  private async askPermission(req: {
    toolName: string;
    target: string | null;
    reason: string | null;
    input: unknown;
    requestKey: string;
  }): Promise<{ behavior: 'allow' | 'deny'; always?: boolean; message?: string }> {
    const request: PermissionRequestPayload = {
      id: `codex_perm_${req.requestKey}_${randomUUID().slice(0, 8)}`,
      toolName: req.toolName,
      target: req.target,
      reason: req.reason,
      options: ['allow_once', 'allow_always', 'deny'],
      input: req.input,
      suggestions: null,
    };
    this.emit({ type: 'permission_request', request });
    const decision = await resolvePermission(this.params, request);
    this.emit({ type: 'permission_response', requestId: request.id, decision });
    return decision;
  }

  async sendFollowup(text: string): Promise<void> {
    if (!this.alive) throw new Error('会话已结束，无法追问');
    if (this.state.turnActive) throw new Error('上一轮尚未结束');
    await this.startTurn(text);
  }

  async cancel(): Promise<void> {
    if (!this.alive) return; // 幂等
    this.state.cancelled = true;
    // 尽力 interrupt（轮次语义），随后杀进程（权威路径）；exit 流程补 turn_end(cancelled)
    const s = this.state;
    if (s.threadId && s.turnId) {
      try {
        await Promise.race([
          s.peer.call('turn/interrupt', { threadId: s.threadId, turnId: s.turnId }),
          new Promise((r) => setTimeout(r, 1_000)),
        ]);
      } catch {
        // 进程已死/对端不应答：忽略，kill 兜底
      }
    }
    killChild(s.child);
  }
}

/** v2 审批决策映射（allow_always 回写 agent 侧会话规则，ARCHITECTURE §6） */
function mapExecDecision(d: { behavior: 'allow' | 'deny'; always?: boolean }): string {
  if (d.behavior === 'allow') return d.always ? 'acceptForSession' : 'accept';
  return 'decline';
}

/** 旧版 ReviewDecision 映射 */
function mapReviewDecision(
  d: { behavior: 'allow' | 'deny'; always?: boolean; message?: string },
): unknown {
  if (d.behavior === 'allow') return d.always ? 'approved_for_session' : 'approved';
  return { denied: { rejection: d.message ?? '已拒绝' } };
}

class CodexDriver implements AgentDriver {
  readonly id = 'codex';
  start(params: DriverStartParams, emit: (e: AgentEvent) => void): DriverSession {
    return new CodexDriverSession(params, emit);
  }
}

const definition: AgentDriverDefinition = {
  id: 'codex',
  displayName: 'Codex',
  approval: 'native',
  create: () => new CodexDriver(),
};

export default definition;
