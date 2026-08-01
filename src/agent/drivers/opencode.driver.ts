import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  AgentDriver,
  AgentEvent,
  DriverSession,
  DriverStartParams,
  NormalizedToolCall,
  PermissionRequestPayload,
  SessionEndReason,
} from '../events';
import { resolvePermission } from './permission';
import { deriveDisplayTarget } from '../commandTarget';
import type { AgentDriverDefinition } from './registry';
import { createLineSplitter } from './jsonRpcPeer';
import { createSseParser } from './sseParser';

/**
 * opencode driver（ticket #22）：spawn `opencode serve --port 0 --hostname 127.0.0.1`，
 * REST（会话/消息）+ SSE（/event 事件流，手写 parser，不引依赖）。
 * 协议形状以本机 opencode 1.18.3 的 OpenAPI doc 与实测事件流为准：
 *
 *   起手：解析 stdout 监听行 `opencode server listening on http://127.0.0.1:<port>`
 *     → GET /event（SSE）→ POST /session → POST /session/{id}/prompt_async。
 *   SSE 事件 → 归一：
 *     message.part.delta {partID, delta}     → text_delta / thinking_delta
 *       （流式增量主源；part 类型按 partID 查表，reasoning → thinking）；
 *     message.part.updated {part}            → 无 delta 帧的 part 用累计文本 diff 兜底；
 *       part.type=tool → tool_call（running→done|error，幂等 upsert）；
 *     message.updated {info.role='assistant' 且 time.completed} → usage（§9：message.updated）；
 *       info.error → error（非致命）+ turn_end(failed)；
 *     permission.asked                       → permission_request →
 *       POST /permission/{id}/reply {reply: once|always|reject} → permission_response；
 *     session.idle                           → turn_end(completed)（本轮收尾）；
 *     session.error                          → error（非致命）+ turn_end(failed)。
 *   取消：POST /session/{id}/abort（尽力）+ 杀进程（权威）；exit 流程补 turn_end(cancelled)。
 *
 * 用户消息回声过滤：part.updated 里也有 user 角色的 text part——按 messageID 的
 * role 表过滤（role 未知先缓冲，role 落定后补发/丢弃；delta 帧只产生在 assistant
 * 生成内容上，直接放行）。
 *
 * 注入点（DriverStartParams）：executablePath（缺省 OPEN_COWORK_OPENCODE_CLI，
 * 再缺省 'opencode'）/ env（#21 provider 密钥）/ cwd / model（'provider/model' 形态
 * 拆成 {providerID, modelID} 随消息体发送）。
 * 约定同 claude/codex driver：session_ended 由宿主在 done 结算时补发，driver 不发。
 */

const LISTEN_LINE_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 2_000;
const HTTP_TIMEOUT_MS = 15_000;

/** opencode 工具名 → 极简行工具名（与 claude 系一致的大写惯例） */
function normalizeToolName(tool: string): string {
  switch (tool.toLowerCase()) {
    case 'bash':
      return 'Bash';
    case 'edit':
      return 'Edit';
    case 'write':
      return 'Write';
    case 'read':
      return 'Read';
    case 'glob':
      return 'Glob';
    case 'grep':
      return 'Grep';
    case 'webfetch':
      return 'WebFetch';
    case 'websearch':
      return 'WebSearch';
    case 'task':
      return 'Task';
    default:
      return tool;
  }
}

/**
 * 极简工具行的「目标」归纳（opencode 工具入参键名：filePath/command/pattern…）。
 * ticket #31：投影实现收口共享 normalizer（键名兼容在 normalizer 内）——
 * 本投影**仅展示用**；规则匹配经 resolvePermission 的 ruleMatchTarget 取完整命令文本。
 */
function deriveOpencodeTarget(tool: string, input: unknown): string | null {
  return deriveDisplayTarget(tool, input);
}

interface PartState {
  messageID: string;
  type: string;
  /** 累计文本（part.updated 全量） */
  text: string;
  /** 已发射的文本长度（diff 兜底用） */
  emittedLen: number;
  /** role 未知时缓冲的增量（role 落定后补发或丢弃） */
  pending: string[];
}

