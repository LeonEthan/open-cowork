import { create } from 'zustand';
import type { AgentEvent } from '../../../agent/events';
import type { UsageContextInfo, UsageTaskTotals } from '../../../shared/api';
import { useConversationStore } from './conversation';

/**
 * 用量渲染态 store（ticket #27）：
 * - totals：侧栏任务 chip 的聚合（usage:totals，任务变更广播/turn_end 后重拉）；
 * - context：水位环分母与基线已占（usage:context，选中任务时拉取）；
 * - liveUsed：实时 usage 事件驱动的本轮已占（input + cacheRead），覆盖基线；
 * - turn_end 后拉 usage:list → conversation store reconcile，给 pending 灰字补折算口径。
 *
 * 纯浏览器环境（无 preload 桥）下所有动作静默降级为空操作。
 */

interface UsageState {
  /** taskId → 聚合（侧栏 chip） */
  totals: Record<string, UsageTaskTotals>;
  /** taskId → 水位环分母/来源/基线已占 */
  context: Record<string, UsageContextInfo>;
  /** taskId → 实时 usage 事件的最新已占（优先于 context.usedTokens 展示） */
  liveUsed: Record<string, number>;

  refreshTotals: () => Promise<void>;
  loadContext: (taskId: string) => Promise<void>;
  /** 实时事件钩子（useAgentPort 与 conversation store 并列调用） */
  applyEvent: (taskId: string, event: AgentEvent) => void;
  /** 修剪已删除任务的渲染态 */
  prune: (existingTaskIds: Set<string>) => void;
}

export const useUsageStore = create<UsageState>()((set, get) => ({
  totals: {},
  context: {},
  liveUsed: {},

  refreshTotals: async () => {
    const api = window.openCowork;
    if (!api) return;
    const rows = await api.usage.totals();
    const totals: Record<string, UsageTaskTotals> = {};
    for (const r of rows) totals[r.taskId] = r;
    set({ totals });
  },

  loadContext: async (taskId) => {
    const api = window.openCowork;
    if (!api) return;
    const info = await api.usage.context(taskId);
    set((s) => ({
      context: { ...s.context, [taskId]: info },
      // 基线已占刷新后清掉实时覆盖（同义；防历史任务残留旧值盖过新基线）
      liveUsed: { ...s.liveUsed, [taskId]: info.usedTokens },
    }));
  },

  applyEvent: (taskId, event) => {
    if (event.type === 'usage') {
      const used = event.usage.inputTokens + (event.usage.cacheReadTokens ?? 0);
      set((s) => ({ liveUsed: { ...s.liveUsed, [taskId]: used } }));
      return;
    }
    if (event.type === 'turn_end') {
      // 轮次结束：用量已落库（含折算）——拉记录 reconcile 灰字 + 刷新 chip 聚合
      const api = window.openCowork;
      if (!api) return;
      void api.usage
        .list(taskId)
        .then((records) => useConversationStore.getState().reconcileUsage(taskId, records))
        .catch(() => {
          // 拉取失败：灰字保持 pending（只显 token），不阻塞时间线
        });
      void get()
        .refreshTotals()
        .catch(() => {});
    }
  },

  prune: (existingTaskIds) => {
    set((s) => {
      const pick = <T>(m: Record<string, T>): Record<string, T> => {
        const next: Record<string, T> = {};
        for (const [id, v] of Object.entries(m)) if (existingTaskIds.has(id)) next[id] = v;
        return next;
      };
      return { totals: pick(s.totals), context: pick(s.context), liveUsed: pick(s.liveUsed) };
    });
  },
}));
