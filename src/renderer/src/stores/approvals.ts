import { create } from 'zustand';
import type { PermissionDecisionInput } from '../../../shared/api';
import type { ConversationItem, PermissionItem } from './conversation';

/**
 * 审批托盘 store（ticket #20）。
 *
 * 数据真源不在本 store：待审批队列派生自 conversation store 的 PermissionItem
 * 时间线（decision===null 者），事件流（utility 直连）与历史重拉（main
 * approvals 表）两条路最终一致——本 store 不复制请求本体。
 *
 * 本 store 只持有：
 * - 托盘瞬态 UI（拒绝理由展开态）；
 * - settling 集合（决议已回传、等 permission_response 回执落时间线的窗口期
 *   防重复决议——main 侧 respond 本身幂等，这是 UI 层的第二道防双击）；
 * - 决议回传动作（IPC agent:permission-respond）。
 */

/** 待审批队列（到达序 = 时间线序；逐条聚焦取 [0]，其余为排队预览） */
export function selectPending(
  items: readonly ConversationItem[],
  settling: ReadonlySet<string>,
): PermissionItem[] {
  return items.filter(
    (it): it is PermissionItem =>
      it.kind === 'permission' && it.decision === null && !settling.has(it.request.id),
  );
}

interface ApprovalsState {
  /** 决议已回传、等回执的请求 id（窗口期从待审批队列隐藏，防重复决议） */
  settling: ReadonlySet<string>;
  /** 拒绝理由输入展开中的请求 id（⌘3 进入；返回/确认后归 null） */
  denyOpenFor: string | null;
  /** 最近一次决议回传错误（托盘内联呈现），成功即清空 */
  lastError: string | null;

  /** 决议回传（幂等；main 侧已结清/陌生请求 settled:false 不抛错） */
  respond: (taskId: string, requestId: string, decision: PermissionDecisionInput) => Promise<void>;
  openDeny: (requestId: string) => void;
  closeDeny: () => void;
}

function errMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const idx = msg.lastIndexOf('Error: ');
  return idx >= 0 ? msg.slice(idx + 'Error: '.length) : msg;
}

export const useApprovalsStore = create<ApprovalsState>()((set, get) => ({
  settling: new Set<string>(),
  denyOpenFor: null,
  lastError: null,

  respond: async (taskId, requestId, decision) => {
    const api = window.openCowork;
    if (!api) return;
    // 进 settling：立即从队列隐藏（⌘1/2/3 连打安全）
    set((s) => ({ settling: new Set(s.settling).add(requestId), lastError: null }));
    try {
      await api.approvals.respond(taskId, requestId, decision);
      set((s) => (s.denyOpenFor === requestId ? { denyOpenFor: null } : {}));
    } catch (e) {
      // 回传失败：移出 settling 让请求重新可决议（fail-closed 不藏请求）
      set((s) => {
        const next = new Set(s.settling);
        next.delete(requestId);
        return { settling: next, lastError: errMessage(e) };
      });
    }
  },

  openDeny: (requestId) => set({ denyOpenFor: requestId }),
  closeDeny: () => set({ denyOpenFor: null }),
}));
