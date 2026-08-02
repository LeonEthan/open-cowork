import { create } from 'zustand';
import type { AgentEvent, NormalizedToolCall, PermissionDecision, PermissionRequestPayload } from '../../../agent/events';
import type { TaskHistory, UsageRecord } from '../../../shared/api';

/**
 * 会话文档流的渲染态 store（ticket #19）。
 *
 * 数据源两条（最终一致）：
 * - 历史基线：选中任务时从 main 重拉（agent:history）→ applyHistory 整体替换；
 * - 实时增量：utility 经 MessageChannel 直连的归一事件 → applyEvent 逐项应用。
 *
 * 高频 text_delta/thinking_delta 做 rAF 合帧：delta 先进缓冲，
 * 每帧至多一次 set()（高频流下 UI 不卡，票面要求）。
 */

// ── 时间线条目 ───────────────────────────────────────────────────────────

export interface UserItem {
  kind: 'user';
  text: string;
}
export interface TextItem {
  kind: 'text';
  text: string;
  /** 仍在流式追加中（呈现流式光标） */
  streaming: boolean;
}
export interface ThinkingItem {
  kind: 'thinking';
  text: string;
  streaming: boolean;
}
export interface ToolItem {
  kind: 'tool';
  call: NormalizedToolCall;
}
export interface PermissionItem {
  kind: 'permission';
  request: PermissionRequestPayload;
  decision: PermissionDecision | null;
}
export interface ErrorItem {
  kind: 'error';
  message: string;
}
/**
 * ticket #27：每轮末尾的用量灰字条目。
 * live 事件先落地（pending=true 只显 token）；turn_end 后 usage store 拉记录
 * reconcile 补上折算金额与口径（pending=false）。
 */
export interface UsageItem {
  kind: 'usage';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    model: string | null;
    costUsd: number | null;
    pricingSource: 'models.dev' | 'subscription' | null;
    pending: boolean;
  };
}
export type ConversationItem =
  | UserItem
  | TextItem
  | ThinkingItem
  | ToolItem
  | PermissionItem
  | ErrorItem
  | UsageItem;

export interface TaskConversation {
  sessionId: string | null;
  items: ConversationItem[];
  /** 一轮是否进行中（turn_end 前；输入区发送/取消键的依据之一） */
  turnActive: boolean;
  /** Codex 对齐（附录 B）：历史轮次元数据（started_at/ended_at 降序无，按 idx 升序）——工作摘要行时长数据源 */
  turns: Array<{ id: string; idx: number; status: string; startedAt: number; endedAt: number | null }>;
  /** Codex 对齐（附录 B，瞬态）：live 轮次计时锚点——turnActive false→true 记录开始，turn_end/session_ended 记录结束 */
  turnStartedAt: number | null;
  turnEndedAt: number | null;
}

const emptyConversation = (): TaskConversation => ({
  sessionId: null,
  items: [],
  turnActive: false,
  turns: [],
  turnStartedAt: null,
  turnEndedAt: null,
});

interface ConversationState {
  byTask: Record<string, TaskConversation>;
  /** 历史基线整体替换（选中任务/重拉时） */
  applyHistory: (taskId: string, history: TaskHistory) => void;
  /** 实时事件应用（delta 走 rAF 合帧缓冲） */
  applyEvent: (taskId: string, event: AgentEvent) => void;
  /** 发送消息后的乐观用户条目（持久化侧由 main 落库） */
  appendUserMessage: (taskId: string, text: string) => void;
  /**
   * ticket #27：turn_end 后 usage store 拉到落库记录，把时间线里 pending 的
   * 用量条目按序配对替换为含折算口径的记录（记录不足时多余条目保持 pending）。
   */
  reconcileUsage: (taskId: string, records: UsageRecord[]) => void;
  /** 清理已删除任务的渲染态 */
  prune: (existingTaskIds: Set<string>) => void;
}

/** delta 合帧缓冲（per task：text/thinking 各一份，追加到对应流式条目） */
const deltaBuffers = new Map<string, { text: string; thinking: string }>();
let rafScheduled = false;

