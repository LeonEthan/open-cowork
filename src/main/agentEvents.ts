import * as approvalRepo from './db/approvalRepo';
import * as conversationRepo from './db/conversationRepo';
import * as taskRepo from './db/taskRepo';
import type { Database } from './db/database';
import type { TaskStatus } from './db/entities';
import { canTransition } from './db/taskStateMachine';
import type { AgentEvent } from '../agent/events';

/**
 * main 侧 agent 事件分派（ticket #19）：utility → main 的归一事件流在此
 * 落库（Turn/Message/ToolCall/Approval/UsageRecord）并驱动任务状态机迁移。
 *
 * 与渲染通道的关系：同一份事件另经 MessageChannel 直连 renderer 做实时渲染；
 * 本文件只关心持久化与状态——renderer 重拉历史 + 实时增量两条路最终一致。
 *
 * 幂等设计（取消/异常路径上多个终止事件可能先后到达）：
 * - 状态迁移前检查 canTransition，非法即跳过（不抛错——事件流是异步的）；
 * - closeTurn / upsertToolCall / insertApproval 均幂等。
 */

export interface AgentEventDispatchContext {
  db: Database;
  /** 任务行变更后通知 renderer 重拉（tasks:changed） */
  broadcastTasksChanged: () => void;
}

/**
 * 两级清理的持久化侧（ARCHITECTURE §7 可恢复）：把「进行中」状态的任务标 failed。
 * 调用时机：app 启动（上次异常退出残留）与 utility 进程崩溃时。
 * 迁移仍经 taskRepo.updateStatus（状态机把关）；伴随关闭其 running Turn。
 */
export function recoverInterruptedTasks(db: Database, reason: string): number {
  const rows = db
    .prepare("SELECT id FROM tasks WHERE status IN ('running', 'awaiting_approval')")
    .all() as { id: string }[];
  for (const { id } of rows) {
    const turn = conversationRepo.getRunningTurn(db, id);
    if (turn) conversationRepo.closeTurn(db, turn.id, 'failed');
    // ticket #20（additive）：中断任务的 pending 审批行一并清账（fail-closed，
    // 防重启后历史重拉把已成尸体的请求重新摆上审批托盘）
    approvalRepo.denyPendingApprovals(db, id, reason);
    taskRepo.updateStatus(db, id, 'failed', Date.now(), reason);
  }
  return rows.length;
}

/** 流式段落的内存缓冲（per task；高频 delta 合流后节流落库） */
interface StreamBuffer {
  kind: 'text' | 'thinking' | null;
  content: string;
  messageId: string | null;
}

