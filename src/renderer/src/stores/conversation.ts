import { create } from 'zustand';
import type { AgentEvent, NormalizedToolCall, PermissionDecision, PermissionRequestPayload } from '../../../agent/events';
import type { TaskHistory } from '../../../shared/api';

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
export type ConversationItem =
  | UserItem
  | TextItem
  | ThinkingItem
  | ToolItem
  | PermissionItem
  | ErrorItem;

export interface TaskConversation {
  sessionId: string | null;
  items: ConversationItem[];
  /** 一轮是否进行中（turn_end 前；输入区发送/取消键的依据之一） */
  turnActive: boolean;
}

const emptyConversation = (): TaskConversation => ({
  sessionId: null,
  items: [],
  turnActive: false,
});

interface ConversationState {
  byTask: Record<string, TaskConversation>;
  /** 历史基线整体替换（选中任务/重拉时） */
  applyHistory: (taskId: string, history: TaskHistory) => void;
  /** 实时事件应用（delta 走 rAF 合帧缓冲） */
  applyEvent: (taskId: string, event: AgentEvent) => void;
  /** 发送消息后的乐观用户条目（持久化侧由 main 落库） */
  appendUserMessage: (taskId: string, text: string) => void;
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
      const items: ConversationItem[] = [];
      // messages 与 tool_calls 共用 seq 计数器（迁移 003），按 seq 归并单时间线
      const merged = [
        ...history.messages.map((m) => ({ seq: m.seq, m })),
        ...history.toolCalls.map((t) => ({ seq: t.seq ?? Number.MAX_SAFE_INTEGER, t })),
      ].sort((a, b) => a.seq - b.seq);
      for (const entry of merged) {
        if ('m' in entry) {
          const { m } = entry;
          if (m.role === 'user') items.push({ kind: 'user', text: m.content });
          else if (m.role === 'assistant' && m.kind === 'thinking')
            items.push({ kind: 'thinking', text: m.content, streaming: false });
          else if (m.role === 'assistant')
            items.push({ kind: 'text', text: m.content, streaming: false });
        } else {
          const { t } = entry;
          items.push({
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
          [taskId]: { sessionId: null, items, turnActive: runningTurn },
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
  switch (event.type) {
    case 'session_started':
      return { ...c, sessionId: event.sessionId, turnActive: true };

    case 'tool_call': {
      const items = [...c.items];
      const idx = items.findIndex((it) => it.kind === 'tool' && it.call.id === event.call.id);
      if (idx >= 0) items[idx] = { kind: 'tool', call: event.call };
      else items.push({ kind: 'tool', call: event.call });
      return { ...c, items, turnActive: true };
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
      return { ...c, items: sealStreaming(c.items), turnActive: false };

    case 'error':
      if (!event.fatal) return c;
      return { ...c, items: [...sealStreaming(c.items), { kind: 'error', message: event.message }] };

    case 'session_ended':
      return { ...c, items: sealStreaming(c.items), turnActive: false };

    case 'usage':
    case 'text_delta':
    case 'thinking_delta':
      return c; // delta 走合帧缓冲；usage 本票不呈现（#27 消费）

    default:
      return c;
  }
}
