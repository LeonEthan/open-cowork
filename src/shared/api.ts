/**
 * preload 暴露给 renderer 的 API 形状（contextBridge）。
 * renderer 侧通过 window.openCowork 访问；类型声明见 src/renderer/src/env.d.ts。
 */
// ticket #18：DTO 复用十实体类型（entities.ts 为纯类型文件，type-only import 无运行时依赖）
import type { Task, TaskStatus, Workspace } from '../main/db/entities';

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