interface OpencodeState {
  child: ChildProcess;
  baseUrl: string | null;
  sessionId: string | null;
  turnActive: boolean;
  cancelled: boolean;
  /** messageID → role（user 回声过滤） */
  messageRoles: Map<string, string>;
  /** partID → 文本 part 状态 */
  parts: Map<string, PartState>;
  /** 已产生过 delta 帧的 partID（updated diff 跳过防双份） */
  deltaParts: Set<string>;
  /** 已发 usage 的 assistant messageID */
  usageEmittedFor: Set<string>;
  /** callID → 工具调用快照 */
  toolCalls: Map<string, NormalizedToolCall>;
  model: string | null;
  stderrTail: string;
}

function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }, KILL_GRACE_MS);
  child.once('exit', () => clearTimeout(timer));
}

/** fetch 带超时（fail-closed：HTTP 异常按错误事件处理，审批决议永不因网络放行） */
async function httpJson(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

class OpencodeDriverSession implements DriverSession {
  readonly done: Promise<{ reason: SessionEndReason; error?: string }>;
  private readonly state: OpencodeState;
  private alive = true;
  private sseDead = false;
  private sseAbort: AbortController | null = null;

  constructor(
    private readonly params: DriverStartParams,
    private readonly emit: (e: AgentEvent) => void,
  ) {
    const executable =
      params.executablePath ?? process.env.OPEN_COWORK_OPENCODE_CLI ?? 'opencode';
    const child = spawn(executable, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.state = {
      child,
      baseUrl: null,
      sessionId: null,
      turnActive: false,
      cancelled: false,
      messageRoles: new Map(),
      parts: new Map(),
      deltaParts: new Set(),
      usageEmittedFor: new Set(),
      toolCalls: new Map(),
      model: params.model ?? null,
      stderrTail: '',
    };

    let resolveDone!: (v: { reason: SessionEndReason; error?: string }) => void;
    this.done = new Promise((r) => {
      resolveDone = r;
    });

    child.stdout.setEncoding('utf8');
    let resolveListen!: (baseUrl: string) => void;
    let rejectListen!: (err: Error) => void;
    const listenLine = new Promise<string>((resolve, reject) => {
      resolveListen = resolve;
      rejectListen = reject;
    });
    const feed = createLineSplitter((line) => {
      const m = /opencode server listening on (https?:\/\/\S+)/.exec(line);
      if (m) resolveListen(m[1]);
    });
    child.stdout.on('data', (chunk: string) => feed(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.state.stderrTail = (this.state.stderrTail + chunk).slice(-2000);
      // 真实 serve 的日志走 stderr；监听行也兜底匹配一遍（版本差异防御）
      const m = /opencode server listening on (https?:\/\/\S+)/.exec(chunk);
      if (m) resolveListen(m[1]);
    });

    child.once('error', (err) => {
      this.alive = false;
      const message = `opencode 启动失败: ${err.message}`;
      emit({ type: 'error', message, fatal: true });
      emit({ type: 'turn_end', status: 'failed', reason: message });
      rejectListen(new Error(message));
      resolveDone({ reason: 'failed', error: message });
    });

    child.once('exit', (code, signal) => {
      this.alive = false;
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
          s.stderrTail.trim() || `opencode 进程退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        const message = `opencode 会话异常终止: ${detail}`;
        emit({ type: 'error', message, fatal: true });
        if (s.turnActive) {
          s.turnActive = false;
          emit({ type: 'turn_end', status: 'failed', reason: message });
        }
        rejectListen(new Error(message));
        resolveDone({ reason: 'failed', error: message });
        return;
      }
      resolveDone({ reason: 'completed' });
    });

    const listenTimeout = setTimeout(() => {
      rejectListen(new Error(`opencode serve 监听行超时（${LISTEN_LINE_TIMEOUT_MS}ms）`));
    }, LISTEN_LINE_TIMEOUT_MS);
    // finally 派生链会带 rejection——用 then(onFulfilled, onRejected) 形式避免未处理拒绝
    void listenLine.then(
      () => clearTimeout(listenTimeout),
      () => clearTimeout(listenTimeout),
    );

    void this.handshake(params, listenLine).catch((err: unknown) => {
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

  /** 监听行 → SSE 连接 → 建会话 → 首轮 prompt */
  private async handshake(params: DriverStartParams, listenLine: Promise<string>): Promise<void> {
    const s = this.state;
    s.baseUrl = await listenLine;
    this.connectSse(s.baseUrl);
    const created = await httpJson('POST', `${s.baseUrl}/session`, {});
    if (created.status !== 200 || typeof (created.json as { id?: unknown })?.id !== 'string') {
      throw new Error(`opencode 建会话失败 (HTTP ${created.status})`);
    }
    s.sessionId = (created.json as { id: string }).id;
    this.emit({
      type: 'session_started',
      sessionId: s.sessionId,
      model: s.model,
      cwd: params.cwd,
    });
    await this.postPrompt(params.prompt);
  }

  /** GET /event：SSE 长连（断流记非致命错误；轮次中则判失败——增量通道已不可信） */
  private connectSse(baseUrl: string): void {
    const controller = new AbortController();
    this.sseAbort = controller;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/event`, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`SSE 连接失败 (HTTP ${res.status})`);
        const parser = createSseParser((frame) => this.onSseFrame(frame.data));
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.end();
        if (this.alive) this.onSseDead('opencode SSE 事件流中断');
      } catch (err) {
        if (controller.signal.aborted) return;
        if (this.alive) this.onSseDead(`opencode SSE 异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  private onSseDead(message: string): void {
    if (this.sseDead) return;
    this.sseDead = true;
    this.emit({ type: 'error', message, fatal: false });
    const s = this.state;
    if (s.turnActive && !s.cancelled) {
      s.turnActive = false;
      this.emit({ type: 'turn_end', status: 'failed', reason: message });
    }
  }

  private async postPrompt(text: string): Promise<void> {
    const s = this.state;
    if (!s.baseUrl || !s.sessionId) throw new Error('opencode 会话尚未建立');
    const modelParam = parseModel(s.model);
    const res = await httpJson('POST', `${s.baseUrl}/session/${s.sessionId}/prompt_async`, {
      parts: [{ type: 'text', text }],
      ...(modelParam ? { model: modelParam } : {}),
    });
    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`opencode 发消息失败 (HTTP ${res.status})`);
    }
    s.turnActive = true;
  }

  // ── SSE 事件归一 ───────────────────────────────────────────────────────

  private onSseFrame(data: string): void {
    let event: { type?: unknown; properties?: Record<string, unknown> };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      this.emit({ type: 'error', message: `opencode SSE 帧解析失败: ${data.slice(0, 200)}`, fatal: false });
      return;
    }
    if (typeof event?.type !== 'string') return;
    const p = (event.properties ?? {}) as Record<string, unknown>;
    const s = this.state;
    // 只归一本会话的事件（serve 是项目级 server，可能有别的会话噪音）
    const sid = typeof p.sessionID === 'string' ? p.sessionID : null;
    const sessionScoped = new Set([
      'message.updated',
      'message.part.updated',
      'message.part.delta',
      'permission.asked',
      'session.idle',
      'session.error',
    ]);
    if (sessionScoped.has(event.type) && sid !== null && sid !== s.sessionId) return;

    switch (event.type) {
      case 'message.part.delta': {
        const partId = typeof p.partID === 'string' ? p.partID : null;
        const delta = typeof p.delta === 'string' ? p.delta : null;
        if (!partId || !delta) break;
        s.deltaParts.add(partId);
        const part = s.parts.get(partId);
        if (part) {
          part.text += delta;
          part.emittedLen = part.text.length;
        }
        // delta 帧只产生在 assistant 生成内容上（user 输入不流式）
        s.turnActive = true;
        if (part?.type === 'reasoning') this.emit({ type: 'thinking_delta', delta });
        else this.emit({ type: 'text_delta', delta });
        break;
      }

      case 'message.part.updated': {
        const part = p.part as Record<string, unknown> | undefined;
        if (!part || typeof part.id !== 'string') break;
        const partType = typeof part.type === 'string' ? part.type : '';
        if (partType === 'text' || partType === 'reasoning') {
          this.onTextPartUpdated(part.id as string, part, partType);
        } else if (partType === 'tool') {
          this.onToolPartUpdated(part);
        }
        break;
      }

      case 'message.updated': {
        const info = p.info as Record<string, unknown> | undefined;
        if (!info || typeof info.id !== 'string') break;
        const role = typeof info.role === 'string' ? info.role : null;
        if (role) {
          s.messageRoles.set(info.id, role);
          this.flushPendingParts(info.id);
        }
        if (role !== 'assistant') break;
        s.turnActive = true;
        const error = info.error as { data?: { message?: unknown }; message?: unknown } | undefined;
        if (error) {
          const message =
            typeof error.data?.message === 'string'
              ? error.data.message
              : typeof error.message === 'string'
                ? error.message
                : 'opencode 消息错误';
          this.emit({ type: 'error', message, fatal: false });
          if (s.turnActive) {
            s.turnActive = false;
            this.emit({ type: 'turn_end', status: 'failed', reason: message });
          }
          break;
        }
        const time = info.time as { completed?: unknown } | undefined;
        if (typeof time?.completed === 'number' && !s.usageEmittedFor.has(info.id)) {
          s.usageEmittedFor.add(info.id);
          const tokens = (info.tokens ?? {}) as Record<string, unknown>;
          const cache = (tokens.cache ?? {}) as Record<string, unknown>;
          this.emit({
            type: 'usage',
            usage: {
              inputTokens: typeof tokens.input === 'number' ? tokens.input : 0,
              outputTokens: typeof tokens.output === 'number' ? tokens.output : 0,
              cacheReadTokens: typeof cache.read === 'number' ? cache.read : 0,
              cacheWriteTokens: typeof cache.write === 'number' ? cache.write : 0,
              model: typeof info.modelID === 'string' ? info.modelID : s.model,
              raw: info,
            },
          });
        }
        break;
      }

      case 'permission.asked': {
        void this.onPermissionAsked(p);
        break;
      }

      case 'session.idle': {
        if (s.turnActive) {
          s.turnActive = false;
          this.emit({ type: 'turn_end', status: 'completed' });
        }
        break;
      }

      case 'session.error': {
        const error = p.error as { data?: { message?: unknown }; message?: unknown } | undefined;
        const message =
          typeof error?.data?.message === 'string'
            ? error.data.message
            : typeof error?.message === 'string'
              ? error.message
              : 'opencode 会话错误';
        this.emit({ type: 'error', message, fatal: false });
        if (s.turnActive) {
          s.turnActive = false;
          this.emit({ type: 'turn_end', status: 'failed', reason: message });
        }
        break;
      }

      default:
        // server.connected / session.status / permission.replied / session.diff 等不归一
        break;
    }
  }

  /** text/reasoning part.updated：delta 主源缺席时按累计文本 diff 兜底；user 回声过滤 */
  private onTextPartUpdated(
    partId: string,
    part: Record<string, unknown>,
    partType: string,
  ): void {
    const s = this.state;
    const messageID = typeof part.messageID === 'string' ? part.messageID : '';
    const text = typeof part.text === 'string' ? part.text : '';
    let st = s.parts.get(partId);
    if (!st) {
      st = { messageID, type: partType, text: '', emittedLen: 0, pending: [] };
      s.parts.set(partId, st);
    }
    if (s.deltaParts.has(partId)) return; // delta 帧已覆盖，updated 只做状态记录
    const delta = text.slice(st.emittedLen);
    st.text = text;
    if (delta.length === 0) return;
    const role = s.messageRoles.get(st.messageID);
    if (role === 'user') return; // 用户消息回声
    if (role === undefined) {
      st.pending.push(delta); // role 未知：缓冲待落定
      return;
    }
    st.emittedLen = text.length;
    s.turnActive = true;
    this.emit({ type: partType === 'reasoning' ? 'thinking_delta' : 'text_delta', delta });
  }

  /** role 落定（message.updated 到达）后补发/丢弃缓冲的 part 增量 */
  private flushPendingParts(messageID: string): void {
    const s = this.state;
    const role = s.messageRoles.get(messageID);
    for (const st of s.parts.values()) {
      if (st.messageID !== messageID || st.pending.length === 0) continue;
      const buffered = st.pending.join('');
      st.pending = [];
      if (role === 'user' || buffered.length === 0) continue;
      st.emittedLen = st.text.length;
      s.turnActive = true;
      this.emit({ type: st.type === 'reasoning' ? 'thinking_delta' : 'text_delta', delta: buffered });
    }
  }

  private onToolPartUpdated(part: Record<string, unknown>): void {
    const s = this.state;
    const callId = typeof part.callID === 'string' ? part.callID : null;
    if (!callId) return;
    const tool = typeof part.tool === 'string' ? part.tool : 'unknown';
    const state = (part.state ?? {}) as Record<string, unknown>;
    const status = typeof state.status === 'string' ? state.status : '';
    const prev = s.toolCalls.get(callId);
    const name = normalizeToolName(tool);
    const truncate = (v: string): string => (v.length > 2000 ? `${v.slice(0, 2000)}…` : v);

    if (status === 'pending' || status === 'running') {
      if (prev && prev.status === 'running') return; // 幂等：running 只发一次
      const call: NormalizedToolCall = {
        id: callId,
        name,
        target: deriveOpencodeTarget(tool, state.input),
        status: 'running',
        input: state.input ?? {},
      };
      s.toolCalls.set(callId, call);
      s.turnActive = true;
      this.emit({ type: 'tool_call', call });
      return;
    }
    if (status === 'completed' || status === 'error') {
      if (prev && prev.status !== 'running') return; // 幂等：终态只发一次
      const isError = status === 'error';
      const output =
        typeof state.output === 'string'
          ? state.output
          : typeof state.error === 'string'
            ? state.error
            : null;
      const call: NormalizedToolCall = {
        id: callId,
        name,
        target: prev?.target ?? deriveOpencodeTarget(tool, state.input),
        status: isError ? 'error' : 'done',
        input: prev?.input ?? state.input ?? {},
        output: output ? truncate(output) : null,
        ...(isError ? { error: output ? truncate(output) : 'tool error' } : {}),
      };
      s.toolCalls.set(callId, call);
      this.emit({ type: 'tool_call', call });
    }
  }

  /** permission.asked → 决议（fail-closed）→ POST /permission/{id}/reply */
  private async onPermissionAsked(p: Record<string, unknown>): Promise<void> {
    const s = this.state;
    const permissionId = typeof p.id === 'string' ? p.id : null;
    if (!permissionId || !s.baseUrl) return;
    const permission = typeof p.permission === 'string' ? p.permission : 'unknown';
    const patterns = Array.isArray(p.patterns) ? p.patterns.filter((x) => typeof x === 'string') : [];
    const metadata = p.metadata ?? {};
    const toolName = normalizeToolName(permission);
    const target =
      (patterns[0] as string | undefined) ?? deriveOpencodeTarget(permission, metadata);
    const request: PermissionRequestPayload = {
      id: `opencode_perm_${permissionId}`,
      toolName,
      target: target ?? null,
      // 真实协议无 reason（恒 null）；fake 会携带脚本的 reason 供 contract 回放
      reason: typeof p.reason === 'string' ? p.reason : null,
      options: ['allow_once', 'allow_always', 'deny'],
      input: metadata,
      suggestions: null,
    };
    s.turnActive = true;
    this.emit({ type: 'permission_request', request });
    const decision = await resolvePermission(this.params, request);
    this.emit({ type: 'permission_response', requestId: request.id, decision });

    const reply =
      decision.behavior === 'allow' ? (decision.always ? 'always' : 'once') : 'reject';
    try {
      const res = await httpJson('POST', `${s.baseUrl}/permission/${permissionId}/reply`, {
        reply,
        ...(decision.behavior === 'deny' && decision.message ? { message: decision.message } : {}),
      });
      if (res.status !== 200) {
        this.emit({
          type: 'error',
          message: `opencode 审批回执失败 (HTTP ${res.status})`,
          fatal: false,
        });
      }
    } catch (err) {
      // 决议已落定（事件流完整）；回执失败只记错误——agent 侧请求将悬挂至超时拒绝
      this.emit({
        type: 'error',
        message: `opencode 审批回执发送失败: ${err instanceof Error ? err.message : String(err)}`,
        fatal: false,
      });
    }
  }

  async sendFollowup(text: string): Promise<void> {
    if (!this.alive) throw new Error('会话已结束，无法追问');
    if (this.state.turnActive) throw new Error('上一轮尚未结束');
    await this.postPrompt(text);
  }

  async cancel(): Promise<void> {
    if (!this.alive) return; // 幂等
    this.state.cancelled = true;
    const s = this.state;
    if (s.baseUrl && s.sessionId && s.turnActive) {
      try {
        await httpJson('POST', `${s.baseUrl}/session/${s.sessionId}/abort`);
      } catch {
        // 进程已死/网络异常：忽略，kill 兜底
      }
    }
    try {
      this.sseAbort?.abort();
    } catch {
      // 忽略
    }
    killChild(s.child);
  }
}

/** 'provider/model' → {providerID, modelID}；无法解析（裸 model 名）则缺省 null 用 server 默认 */
function parseModel(model: string | null): { providerID: string; modelID: string } | null {
  if (!model) return null;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

class OpencodeDriver implements AgentDriver {
  readonly id = 'opencode';
  start(params: DriverStartParams, emit: (e: AgentEvent) => void): DriverSession {
    return new OpencodeDriverSession(params, emit);
  }
}

const definition: AgentDriverDefinition = {
  id: 'opencode',
  displayName: 'opencode',
  approval: 'native',
  create: () => new OpencodeDriver(),
};

export default definition;
