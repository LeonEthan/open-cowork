import { create } from 'zustand';
import type { WorktreeStatus } from '../../../shared/api';

/**
 * worktree 状态 store（ticket #25，独立领域 store——不动 stores/data.ts 共享文件）。
 * 数据真源在 main 进程（tasks.worktree_path/base_sha + 原仓 HEAD 探测）；
 * 本 store 只是桥 API 拉取的快照。刷新触发：检查栏 worktree 区块挂载 +
 * main 广播 tasks:changed（组件内订阅）。纯浏览器环境下静默降级。
 */

interface WorktreeState {
  /** taskId → worktree 状态（路径/分支/base/HEAD/漂移） */
  byTask: Record<string, WorktreeStatus | undefined>;
  refresh: (taskId: string) => Promise<void>;
}

export const useWorktreeStore = create<WorktreeState>()((set) => ({
  byTask: {},

  refresh: async (taskId) => {
    const api = window.openCowork;
    if (!api) return;
    const status = await api.worktree.status(taskId);
    set((s) => ({ byTask: { ...s.byTask, [taskId]: status } }));
  },
}));
