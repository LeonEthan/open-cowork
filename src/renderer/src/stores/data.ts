import { create } from 'zustand';
import type { CreateTaskInput, Task, TaskListItem, Workspace } from '../../../shared/api';
import { useAppStore } from './appStore';
import { useConversationStore } from './conversation';

/**
 * workspace 与任务的本地数据 store（ticket #18）。
 * 数据真源在 main 进程 SQLite——本 store 只是桥 API 拉取的快照 + 变更动作；
 * 任何变更后统一 refreshAll() 重新拉取，避免双写不一致。
 * 纯浏览器环境（无 preload 桥）下所有动作静默降级为空操作。
 */

interface DataState {
  workspaces: Workspace[];
  tasks: TaskListItem[];
  /** 首次拉取是否完成（区分「加载中」与「真空」） */
  loaded: boolean;
  /** 最近一次桥调用错误（创建/迁移失败时展示），成功即清空 */
  lastError: string | null;

  refreshAll: () => Promise<void>;
  addWorkspaceViaDialog: () => Promise<void>;
  addWorkspaceByPath: (dirPath: string) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;
  /** 创建任务；成功后刷新并选中该任务，返回创建的任务（失败返回 null 并记 lastError） */
  createTask: (input: CreateTaskInput) => Promise<Task | null>;
}

function errMessage(e: unknown): string {
  // Electron IPC 包装的错误形如 "Error invoking remote method 'x': Error: <原始消息>"
  const msg = e instanceof Error ? e.message : String(e);
  const idx = msg.lastIndexOf('Error: ');
  return idx >= 0 ? msg.slice(idx + 'Error: '.length) : msg;
}

export const useDataStore = create<DataState>()((set, get) => ({
  workspaces: [],
  tasks: [],
  loaded: false,
  lastError: null,

  refreshAll: async () => {
    const api = window.openCowork;
    if (!api) return;
    const [workspaces, tasks] = await Promise.all([api.workspaces.list(), api.tasks.list()]);
    set({ workspaces, tasks, loaded: true });
    // 选中任务已消失（如所属 workspace 被移除）时清空选择态
    const { currentTaskId, setCurrentTaskId } = useAppStore.getState();
    if (currentTaskId && !tasks.some((t) => t.id === currentTaskId)) {
      setCurrentTaskId(null);
    }
    // 会话渲染态同步修剪（任务被删后不留孤儿时间线）
    useConversationStore.getState().prune(new Set(tasks.map((t) => t.id)));
  },

  addWorkspaceViaDialog: async () => {
    const api = window.openCowork;
    if (!api) return;
    try {
      await api.workspaces.pickAndAdd(); // 取消返回 null，同样刷新（幂等）
      set({ lastError: null });
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
    await get().refreshAll();
  },

  addWorkspaceByPath: async (dirPath) => {
    const api = window.openCowork;
    if (!api) return;
    try {
      await api.workspaces.addByPath(dirPath);
      set({ lastError: null });
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
    await get().refreshAll();
  },

  removeWorkspace: async (id) => {
    const api = window.openCowork;
    if (!api) return;
    try {
      await api.workspaces.remove(id);
      set({ lastError: null });
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
    await get().refreshAll();
  },

  createTask: async (input) => {
    const api = window.openCowork;
    if (!api) return null;
    try {
      const task = await api.tasks.create(input);
      set({ lastError: null });
      await get().refreshAll();
      useAppStore.getState().setCurrentTaskId(task.id);
      return task;
    } catch (e) {
      set({ lastError: errMessage(e) });
      return null;
    }
  },
}));
