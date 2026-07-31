/**
 * 适配层事件模型与 AgentDriver 接口（ticket #19，全适配层唯一权威来源）。
 *
 * 语义对齐 ACP（Agent Client Protocol，ARCHITECTURE §2）：每家 agent driver 把自家
 * wire 格式归一为本文件的 AgentEvent 流；utility 进程宿主（index.ts）只做转发与持久化分派，
 * 不认识任何 agent 的私有协议。
 *
 * ── 下游票据消费点索引（改本文件 = 改它们的法律）──
 * - #20 审批流：PermissionRequestPayload / PermissionDecision / PermissionOption /
 *   AlwaysAllowRule（「总是允许」规则形状）/ DriverStartParams.permissionHandler
 *   ——本票的「全部允许」桩由 #20 的真实审批托盘链路替换；fail-closed 语义不得改动。
 * - #21 provider 配置：DriverStartParams.env ——provider 密钥经环境变量注入子进程
 *   （ARCHITECTURE §3 不碰全局配置），model 已有 task.model 快照注入。
 * - #22 codex + opencode driver：实现 AgentDriver 接口，把 codex JSON-RPC /
 *   opencode SSE 归一为同一组 AgentEvent；注册进 drivers/registry.ts。
 * - #23 pi driver：同上（--mode rpc；审批为降级静态策略，ApprovalCapability='degraded'）。
 * - #24 diff 复查：turn_end 后任务入 awaiting_review 是检查栏的触发点。
 * - #27 用量：UsageEvent → UsageRecord 落库（main 侧持久化已在本票接通）。
 */

// ── 事件本体 ─────────────────────────────────────────────────────────────

/** 工具调用状态（极简工具行：icon + 名称 + 目标 + 状态，DESIGN.md §4） */
export type ToolCallState = 'running' | 'done' | 'error';

/** 归一化工具调用：driver 在工具开始与每次状态变化时重发完整快照（幂等 upsert 语义） */
export interface NormalizedToolCall {
  /** agent 侧工具调用 id（claude = tool_use block id） */
  id: string;
  /** 工具名（Bash / Edit / Write / …） */
  name: string;
  /** 作用目标（文件路径 / 命令行首行），极简行展示用；无法归纳时 null */
  target: string | null;
  status: ToolCallState;
  /** 原始入参（JSONL 旁路 / 排障 / #20 审批详情用；UI 极简行不渲染） */
  input?: unknown;
  /** 完成时的输出摘要（截断由 driver 决定） */
  output?: string | null;
  /** status='error' 时的原因 */
  error?: string | null;
}

/** 审批可选项（#20 审批托盘逐条聚焦：⌘1 批准一次 / ⌘2 总是允许 / ⌘3 拒绝） */
export type PermissionOption = 'allow_once' | 'allow_always' | 'deny';

/**
 * 审批请求载荷（#20 审批托盘直接消费这个形状——不得破坏字段语义）。
 * driver 在 agent 发起权限请求时发出 permission_request 事件携带本载荷，
 * 同时（若 driver 支持原生审批）等待 permissionHandler 的决议回执。
 */
export interface PermissionRequestPayload {
  /** 请求 id（driver 内唯一，回执与规则匹配的依据） */
  id: string;
  /** 工具名（Bash / Edit / …） */
  toolName: string;
  /** 作用目标（命令行 / 文件路径），规则匹配与托盘展示用 */
  target: string | null;
  /** agent 给出的理由（如 sandbox 拦截说明）；无则 null */
  reason: string | null;
  /** 托盘可提供的选项（降级 driver 可能只给 allow_once/deny） */
  options: PermissionOption[];
  /** 原始工具入参（回执 updatedInput 的基线；托盘详情展开用） */
  input: unknown;
  /**
   * agent 原生权限建议原样透传（claude = permission_suggestions，
   * 「总是允许」规则可回写 agent 侧，ARCHITECTURE §6）；无则 null。
   */
  suggestions?: unknown;
}

/**
 * 审批决议（permissionHandler 的返回；宿主在决议后同步发 permission_response 事件，
 * 供 UI 即时呈现与 main 落 Approval 行）。
 * fail-closed 红线（ARCHITECTURE §10）：handler 抛错或超时一律视为 deny。
 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  /** allow 且 always=true：宿主应记忆「总是允许」规则（#20 持久化，本票仅透传） */
  always?: boolean;
  /** deny 时给 agent 的理由（拒绝可附理由，PRD §4.2） */
  message?: string;
}

/**
 * 「总是允许」规则形状（ARCHITECTURE §6：工具 + 目标模式，如 `Bash: npm *`）。
 * #20 负责持久化与匹配执行；本票只定义形状与匹配器（driver 预过滤用）。
 */
export interface AlwaysAllowRule {
  /** 工具名精确匹配（大小写敏感，与 agent 原生工具名一致） */
  tool: string;
  /** 目标模式：仅支持 `*` 通配（任意长度任意字符），其余字符字面匹配 */
  targetPattern: string;
}

/** 目标是否命中规则（`*` 通配；target 为 null 时仅匹配模式同为空/`'*'` 的规则） */
export function matchesAlwaysAllowRule(
  rule: AlwaysAllowRule,
  toolName: string,
  target: string | null,
): boolean {
  if (rule.tool !== toolName) return false;
  const t = target ?? '';
  const p = rule.targetPattern;
  if (p === '*') return true;
  if (!p.includes('*')) return t === p;
  const parts = p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 's').test(t);
}

