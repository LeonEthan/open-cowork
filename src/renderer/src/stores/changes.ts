import { create } from 'zustand';
import type { FileChange } from '../../../shared/api';

/**
 * 变更复查数据 store（ticket #24，独立领域 store——不动 stores/data.ts 共享文件）。
 * 数据真源在 main 进程 SQLite（file_changes 表）；本 store 只是桥 API 拉取的快照。
 * 刷新触发：changes tab 选中任务变化 + main 广播 tasks:changed（组件内订阅）。
 * 纯浏览器环境（无 preload 桥）下静默降级。
 */

interface ChangesState {
  /** taskId → 变更行（含 accepted/reverted 复查历史） */
  byTask: Record<string, FileChange[] | undefined>;
  /** 从 main 重拉某任务的变更列表 */
  refresh: (taskId: string) => Promise<void>;
}

export const useChangesStore = create<ChangesState>()((set) => ({
  byTask: {},

  refresh: async (taskId) => {
    const api = window.openCowork;
    if (!api) return;
    const list = await api.changes.list(taskId);
    set((s) => ({ byTask: { ...s.byTask, [taskId]: list } }));
  },
}));
