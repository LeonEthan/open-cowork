/**
 * preload 暴露给 renderer 的 API 形状（contextBridge）。
 * renderer 侧通过 window.openCowork 访问；类型声明见 src/renderer/src/env.d.ts。
 */
// ticket #18：DTO 复用十实体类型（entities.ts 为纯类型文件，type-only import 无运行时依赖）
import type { Message, Task, TaskStatus, ToolCall, Turn, Workspace } from '../main/db/entities';
// ticket #20（additive 独立行，避免与他票改同一 import）：审批托盘重连基线的 Approval 实体
import type { Approval } from '../main/db/entities';

export interface OpenCoworkApi {
  /** 请求建立 renderer ⇄ utility 的 MessageChannel 直连；port 经 window 'message' 事件送达 */
  requestAgentPort: () => void;
  /** 应用数据根目录（OPEN_COWORK_DATA_DIR 覆盖后的实际值） */
  getDataDir: () => Promise<string>;
  platform: string;
  versions: { electron: string; chrome: string; node: string };

  // ── ticket #18：workspace 与任务管理（本地状态） ──────────────
  workspaces: WorkspaceApi;
  tasks: TaskApi;
  /** 任务行变更推送（main 广播 tasks:changed）；返回取消订阅函数 */
  onTasksChanged: (cb: () => void) => () => void;

  // ── ticket #19：agent 会话控制与历史 ─────────────────────────
  agent: AgentApi;

  // ── ticket #28: 内置终端 tab ─────────────────────────────────────────
  /** 创建（或复用）per-task 终端会话；key=taskId 或 'global'；懒启动——首次调用才起 shell */
  ptyCreate: (
    key: string,
    cols: number,
    rows: number,
  ) => Promise<{ ok: boolean; cwd: string; created: boolean }>;
  ptyWrite: (key: string, data: string) => void;
  ptyResize: (key: string, cols: number, rows: number) => void;
  ptyDispose: (key: string) => void;
  /** 订阅会话输出 / 退出；均返回取消订阅函数 */
  onPtyData: (key: string, cb: (data: string) => void) => () => void;
  onPtyExit: (key: string, cb: (exitCode: number) => void) => () => void;
  // ── ticket #28 end ────────────────────────────────────────────────────

  // ── ticket #22：agent 探测（picker 数据源；#26 完整卡片） ─────────────
  agents: AgentDetectApi;
  // ── ticket #22 end ────────────────────────────────────────────────────

  // ── ticket #21：provider 与凭证（任意 provider 自由配置） ──────────────
  providers: ProvidersApi;
  // ── ticket #21 end ──────────────────────────────────────────────────────

  // ── ticket #20：权限审批流（审批托盘决议 + per-task 档位切换） ──────────
  approvals: ApprovalApi;
  // ── ticket #20 end ────────────────────────────────────────────────────

  // ── ticket #24：diff 复查与回滚 ───────────────────────────────────────
  /** 检查栏「变更」tab：变更列表 + 文件级/任务级接受回滚与恢复 */
  changes: ChangesApi;
  // ── ticket #24 end ────────────────────────────────────────────────────
}

// ── ticket #18：workspace 与任务管理（本地状态） ──────────────
export type { Task, TaskStatus, Workspace };

/** 侧栏/文档流列表项：Task + 所属 workspace 名 + provider 名（元信息展示用） */
export type TaskListItem = Task & { workspace_name: string; provider_name: string | null };

export interface CreateTaskInput {
  workspaceId: string;
  /** 需求描述 */
  prompt: string;
  title?: string;
  /** claude-code / codex / opencode / pi / custom:<id> */
  agentType: string;
  providerId?: string | null;
  model?: string | null;
}

export interface WorkspaceApi {
  list: () => Promise<Workspace[]>;
  /** 原生目录选择 dialog；用户取消时 resolve null */
  pickAndAdd: () => Promise<Workspace | null>;
  /** 直给路径添加（e2e/自动化用；dialog 路径之外的补充） */
  addByPath: (dirPath: string) => Promise<Workspace>;
  /** 移除 workspace（级联删除其任务） */
  remove: (id: string) => Promise<void>;
}