export const useConversationStore = create<ConversationState>()((set, get) => {
  const updateTask = (taskId: string, fn: (c: TaskConversation) => TaskConversation): void => {
    set((s) => ({
      byTask: { ...s.byTask, [taskId]: fn(s.byTask[taskId] ?? emptyConversation()) },
    }));
  };

  /** 非 delta 事件：先把缓冲 delta 冲刷进条目，再应用本事件（保序） */
  const flushDeltas = (taskId: string): void => {
    const buf = deltaBuffers.get(taskId);
    if (!buf || (buf.text.length === 0 && buf.thinking.length === 0)) return;
    const { text, thinking } = buf;
    deltaBuffers.set(taskId, { text: '', thinking: '' });
    updateTask(taskId, (c) => {
      const items = [...c.items];
      if (text) appendStreamText(items, 'text', text);
      if (thinking) appendStreamText(items, 'thinking', thinking);
      return { ...c, items };
    });
  };

  const scheduleFlush = (): void => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      for (const taskId of [...deltaBuffers.keys()]) flushDeltas(taskId);
    });
  };

  return {
    byTask: {},

    applyHistory: (taskId, history) => {
      deltaBuffers.set(taskId, { text: '', thinking: '' });
      // messages 与 tool_calls 共用 seq 计数器（迁移 003），按 seq 归并单时间线；
      // ticket #27：按 turn 分组——每轮条目之后插该轮的用量灰字（usage_records.turn_id 对齐）
      const merged = [
        ...history.messages.map((m) => ({ seq: m.seq, m })),
        ...history.toolCalls.map((t) => ({ seq: t.seq ?? Number.MAX_SAFE_INTEGER, t })),
      ].sort((a, b) => a.seq - b.seq);
      const itemsByTurn = new Map<string | null, ConversationItem[]>();
      const pushItem = (turnId: string | null, item: ConversationItem): void => {
        const list = itemsByTurn.get(turnId) ?? [];
        list.push(item);
        itemsByTurn.set(turnId, list);
      };
      for (const entry of merged) {
        if ('m' in entry) {
          const { m } = entry;
          if (m.role === 'user') pushItem(m.turn_id, { kind: 'user', text: m.content });
          else if (m.role === 'assistant' && m.kind === 'thinking')
            pushItem(m.turn_id, { kind: 'thinking', text: m.content, streaming: false });
          else if (m.role === 'assistant')
            pushItem(m.turn_id, { kind: 'text', text: m.content, streaming: false });
        } else {
          const { t } = entry;
          pushItem(t.turn_id, {
            kind: 'tool',
            call: {
              id: t.id,
              name: t.name,
              target: t.target,
              status:
                t.status === 'success' ? 'done' : t.status === 'error' || t.status === 'denied' ? 'error' : 'running',
            },
          });
        }
      }
      const usageByTurn = new Map<string | null, UsageRecord[]>();
      for (const r of history.usageRecords ?? []) {
        const list = usageByTurn.get(r.turn_id) ?? [];
        list.push(r);
        usageByTurn.set(r.turn_id, list);
      }
      const items: ConversationItem[] = [];
      for (const turn of history.turns) {
        items.push(...(itemsByTurn.get(turn.id) ?? []));
        itemsByTurn.delete(turn.id);
        for (const r of usageByTurn.get(turn.id) ?? []) {
          items.push({ kind: 'usage', usage: usageItemFromRecord(r) });
          usageByTurn.delete(turn.id);
        }
      }
      // turn_id 为 NULL 的残留（如 turn 已关后迟到的记录）依次挂到时间线尾部
      items.push(...(itemsByTurn.get(null) ?? []));
      for (const r of usageByTurn.get(null) ?? []) {
        items.push({ kind: 'usage', usage: usageItemFromRecord(r) });
      }
      const runningTurn = history.turns.some((t) => t.status === 'running');
      // ticket #20：仍 pending 的审批行补到时间线尾部——重连/重启后审批托盘的渲染基线
      // （已决议的审批不进历史呈现；request_json 即 PermissionRequestPayload 原样快照）
      for (const a of history.approvals ?? []) {
        try {
          const request = JSON.parse(a.request_json) as PermissionRequestPayload;
          if (request && typeof request.id === 'string') {
            items.push({ kind: 'permission', request, decision: null });
          }
        } catch {
          // 坏行跳过（不阻塞整段历史渲染）
        }
      }
      set((s) => ({
        byTask: {
          ...s.byTask,
          [taskId]: {
            sessionId: null,
            items,
            turnActive: runningTurn,
            // 附录 B：轮次元数据随历史基线落 store（工作摘要行时长）
            turns: history.turns.map((t) => ({
              id: t.id,
              idx: t.idx,
              status: t.status,
              startedAt: t.started_at,
              endedAt: t.ended_at,
            })),
            // 历史基线接管后 live 计时锚点重置（运行中轮次以落库 started_at 为准）
            turnStartedAt: null,
            turnEndedAt: null,
          },
        },
      }));
    },

    applyEvent: (taskId, event) => {
      switch (event.type) {
        case 'text_delta':
        case 'thinking_delta': {
          const buf = deltaBuffers.get(taskId) ?? { text: '', thinking: '' };
          if (event.type === 'text_delta') buf.text += event.delta;
          else buf.thinking += event.delta;
          deltaBuffers.set(taskId, buf);
          scheduleFlush();
          return;
        }
        default:
          break;
      }
      flushDeltas(taskId);
      updateTask(taskId, (c) => applyNonDeltaEvent(c, event));
    },

    appendUserMessage: (taskId, text) => {
      flushDeltas(taskId);
      updateTask(taskId, (c) => ({ ...c, items: [...c.items, { kind: 'user', text }] }));
    },

    reconcileUsage: (taskId, records) => {
      flushDeltas(taskId);
      updateTask(taskId, (c) => {
        const pendingIdx = c.items
          .map((it, i) => (it.kind === 'usage' && it.usage.pending ? i : -1))
          .filter((i) => i >= 0);
        if (pendingIdx.length === 0) return c;
        // 按序配对最后 N 条落库记录（recorded_at 升序由 main 保证）
        const tail = records.slice(-pendingIdx.length);
        const items = [...c.items];
        pendingIdx.forEach((itemIdx, k) => {
          const rec = tail[k];
          if (!rec) return; // 记录尚未落库（竞态）：保持 pending，下轮 reconcile 再补
          items[itemIdx] = { kind: 'usage', usage: usageItemFromRecord(rec) };
        });
        return { ...c, items };
      });
    },

    prune: (existingTaskIds) => {
      set((s) => {
        const next: typeof s.byTask = {};
        for (const [id, conv] of Object.entries(s.byTask)) {
          if (existingTaskIds.has(id)) next[id] = conv;
        }
        return { byTask: next };
      });
      for (const id of [...deltaBuffers.keys()]) {
        if (!existingTaskIds.has(id)) deltaBuffers.delete(id);
      }
    },
  };
});

