import { create } from 'zustand';
import type { DetectedAgent } from '../../../shared/api';

/**
 * agent 探测结果 store（ticket #22，picker 数据源；独立域 store，不动 stores/data.ts）。
 * 真源在 main（services/agentDetect.ts，带缓存）；本 store 只是快照 + 动作。
 * 纯浏览器环境（无 preload 桥）下静默降级为空列表。
 */

interface AgentsState {
  agents: DetectedAgent[];
  /** 首次拉取是否完成（区分「探测中」与「真空」） */
  loaded: boolean;
  /** 拉取缓存结果（首调触发 main 实测） */
  load: () => Promise<void>;
  /** 强制重测（手动刷新） */
  reprobe: () => Promise<void>;
}

export const useAgentsStore = create<AgentsState>()((set) => ({
  agents: [],
  loaded: false,

  load: async () => {
    const api = window.openCowork;
    if (!api) return;
    const agents = await api.agents.list();
    set({ agents, loaded: true });
  },

  reprobe: async () => {
    const api = window.openCowork;
    if (!api) return;
    const agents = await api.agents.refresh();
    set({ agents, loaded: true });
  },
}));