/**
 * 用量事件（ARCHITECTURE §9：claude `result` / codex `turn.completed` /
 * opencode `message.updated` / pi `turn_end` 归一而来）。#27 落 UsageRecord。
 */
export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string | null;
  /** 原始来源载荷（排障/折算溯源用，driver 原样挂上） */
  raw?: unknown;
}

/** 轮次结束状态（Turn 实体的终态映射来源） */
export type TurnEndStatus = 'completed' | 'failed' | 'cancelled';

/** 会话结束原因（session_ended 事件与 DriverSession.done 共用） */
export type SessionEndReason = 'completed' | 'cancelled' | 'failed';

/**
 * 适配层统一事件流（utility → renderer 实时渲染 + utility → main 持久化，同一份）。
 * 所有事件都发生在某个 task 的会话上下文内，路由层负责补 taskId。
 *
 * 发射责任（全 driver 约定）：
 * - driver 发：session_started / text_delta / thinking_delta / tool_call /
 *   permission_request / permission_response（回给 agent 后补发）/ usage / turn_end / error；
 * - 宿主发：session_ended——由 DriverSession.done 结算而来，单一事实源防双发。
 */
export type AgentEvent =
  /** 会话建立：agent 握手完成、拿到原生 session id */
  | { type: 'session_started'; sessionId: string; model: string | null; cwd: string }
  /** 会话终结（含异常）；之后不再有任何事件。宿主按 done 结算补发 */
  | { type: 'session_ended'; reason: SessionEndReason; error?: string }
  /** assistant 正文流式增量（markdown 原文，高频——渲染端做 rAF 合帧） */
  | { type: 'text_delta'; delta: string }
  /** 思考过程流式增量（DESIGN.md §4：左边线 + 折叠呈现） */
  | { type: 'thinking_delta'; delta: string }
  /** 工具调用快照（开始/完成/出错各发一次，幂等 upsert） */
  | { type: 'tool_call'; call: NormalizedToolCall }
  /** 审批请求（#20 托盘消费；本票由全允许桩即时应答） */
  | { type: 'permission_request'; request: PermissionRequestPayload }
  /** 审批决议回执（宿主在应答 driver 后补发，UI/持久化消费） */
  | { type: 'permission_response'; requestId: string; decision: PermissionDecision }
  /** 用量（#27 消费点） */
  | { type: 'usage'; usage: UsageEvent }
  /** 一轮对话结束（claude = result 消息）：任务 running→awaiting_review 的触发点 */
  | { type: 'turn_end'; status: TurnEndStatus; reason?: string }
  /** 非致命/致命错误（fatal=true 时宿主随后会补 session_ended） */
  | { type: 'error'; message: string; fatal: boolean };

// ── driver 接口 ──────────────────────────────────────────────────────────

/** 审批钩子：driver 收到 agent 权限请求时调用；缺省由宿主注入「全部允许」桩（#20 替换） */
export type PermissionHandler = (req: PermissionRequestPayload) => Promise<PermissionDecision>;

export interface DriverStartParams {
  /** 任务 id（Task 与 agent session 1:1，PRD §6） */
  taskId: string;
  /** 首轮需求文本 */
  prompt: string;
  /** 工作目录（worktree_path ?? workspace.path，main 侧解析后传入） */
  cwd: string;
  /** task.model 快照；null/缺省 → driver 用 agent 默认 model */
  model?: string | null;
  /**
   * 注入子进程的环境变量（#21 provider 密钥注入点，ARCHITECTURE §3）；
   * 与进程 env 合并（本参数优先）。密钥不出本机、不写全局配置。
   */
  env?: Record<string, string>;
  /**
   * agent CLI 可执行路径覆盖（e2e/排障用；claude driver 缺省读
   * OPEN_COWORK_CLAUDE_CLI，再缺省用 SDK 自带解析）。
   */
  executablePath?: string | null;
  /** 原生 session id 恢复（后续票据的会话恢复用；本票不实现） */
  resumeSessionId?: string | null;
  /** 审批钩子；缺省 = fail-closed 的全允许桩（异常/超时一律 deny，见 index.ts） */
  permissionHandler?: PermissionHandler;
  /** 已记忆的「总是允许」规则（#20 注入；driver 在调 handler 前先行匹配放行） */
  alwaysAllowRules?: AlwaysAllowRule[];
  /** 审批等待超时（毫秒，超时=deny，fail-closed）；默认 120_000 */
  permissionTimeoutMs?: number;
}

/** 会话句柄：宿主用它追问与取消 */
export interface DriverSession {
  /** 追问（同一会话内开启新一轮）；会话已结束时应 reject */
  sendFollowup(text: string): Promise<void>;
  /** 取消：终止当前轮次并杀掉底层进程（幂等） */
  cancel(): Promise<void>;
  /** 会话终结 promise（与 session_ended 事件同源，二选一消费） */
  readonly done: Promise<{ reason: SessionEndReason; error?: string }>;
}

/**
 * Agent driver 统一接口（每家 agent 一个实现，drivers/<name>.driver.ts）。
 * emit 线程安全假设：driver 串行发事件（同一会话内事件有序）。
 */
export interface AgentDriver {
  /** 稳定标识（'claude-code' / 'codex' / 'opencode' / 'pi' / …），与 task.agent_type 对应 */
  readonly id: string;
  start(params: DriverStartParams, emit: (event: AgentEvent) => void): DriverSession;
}
