/**
 * preload 暴露给 renderer 的 API 形状（contextBridge）。
 * renderer 侧通过 window.openCowork 访问；类型声明见 src/renderer/src/env.d.ts。
 */
// ticket #18：DTO 复用十实体类型（entities.ts 为纯类型文件，type-only import 无运行时依赖）
import type { Message, Task, TaskStatus, ToolCall, Turn, Workspace } from '../main/db/entities';

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

  // ── ticket #24：diff 复查与回滚 ───────────────────────────────────────
  /** 检查栏「变更」tab：变更列表 + 文件级/任务级接受回滚与恢复 */
  changes: ChangesApi;
  // ── ticket #24 end ────────────────────────────────────────────────────
}

// ── ticket #18：workspace 与任务管理（本地状态） ──────────────
export type { Task, TaskStatus, Workspace };

/** 侧栏/文档流列表项：Task + 所属 workspace 名（元信息展示用） */
export type TaskListItem = Task & { workspace_name: string };

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