/** 流式追加：末尾是同种 streaming 条目则续写，否则开新条目 */
function appendStreamText(items: ConversationItem[], kind: 'text' | 'thinking', delta: string): void {
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    items[items.length - 1] = { ...last, text: last.text + delta };
  } else {
    items.push({ kind, text: delta, streaming: true } as ConversationItem);
  }
}

/** 把进行中的流式条目封口（turn_end/边界事件时） */
function sealStreaming(items: ConversationItem[]): ConversationItem[] {
  return items.map((it) =>
    (it.kind === 'text' || it.kind === 'thinking') && it.streaming ? { ...it, streaming: false } : it,
  );
}

function applyNonDeltaEvent(c: TaskConversation, event: AgentEvent): TaskConversation {
  // 附录 B：live 轮次计时锚点——false→true 记录开始；结束事件记录结束
  const beginTurn = (next: TaskConversation): TaskConversation =>
    c.turnActive ? next : { ...next, turnStartedAt: Date.now(), turnEndedAt: null };
  const endTurn = (next: TaskConversation): TaskConversation =>
    c.turnActive ? { ...next, turnEndedAt: Date.now() } : next;
  switch (event.type) {
    case 'session_started':
      return beginTurn({ ...c, sessionId: event.sessionId, turnActive: true });

    case 'tool_call': {
      const items = [...c.items];
      const idx = items.findIndex((it) => it.kind === 'tool' && it.call.id === event.call.id);
      if (idx >= 0) items[idx] = { kind: 'tool', call: event.call };
      else items.push({ kind: 'tool', call: event.call });
      return beginTurn({ ...c, items, turnActive: true });
    }

    case 'permission_request': {
      const items = [...c.items, { kind: 'permission' as const, request: event.request, decision: null }];
      return { ...c, items };
    }

    case 'permission_response': {
      const items = [...c.items];
      const idx = items.findIndex((it) => it.kind === 'permission' && it.request.id === event.requestId);
      if (idx >= 0) {
        const it = items[idx] as PermissionItem;
        items[idx] = { ...it, decision: event.decision };
      }
      return { ...c, items };
    }

    case 'turn_end':
      return endTurn({ ...c, items: sealStreaming(c.items), turnActive: false });

    case 'usage':
      // ticket #27：本轮末尾的用量灰字（pending——turn_end 后 reconcile 补折算口径）
      return {
        ...c,
        items: [
          ...c.items,
          {
            kind: 'usage',
            usage: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheReadTokens: event.usage.cacheReadTokens ?? 0,
              cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
              model: event.usage.model ?? null,
              costUsd: null,
              pricingSource: null,
              pending: true,
            },
          },
        ],
      };

    case 'error':
      if (!event.fatal) return c;
      return { ...c, items: [...sealStreaming(c.items), { kind: 'error', message: event.message }] };

    case 'session_ended':
      return endTurn({ ...c, items: sealStreaming(c.items), turnActive: false });

    case 'text_delta':
    case 'thinking_delta':
      return c; // delta 走合帧缓冲

    default:
      return c;
  }
}

/** ticket #27：落库记录 → 时间线用量条目（含折算口径，pending=false） */
function usageItemFromRecord(r: UsageRecord): UsageItem['usage'] {
  return {
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    model: r.model,
    costUsd: r.cost_usd,
    pricingSource: r.pricing_source,
    pending: false,
  };
}
