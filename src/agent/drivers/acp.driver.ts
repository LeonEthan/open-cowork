import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentDriver,
  AgentEvent,
  DriverSession,
  DriverStartParams,
  NormalizedToolCall,
  PermissionOption,
  PermissionRequestPayload,
  SessionEndReason,
  TurnEndStatus,
} from '../events';
import { JsonRpcPeer, createLineSplitter } from './jsonRpcPeer';
import { resolvePermission } from './permission';
import type { AgentDriverDefinition } from './registry';

/**
 * 通用 ACP driver（ticket #26）：自定义 ACP agent 的统一接入。
 * 协议 = ACP（Agent Client Protocol，https://agentclientprotocol.com）stdio JSON-RPC 2.0：
 *
 *   client → agent：
 *     initialize {protocolVersion, clientCapabilities, clientInfo} → {agentInfo, authMethods, …}
 *     session/new {cwd, mcpServers: []} → {sessionId}
 *     session/prompt {sessionId, prompt: [{type:'text', text}]} → {stopReason}
 *       （响应在整轮 session/update 通知之后到达，是轮次结束的唯一权威信号）
 *     session/cancel {sessionId}（通知；对端应以 stopReason='cancelled' 答复在途 prompt）
 *   agent → client 通知 session/update：
 *     agent_message_chunk {content:{type:'text',text}}   → text_delta
 *     agent_thought_chunk {content}                       → thinking_delta
 *     tool_call / tool_call_update                        → tool_call 快照（幂等 upsert）
 *     usage_update {used, size, _meta?}                   → 暂存，prompt 响应时归一 usage
 *   agent → client 反向请求（原生审批，接 #20 中继链）：
 *     session/request_permission {toolCall, options[]} → {outcome: selected/cancelled}
 *     其余（fs/*、terminal/*、会话恢复等未声明能力的请求）一律回 JSON-RPC error——fail-closed（§10）。
 *
 * 实例化：自定义 agent（task.agent_type='custom:<dbId>'）经 registry.createCustomDriverDefinition
 * 携带注册 spec（command/args/env）创建；本文件默认导出的裸定义只为满足 drivers glob
 * （不可直接启动——缺 command/args，start 即明确报错）。
 * 约定同其他 driver：session_ended 由宿主在 done 结算时补发，driver 不发。
 */

const KILL_GRACE_MS = 2_000;
const CANCEL_GRACE_MS = 1_000;
const ACP_PROTOCOL_VERSION = 1;

/** 自定义 ACP agent 的注册 spec（DB 行在 main 侧解析后随 start 指令传入 utility） */
export interface AcpAgentSpec {
  /** driver 定义 id（'custom:<dbId>'，与 task.agent_type 对应） */
  id: string;
  displayName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// ── ACP → 归一化映射（纯函数，导出供单测） ──────────────────────────────────

/** ACP ToolCallKind → 归一工具名（审批规则匹配口径与内置四家一致：execute=Bash / edit=Edit…） */
export function mapAcpToolKind(kind: unknown): string {
  switch (kind) {
    case 'execute':
      return 'Bash';
    case 'edit':
      return 'Edit';
    case 'read':
      return 'Read';
    case 'search':
      return 'Grep';
    case 'fetch':
      return 'WebFetch';
    default:
      // delete/move/think/switch_mode/other/未知：保守归 'unknown'
      // （策略引擎 fail-closed：白名单外一律视为写/命令类）
      return 'unknown';
  }
}

/** ACP toolCall 形状 → 极简行目标（命令行 / 文件路径 / URL；无法归纳回退 title） */
export function deriveAcpTarget(toolCall: Record<string, unknown>): string | null {
  const kind = toolCall.kind;
  const rawInput = (toolCall.rawInput ?? {}) as Record<string, unknown>;
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  const firstPath = (locations[0] as { path?: unknown } | undefined)?.path;
  if (kind === 'execute') {
    if (typeof rawInput.command === 'string' && rawInput.command.length > 0) return rawInput.command;
  }
  if (kind === 'edit' || kind === 'read' || kind === 'delete' || kind === 'move') {
    if (typeof firstPath === 'string' && firstPath.length > 0) return firstPath;
    const p = rawInput.file_path ?? rawInput.path;
    if (typeof p === 'string' && p.length > 0) return p;
  }
  if (kind === 'fetch' && typeof rawInput.url === 'string' && rawInput.url.length > 0) {
    return rawInput.url;
  }
  return typeof toolCall.title === 'string' && toolCall.title.length > 0 ? toolCall.title : null;
}

interface AcpPermissionOption {
  optionId?: unknown;
  name?: unknown;
  kind?: unknown;
}

/**
 * 审批决议 → ACP outcome（纯函数）：
 * allow+always 优先 allow_always 选项；deny 优先 reject_once（无 reject 选项时回
 * outcome=cancelled——对端语义等同拒绝，fail-closed）。
 */
export function selectPermissionOutcome(
  decision: { behavior: 'allow' | 'deny'; always?: boolean },
  options: readonly AcpPermissionOption[],
): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const pick = (kinds: readonly string[]): string | null => {
    for (const k of kinds) {
      const hit = options.find((o) => o.kind === k && typeof o.optionId === 'string');
      if (hit) return hit.optionId as string;
    }
    return null;
  };
  if (decision.behavior === 'allow') {
    const id =
      decision.always === true
        ? (pick(['allow_always']) ?? pick(['allow_once']))
        : pick(['allow_once', 'allow_always']);
    if (id) return { outcome: { outcome: 'selected', optionId: id } };
    return { outcome: { outcome: 'cancelled' } };
  }
  const id = pick(['reject_once', 'reject_always']);
  if (id) return { outcome: { outcome: 'selected', optionId: id } };
  return { outcome: { outcome: 'cancelled' } };
}

