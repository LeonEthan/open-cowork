import { create } from 'zustand';

/**
 * 应用级共享状态——任务选择态契约（ticket #18 ⇄ #28 共享，编排者附注 3）。
 *
 * 本文件权威所有者是 #18（workspace/任务管理）；#28 完成时它尚未合入，
 * 故先落同名同形同字段的最小版本，merge gate 会以 #18 版为准合并。
 * 下游（终端 cwd 跟随等）只依赖这两个字段，请勿在此扩展 #18 的领域状态。
 */
interface AppState {
  /** 当前选中任务 id；null = 未选中 */
  currentTaskId: string | null;
  setCurrentTaskId: (id: string | null) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  currentTaskId: null,
  setCurrentTaskId: (currentTaskId) => set({ currentTaskId }),
}));
