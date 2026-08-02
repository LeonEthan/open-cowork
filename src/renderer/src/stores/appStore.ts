import { create } from 'zustand';

/**
 * 应用级选择态（ticket #18 创建并维护）。
 *
 * ⚠️ 跨票据契约：本文件与并行的 #28 共享——
 * #28 只 import useAppStore 使用 currentTaskId / setCurrentTaskId，
 * 字段名与签名不得改动（新增字段 additive 允许）。
 */
interface AppState {
  /** 当前选中任务；null = 未选中（文档流保持空态） */
  currentTaskId: string | null;
  /** Codex 对齐改造（附录 B，additive）：当前选中 workspace——侧栏 workspace 行选中态与首页 hero 跟随 */
  currentWorkspaceId: string | null;
  setCurrentTaskId: (id: string | null) => void;
  setCurrentWorkspaceId: (id: string | null) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  currentTaskId: null,
  currentWorkspaceId: null,
  setCurrentTaskId: (currentTaskId) => set({ currentTaskId }),
  setCurrentWorkspaceId: (currentWorkspaceId) => set({ currentWorkspaceId }),
}));