/** ACP ToolCallStatus → 归一 ToolCallState */
function mapToolStatus(status: unknown): NormalizedToolCall['status'] {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'error';
  return 'running'; // pending / in_progress / 未知
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** 非标准 _meta 扩展（fake harness 与部分实现提供；标准 ACP 只有 used/size） */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 非标准 _meta 扩展；缺省回落会话 model */
  model?: string | null;
  raw: unknown;
}

interface AcpState {
  child: ChildProcess;
  peer: JsonRpcPeer;
  sessionId: string | null;
  turnActive: boolean;
  cancelled: boolean;
  toolCalls: Map<string, NormalizedToolCall>;
  lastUsage: TurnUsage | null;
  model: string | null;
  cwd: string;
  stderrTail: string;
}

function truncate(s: string): string {
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

/** tool_call 通知 → 归一快照（running 为主；通知自带 completed/failed 时尊重） */
function toolCallFromUpdate(update: Record<string, unknown>): NormalizedToolCall | null {
  const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
  if (!id) return null;
  return {
    id,
    name: mapAcpToolKind(update.kind),
    target: deriveAcpTarget(update),
    status: mapToolStatus(update.status),
    input: update.rawInput ?? null,
  };
}

/** tool_call_update → 归一快照（与先前快照合并；输出取 rawOutput / content 首段文本） */
function toolCallMerged(
  update: Record<string, unknown>,
  prev: NormalizedToolCall | undefined,
): NormalizedToolCall | null {
  const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
  if (!id) return null;
  const status = mapToolStatus(update.status);
  let output: string | null = null;
  if (typeof update.rawOutput === 'string') output = truncate(update.rawOutput);
  else if (update.rawOutput != null) output = truncate(JSON.stringify(update.rawOutput));
  if (!output && Array.isArray(update.content)) {
    const first = update.content[0] as { content?: { text?: unknown } } | undefined;
    const text = first?.content && typeof first.content.text === 'string' ? first.content.text : null;
    if (text) output = truncate(text);
  }
  const base: NormalizedToolCall = prev ?? {
    id,
    name: mapAcpToolKind(update.kind),
    target: deriveAcpTarget(update),
    status: 'running',
  };
  return {
    ...base,
    status,
    ...(output !== null
      ? { output, ...(status === 'error' ? { error: output } : {}) }
      : status === 'error'
        ? { error: 'tool call failed' }
        : {}),
  };
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

/** 带 spec 的 ACP driver 工厂（registry.createCustomDriverDefinition 的唯一实例化路径） */
export function createAcpDriver(spec: AcpAgentSpec): AgentDriver {
  return {
    id: spec.id,
    start: (params, emit) => new AcpDriverSession(spec, params, emit),
  };
}

class AcpDriverSession implements DriverSession {
  readonly done: Promise<{ reason: SessionEndReason; error?: string }>;
  /** ticket #30：自 spawn 的 ACP agent 子进程 pid（进程注册表二级清扫用） */
  readonly pid: number | undefined;
  private readonly state: AcpState;
  private alive = true;
  private resolveDone!: (v: { reason: SessionEndReason; error?: string }) => void;

  constructor(
    private readonly spec: AcpAgentSpec,
    private readonly params: DriverStartParams,
    private readonly emit: (e: AgentEvent) => void,
  ) {
    const child = spawn(spec.command, spec.args, {
      cwd: params.cwd,
      // 环境合并：进程 env < 注册 env（自定义表单）< 任务 env（#21 provider 注入）
      env: { ...process.env, ...(spec.env ?? {}), ...(params.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // spawn 失败（ENOENT 等）时 child.pid 为 undefined——保持缺省，二级清扫无 pid 可登记
    this.pid = child.pid;

    // ACP 严格 JSON-RPC 2.0：出站帧补 jsonrpc 字段（peer 只管分派与 id 配对）
    const peer = new JsonRpcPeer(
      (msg) => {
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(msg as object) })}\n`);
        } catch {
          // 进程已死：done 流程收尾
        }
      },
      {
        onNotification: (method, p) => this.onNotification(method, p),
        onServerRequest: (req) => this.onServerRequest(req),
        onParseError: (line) =>
          this.emit({
            type: 'error',
            message: `ACP 协议帧解析失败: ${line.slice(0, 200)}`,
            fatal: false,
          }),
      },
    );

    this.state = {
      child,
      peer,
      sessionId: null,
      turnActive: false,
      cancelled: false,
      toolCalls: new Map(),
      lastUsage: null,
      model: params.model ?? null,
      cwd: params.cwd,
      stderrTail: '',
    };

    this.done = new Promise((r) => {
      this.resolveDone = r;
    });

    child.stdout.setEncoding('utf8');
    const feed = createLineSplitter((line) => peer.feedLine(line));
    child.stdout.on('data', (chunk: string) => feed(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.state.stderrTail = (this.state.stderrTail + chunk).slice(-2000);
    });

    child.once('error', (err) => {
      // spawn 失败（ENOENT 等，如注册后命令被卸载）
      this.alive = false;
      const message = `${spec.displayName} 启动失败: ${err.message}`;
      emit({ type: 'error', message, fatal: true });
      emit({ type: 'turn_end', status: 'failed', reason: message });
      this.resolveDone({ reason: 'failed', error: message });
    });

    child.once('exit', (code, signal) => {
      this.alive = false;
      peer.destroy(new Error('ACP agent 进程已退出'));
      const s = this.state;
      if (s.cancelled) {
        this.settleTurn('cancelled');
        this.resolveDone({ reason: 'cancelled' });
        return;
      }
      if (s.turnActive || (code !== 0 && code !== null) || signal) {
        const detail =
          s.stderrTail.trim() || `进程退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        const message = `${spec.displayName} 会话异常终止: ${detail}`;
        emit({ type: 'error', message, fatal: true });
        this.settleTurn('failed', message);
        this.resolveDone({ reason: 'failed', error: message });
        return;
      }
      this.resolveDone({ reason: 'completed' });
    });

    void this.handshake(params).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (this.alive) {
        this.alive = false;
        emit({ type: 'error', message, fatal: true });
        emit({ type: 'turn_end', status: 'failed', reason: message });
        killChild(child);
        this.resolveDone({ reason: 'failed', error: message });
      }
    });
  }

  /** initialize → session/new → 首轮 session/prompt */
  private async handshake(params: DriverStartParams): Promise<void> {
    const s = this.state;
    const init = (await s.peer.call('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        // 不声明 fs/terminal 能力：文件与命令一律由 agent 自行执行 + 审批请求路由回本端
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'open-cowork', title: 'open-cowork', version: '0.1.0' },
    })) as { authMethods?: unknown; agentInfo?: { name?: unknown } } | undefined;
    if (Array.isArray(init?.authMethods) && init.authMethods.length > 0) {
      // authenticate 方法不在 MVP：agent 可能仍能跑（如环境密钥已就绪），仅提示
      this.emit({
        type: 'error',
        message: `${this.spec.displayName} 声明了 ${init.authMethods.length} 种认证方式（authenticate 未接入）——如遇认证失败请先在 agent 自有渠道登录`,
        fatal: false,
      });
    }
    const created = (await s.peer.call('session/new', {
      cwd: params.cwd,
      mcpServers: [],
    })) as { sessionId?: unknown };
    if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
      throw new Error('ACP session/new 未返回 sessionId');
    }
    s.sessionId = created.sessionId;
    this.emit({
      type: 'session_started',
      sessionId: created.sessionId,
      model: s.model,
      cwd: s.cwd,
    });
    await this.startTurn(params.prompt);
  }

  /**
   * 一轮 prompt：session/prompt 的响应在全部 session/update 之后到达，
   * 是轮次终态的唯一权威（stopReason → turn_end）。
   */
  private async startTurn(text: string): Promise<void> {
    const s = this.state;
    if (!s.sessionId) throw new Error('ACP 会话尚未建立');
    s.turnActive = true;
    s.lastUsage = null;
    try {
      const result = (await s.peer.call('session/prompt', {
        sessionId: s.sessionId,
        prompt: [{ type: 'text', text }],
      })) as { stopReason?: unknown } | undefined;
      if (!s.turnActive) return; // cancel 路径已结算
      const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn';
      this.emitUsage();
      if (stopReason === 'cancelled') this.settleTurn('cancelled');
      else if (stopReason === 'end_turn') this.settleTurn('completed');
      else this.settleTurn('failed', `${this.spec.displayName} 停止（${stopReason}）`);
    } catch (err) {
      if (!s.turnActive) return; // 传输死亡/cancel 已由 exit 路径结算
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', message, fatal: false });
      this.settleTurn('failed', message);
    }
  }

  /** 轮次结算（幂等——cancel/kill/响应三路竞速只算一次） */
  private settleTurn(status: TurnEndStatus, reason?: string): void {
    const s = this.state;
    if (!s.turnActive) return;
    s.turnActive = false;
    this.emit({ type: 'turn_end', status, ...(reason ? { reason } : {}) });
  }

  private emitUsage(): void {
    const s = this.state;
    const u = s.lastUsage;
    this.emit({
      type: 'usage',
      usage: {
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
        cacheReadTokens: u?.cacheReadTokens ?? 0,
        cacheWriteTokens: u?.cacheWriteTokens ?? 0,
        model: u?.model ?? s.model,
        raw: u?.raw ?? null,
      },
    });
  }

  // ── agent → client 通知归一 ─────────────────────────────────────────────

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return; // 其余通知（协议外/扩展）不归一
    const s = this.state;
    const p = (params ?? {}) as Record<string, unknown>;
    const update = (p.update ?? {}) as Record<string, unknown>;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = update.content as { type?: unknown; text?: unknown } | undefined;
        if (content?.type === 'text' && typeof content.text === 'string' && content.text.length > 0) {
          s.turnActive = true;
          this.emit({ type: 'text_delta', delta: content.text });
        }
        break;
      }
      case 'agent_thought_chunk': {
        const content = update.content as { type?: unknown; text?: unknown } | undefined;
        if (content?.type === 'text' && typeof content.text === 'string' && content.text.length > 0) {
          s.turnActive = true;
          this.emit({ type: 'thinking_delta', delta: content.text });
        }
        break;
      }
      case 'tool_call': {
        const call = toolCallFromUpdate(update);
        if (call) {
          s.turnActive = true;
          s.toolCalls.set(call.id, call);
          this.emit({ type: 'tool_call', call });
        }
        break;
      }
      case 'tool_call_update': {
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
        const prev = id ? s.toolCalls.get(id) : undefined;
        const call = toolCallMerged(update, prev);
        if (call) {
          s.toolCalls.set(call.id, call);
          this.emit({ type: 'tool_call', call });
        }
        break;
      }
      case 'usage_update': {
        // ACP 只有 used/size/cost（上下文水位，非 input/output 分账）；
        // 兼容非标准 _meta.inputTokens/outputTokens（fake harness 与部分实现提供）
        const meta = (update._meta ?? {}) as Record<string, unknown>;
        s.lastUsage = {
          inputTokens:
            typeof meta.inputTokens === 'number'
              ? meta.inputTokens
              : typeof update.used === 'number'
                ? update.used
                : 0,
          outputTokens: typeof meta.outputTokens === 'number' ? meta.outputTokens : 0,
          // 非标准扩展续：缓存分账与轮次 model（缺省不落字段，emit 时回落 0 / 会话 model）
          ...(typeof meta.cacheReadTokens === 'number'
            ? { cacheReadTokens: meta.cacheReadTokens }
            : {}),
          ...(typeof meta.cacheWriteTokens === 'number'
            ? { cacheWriteTokens: meta.cacheWriteTokens }
            : {}),
          ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
          raw: update,
        };
        break;
      }
      default:
        // plan / user_message_chunk / available_commands_update / current_mode_update / 未知扩展：忽略
        break;
    }
  }

  // ── agent → client 反向请求（原生审批；其余一律 fail-closed 抛错） ─────────

  private async onServerRequest(req: {
    id: string | number;
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    if (req.method !== 'session/request_permission') {
      throw new Error(`open-cowork 未接入的 ACP 请求: ${req.method}（fail-closed）`);
    }
    const p = (req.params ?? {}) as Record<string, unknown>;
    const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
    const options = Array.isArray(p.options) ? (p.options as AcpPermissionOption[]) : [];
    // 非标准 _meta.reason 宽容读取（ACP 本体无 reason 字段；fake harness 与部分实现经此透传）
    const meta = (p._meta ?? {}) as Record<string, unknown>;
    const reason = typeof meta.reason === 'string' && meta.reason.length > 0 ? meta.reason : null;

    const granted: PermissionOption[] = [];
    if (options.some((o) => o.kind === 'allow_once')) granted.push('allow_once');
    if (options.some((o) => o.kind === 'allow_always')) granted.push('allow_always');
    // 拒绝永远可选（fail-closed 兜底——即使 agent 只给放行选项）
    granted.push('deny');

    const request: PermissionRequestPayload = {
      id: `acp_perm_${String(req.id)}_${randomUUID().slice(0, 8)}`,
      toolName: mapAcpToolKind(toolCall.kind),
      target: deriveAcpTarget(toolCall),
      reason,
      options: granted,
      input: toolCall.rawInput ?? null,
      suggestions: null,
    };
    this.emit({ type: 'permission_request', request });
    const decision = await resolvePermission(this.params, request);
    this.emit({ type: 'permission_response', requestId: request.id, decision });
    return selectPermissionOutcome(decision, options);
  }

  async sendFollowup(text: string): Promise<void> {
    if (!this.alive) throw new Error('会话已结束，无法追问');
    if (this.state.turnActive) throw new Error('上一轮尚未结束');
    await this.startTurn(text);
  }

  async cancel(): Promise<void> {
    if (!this.alive) return; // 幂等
    this.state.cancelled = true;
    const s = this.state;
    if (s.sessionId && s.turnActive) {
      // 先礼后兵：session/cancel 通知（对端应以 stopReason='cancelled' 答复在途 prompt），
      // 宽限后杀进程（权威路径）；exit 流程补 turn_end(cancelled)
      try {
        s.peer.notify('session/cancel', { sessionId: s.sessionId });
      } catch {
        // 传输已死：直接杀
      }
      await new Promise((r) => setTimeout(r, CANCEL_GRACE_MS));
    }
    killChild(s.child);
  }
}

/** 裸定义的占位 driver：缺 command/args 无法启动——明确报错（fail-closed） */
function createUnconfiguredAcpDriver(): AgentDriver {
  return {
    id: 'acp',
    start: (_params, emit) => {
      const message =
        '通用 ACP driver 缺少自定义 agent spec——自定义 agent 一律经注册表单创建（设置 → Agent 管理）';
      emit({ type: 'error', message, fatal: true });
      emit({ type: 'turn_end', status: 'failed', reason: message });
      return {
        sendFollowup: () => Promise.reject(new Error(message)),
        cancel: () => Promise.resolve(),
        done: Promise.resolve({ reason: 'failed' as SessionEndReason, error: message }),
      };
    },
  };
}

/**
 * 通用 ACP driver 的「裸」定义（无 spec）：drivers glob 自动收集需要合法默认导出。
 * 不可直接启动（picker 永不列出 'acp'）；自定义 agent 经
 * registry.createCustomDriverDefinition(spec) 实例化（ticket #26）。
 */
const definition: AgentDriverDefinition = {
  id: 'acp',
  displayName: '自定义 ACP agent',
  approval: 'native',
  create: () => createUnconfiguredAcpDriver(),
};

export default definition;