export interface TaskApi {
  list: () => Promise<TaskListItem[]>;
  /** 创建任务，入库即 ready */
  create: (input: CreateTaskInput) => Promise<Task>;
  /** 状态迁移；非法迁移 reject（状态机见 src/main/db/taskStateMachine.ts） */
  updateStatus: (id: string, status: TaskStatus) => Promise<Task>;
}

// ── ticket #19：agent 会话控制与历史 ─────────────────────────

/** 历史重拉返回（渲染基线；实时端口负责增量） */
export interface TaskHistory {
  turns: Turn[];
  messages: Message[];
  toolCalls: ToolCall[];
  /** ticket #20（additive）：仍 pending 的审批行——重连/重启后恢复审批托盘的渲染基线 */
  approvals: Approval[];
}

export interface AgentApi {
  /** 启动首轮（ready → running）；非法状态 reject */
  start: (taskId: string) => Promise<{ ok: true }>;
  /** 追问（awaiting_review → running）；非法状态 reject */
  followup: (taskId: string, text: string) => Promise<{ ok: true }>;
  /** 取消（活跃态 → cancelled；utility 侧终止 agent 进程） */
  cancel: (taskId: string) => Promise<{ ok: true }>;
  /** 历史重拉（turns + messages + toolCalls，按 seq/idx 升序） */
  history: (taskId: string) => Promise<TaskHistory>;
}

// ── ticket #22：agent 探测（picker 数据源；#26 完整卡片） ─────────────

/** 单家 agent 的探测结果（main services/agentDetect.ts 产出） */
export interface DetectedAgent {
  /** 'claude-code' | 'codex' | 'opencode' | 'pi'（与 task.agent_type 对应） */
  id: string;
  displayName: string;
  /** 可执行名（PATH 探测目标） */
  executable: string;
  /** 已安装（env 覆盖命中或 PATH 探测命中） */
  installed: boolean;
  /** 探测到的可执行路径（env 覆盖优先）；未安装为 null */
  resolvedPath: string | null;
  /** driver 是否已接入（pi 属 #23，未接入前 picker 标「即将支持」） */
  driverAvailable: boolean;
}

export interface AgentDetectApi {
  /** 探测结果（main 侧带缓存，首调实测） */
  list: () => Promise<DetectedAgent[]>;
  /** 强制重测（手动刷新） */
  refresh: () => Promise<DetectedAgent[]>;
}
// ── ticket #22 end ────────────────────────────────────────────────────

// ── ticket #21：provider 与凭证（任意 provider 自由配置） ──────────────────

/** 内置预设目录条目（六家；静态数据） */
export interface ProviderPresetInfo {
  id: string;
  name: string;
  /** 默认线协议（anthropic 兼容 / openai 兼容） */
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  /** 双协议端点（有则给出） */
  endpoints: { anthropic?: string; openai?: string };
  /** 静态兜底模型清单 */
  models: string[];
  modelsDevId: string;
}

/** provider 列表 DTO（密钥只给固定掩码；密文/明文不出 main 进程） */
export interface ProviderListItem {
  id: string;
  name: string;
  kind: 'preset' | 'custom';
  protocol: string;
  base_url: string;
  preset_id: string | null;
  has_key: boolean;
  key_masked: string;
  models_fetched_at: number | null;
  created_at: number;
}

/** 模型清单条目（models.dev 元数据：上下文长度 / 价格 USD·1M tokens；无记录为 null） */
export interface ProviderModelInfo {
  id: string;
  contextLength: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
}

export interface AddPresetProviderInput {
  presetId: string;
  apiKey: string;
  /** 显示名覆盖（缺省用预设名） */
  name?: string;
  /** 协议覆盖（预设具备对应端点时可用；缺省用预设默认） */
  protocol?: 'anthropic' | 'openai';
}