interface TaskRuntime {
  buffer: StreamBuffer;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const FLUSH_INTERVAL_MS = 250;

export function createAgentEventDispatcher(ctx: AgentEventDispatchContext) {
  const runtimes = new Map<string, TaskRuntime>();

  const runtimeFor = (taskId: string): TaskRuntime => {
    let rt = runtimes.get(taskId);
    if (!rt) {
      rt = { buffer: { kind: null, content: '', messageId: null }, flushTimer: null };
      runtimes.set(taskId, rt);
    }
    return rt;
  };

  /** 幂等状态迁移：当前态已到目标态或边非法时静默跳过 */
  const safeTransition = (taskId: string, to: TaskStatus, failReason?: string): void => {
    const task = taskRepo.getById(ctx.db, taskId);
    if (!task || task.status === to) return;
    if (!canTransition(task.status, to)) {
      console.warn(`[agent-events] 跳过非法迁移 ${task.status} → ${to} (task=${taskId})`);
      return;
    }
    taskRepo.updateStatus(ctx.db, taskId, to, Date.now(), failReason);
    ctx.broadcastTasksChanged();
  };

  /** 把缓冲的流式段落落库（插入首段 / 整量回写后续） */
  const flushBuffer = (taskId: string): void => {
    const rt = runtimes.get(taskId);
    if (!rt || rt.buffer.kind === null || rt.buffer.content.length === 0) return;
    const turn = conversationRepo.getRunningTurn(ctx.db, taskId);
    if (rt.buffer.messageId) {
      conversationRepo.updateMessageContent(ctx.db, rt.buffer.messageId, rt.buffer.content);
    } else {
      const msg = conversationRepo.insertMessage(ctx.db, {
        taskId,
        turnId: turn?.id ?? null,
        role: 'assistant',
        kind: rt.buffer.kind,
        content: rt.buffer.content,
        seq: conversationRepo.nextSeq(ctx.db, taskId),
      });
      rt.buffer.messageId = msg.id;
    }
    // 段落已落库即完成本轮缓冲；继续流式时开新缓冲（同 messageId 继续回写）
    rt.buffer.content = '';
  };

  const scheduleFlush = (taskId: string): void => {
    const rt = runtimeFor(taskId);
    if (rt.flushTimer) return;
    rt.flushTimer = setTimeout(() => {
      rt.flushTimer = null;
      flushBuffer(taskId);
    }, FLUSH_INTERVAL_MS);
  };

  /** 段落边界：换段前把当前段最终化（下一段换新 messageId） */
  const sealBuffer = (taskId: string): void => {
    const rt = runtimes.get(taskId);
    if (!rt) return;
    if (rt.flushTimer) {
      clearTimeout(rt.flushTimer);
      rt.flushTimer = null;
    }
    flushBuffer(taskId);
    rt.buffer = { kind: null, content: '', messageId: null };
  };

  const appendDelta = (taskId: string, kind: 'text' | 'thinking', delta: string): void => {
    const rt = runtimeFor(taskId);
    if (rt.buffer.kind !== null && rt.buffer.kind !== kind) sealBuffer(taskId);
    if (rt.buffer.kind === null) rt.buffer.kind = kind;
    rt.buffer.content += delta;
    scheduleFlush(taskId);
  };

  const closeRunningTurn = (taskId: string, status: 'completed' | 'failed' | 'cancelled'): void => {
    const turn = conversationRepo.getRunningTurn(ctx.db, taskId);
    if (turn) conversationRepo.closeTurn(ctx.db, turn.id, status);
  };

  const dispatch = (taskId: string, event: AgentEvent): void => {
    const task = taskRepo.getById(ctx.db, taskId);
    if (!task) {
      console.warn(`[agent-events] 事件指向未知任务 ${taskId}，已丢弃 (${event.type})`);
      return;
    }
    switch (event.type) {
      case 'session_started':
        if (!task.session_id) taskRepo.setSessionId(ctx.db, taskId, event.sessionId);
        break;

      case 'text_delta':
        appendDelta(taskId, 'text', event.delta);
        break;
      case 'thinking_delta':
        appendDelta(taskId, 'thinking', event.delta);
        break;

      case 'tool_call': {
        sealBuffer(taskId);
        const turn = conversationRepo.getRunningTurn(ctx.db, taskId);
        conversationRepo.upsertToolCall(ctx.db, {
          id: event.call.id,
          taskId,
          turnId: turn?.id ?? null,
          name: event.call.name,
          target: event.call.target,
          status:
            event.call.status === 'running'
              ? 'running'
              : event.call.status === 'done'
                ? 'success'
                : 'error',
          inputJson: JSON.stringify(event.call.input ?? {}),
          outputJson:
            event.call.status === 'running'
              ? null
              : JSON.stringify({
                  output: event.call.output ?? null,
                  error: event.call.error ?? null,
                }),
        });
        break;
      }

      case 'permission_request':
        conversationRepo.insertApproval(ctx.db, {
          id: event.request.id,
          taskId,
          requestJson: JSON.stringify(event.request),
        });
        break;

      case 'permission_response':
        conversationRepo.decideApproval(
          ctx.db,
          event.requestId,
          event.decision.behavior === 'allow'
            ? event.decision.always
              ? 'approved_always'
              : 'approved_once'
            : 'denied',
          event.decision.message ?? null,
        );
        break;

      case 'usage': {
        const turn = conversationRepo.getRunningTurn(ctx.db, taskId);
        conversationRepo.insertUsageRecord(ctx.db, {
          taskId,
          turnId: turn?.id ?? null,
          model: event.usage.model ?? null,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
        });
        break;
      }

      case 'turn_end': {
        sealBuffer(taskId);
        closeRunningTurn(taskId, event.status);
        if (event.status === 'completed') {
          safeTransition(taskId, 'awaiting_review');
        } else if (event.status === 'failed') {
          safeTransition(taskId, 'failed', event.reason ?? 'agent 轮次失败');
        } else {
          safeTransition(taskId, 'cancelled');
        }
        break;
      }

      case 'error': {
        if (!event.fatal) {
          console.warn(`[agent-events] 非致命错误 (task=${taskId}): ${event.message}`);
          break;
        }
        sealBuffer(taskId);
        closeRunningTurn(taskId, 'failed');
        safeTransition(taskId, 'failed', event.message);
        break;
      }

      case 'session_ended': {
        sealBuffer(taskId);
        runtimes.delete(taskId);
        if (event.reason === 'failed') {
          closeRunningTurn(taskId, 'failed');
          safeTransition(taskId, 'failed', event.error ?? 'agent 会话异常结束');
        } else if (event.reason === 'cancelled') {
          closeRunningTurn(taskId, 'cancelled');
          safeTransition(taskId, 'cancelled');
        }
        // completed：turn_end 已处理，这里只收尾
        break;
      }
    }
  };

  return dispatch;
}