export interface AddCustomProviderInput {
  name: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  /** 密钥 env 名覆盖（缺省按协议约定：ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY） */
  keyEnv?: string;
  /** base URL env 名覆盖（缺省：ANTHROPIC_BASE_URL / OPENAI_BASE_URL） */
  baseUrlEnv?: string;
}

export interface ProvidersApi {
  /** 内置预设目录 */
  presets: () => Promise<ProviderPresetInfo[]>;
  list: () => Promise<ProviderListItem[]>;
  /** 预设一键添加（密钥经 safeStorage 加密落库） */
  addPreset: (input: AddPresetProviderInput) => Promise<ProviderListItem>;
  /** 自定义 provider（base URL + 协议 + 密钥） */
  addCustom: (input: AddCustomProviderInput) => Promise<ProviderListItem>;
  /** 移除（引用它的任务 provider_id/model 快照同事务清空） */
  remove: (id: string) => Promise<{ ok: true }>;
  /** 模型清单（缓存 → 预设静态兜底；无网络） */
  models: (id: string) => Promise<ProviderModelInfo[]>;
  /** 刷新清单：/models 拉取 × models.dev 元数据归并后缓存；远端失败 reject（UI 保留既有清单） */
  refreshModels: (id: string) => Promise<ProviderModelInfo[]>;
}
// ── ticket #21 end ──────────────────────────────────────────────────────────

// ── ticket #20：权限审批流 ─────────────────────────────

/** per-task 权限档位（与 main/db/entities.ts PermissionMode 同形；本地重定义保持 shared 零运行时依赖） */
export type PermissionMode = 'readonly' | 'auto' | 'full';

/** 托盘决议回传载荷（与 agent/events.ts PermissionDecision 同形，decision 由 main 校验） */
export interface PermissionDecisionInput {
  behavior: 'allow' | 'deny';
  /** allow 且 always=true → 记忆「总是允许」规则（工具 + 目标模式） */
  always?: boolean;
  /** deny 时附给 agent 的理由 */
  message?: string;
}

export interface ApprovalApi {
  /**
   * 托盘决议回传（IPC agent:permission-respond；幂等——
   * settled=false 表示请求已结清/陌生，双击/重连补发安全）
   */
  respond: (
    taskId: string,
    requestId: string,
    decision: PermissionDecisionInput,
  ) => Promise<{ ok: true; settled: boolean }>;
  /** 三档权限 per-task 循环切换（持久化 tasks.permission_mode；任何状态可切） */
  setPermissionMode: (taskId: string, mode: PermissionMode) => Promise<Task>;
}
// ── ticket #20 end ─────────────────────────────────────

// ── ticket #24：diff 复查与回滚 ─────────────────────────────────────────
// 独立 import 行（additive，不改文件顶部既有 import——并行票据零冲突合并约定）
import type { FileChange } from '../main/db/entities';
export type { FileChange };

export interface ChangesApi {
  /** 任务的变更列表（含 accepted/reverted 复查历史，按创建序） */
  list: (taskId: string) => Promise<FileChange[]>;
  /** 文件级接受（pending → accepted；不改工作区） */
  accept: (changeId: string) => Promise<{ ok: true }>;
  /** 文件级回滚（备份 → 还原基准 → reverted） */
  rollback: (changeId: string) => Promise<{ ok: true }>;
  /** 恢复：已回滚改动拷回工作区（reverted → pending）；快照期内（含 done 后）可用 */
  restore: (changeId: string) => Promise<{ ok: true }>;
  /** 任务级整体接受：全部 pending → accepted，任务 awaiting_review → done */
  acceptAll: (taskId: string) => Promise<{ ok: true }>;
  /** 任务级整体回滚：逐文件回滚全部 pending，完成后 awaiting_review → done */
  rollbackAll: (taskId: string) => Promise<{ ok: true }>;
}
// ── ticket #24 end ──────────────────────────────────────────────────────
