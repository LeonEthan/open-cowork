import { describe, expect, it } from 'vitest';
import { createAgentEventDispatcher, recoverInterruptedTasks } from '../src/main/agentEvents';
import * as conversationRepo from '../src/main/db/conversationRepo';
import { openDatabase } from '../src/main/db/database';
import type { Database } from '../src/main/db/database';
import * as taskRepo from '../src/main/db/taskRepo';
import * as workspaceRepo from '../src/main/db/workspaceRepo';
import type { AgentEvent } from '../src/agent/events';

/**
 * 事件归一 / 持久化（内存库）：utility → main 事件流的落库与状态机迁移。
 * 覆盖：一轮完整对话（text/thinking/tool/usage/turn_end）、取消、失败、
 * 幂等终止事件、两级清理（recoverInterruptedTasks）。
 */

function setup(): {
  db: Database;
  taskId: string;
  dispatch: (taskId: string, e: AgentEvent) => void;
  broadcasts: number;
} {
  const db = openDatabase(':memory:');
  const ws = workspaceRepo.add(db, '/tmp/ws-test');
  const task = taskRepo.create(db, {
    workspaceId: ws.id,
    prompt: '实现需求',
    agentType: 'claude-code',
  });
  // 模拟 services/agent.ts 的启动序列：ready→running + Turn + 用户消息
  taskRepo.updateStatus(db, task.id, 'running');
  const turn = conversationRepo.createTurn(db, task.id);
  conversationRepo.insertMessage(db, {
    taskId: task.id,
    turnId: turn.id,
    role: 'user',
    kind: 'text',
    content: task.prompt,
    seq: conversationRepo.nextSeq(db, task.id),
  });
  let broadcasts = 0;
  const dispatch = createAgentEventDispatcher({
    db,
    broadcastTasksChanged: () => {
      broadcasts += 1;
    },
  });
  return { db, taskId: task.id, dispatch, get broadcasts() { return broadcasts; } } as never;
}

const flushAll = (dispatch: (t: string, e: AgentEvent) => void, taskId: string): void => {
  // 用一个边界事件（tool_call）触发 sealBuffer 把缓冲段落落库
  dispatch(taskId, {
    type: 'tool_call',
    call: { id: 'flush-sentinel', name: 'Bash', target: 'x', status: 'running' },
  });
};

describe('agentEvents 持久化分派', () => {
  it('完整一轮：text/thinking/tool/usage/turn_end → 落库 + running→awaiting_review', () => {
    const { db, taskId, dispatch } = setup();

    dispatch(taskId, { type: 'session_started', sessionId: 'sess-1', model: 'm1', cwd: '/tmp' });
    expect(taskRepo.getById(db, taskId)?.session_id).toBe('sess-1');

    dispatch(taskId, { type: 'thinking_delta', delta: '想想' });
    dispatch(taskId, { type: 'text_delta', delta: '你好' });
    dispatch(taskId, { type: 'text_delta', delta: '世界' });
    dispatch(taskId, {
      type: 'tool_call',
      call: { id: 't1', name: 'Bash', target: 'npm test', status: 'running', input: { command: 'npm test' } },
    });
    dispatch(taskId, {
      type: 'tool_call',
      call: { id: 't1', name: 'Bash', target: 'npm test', status: 'done', output: 'green' },
    });
    dispatch(taskId, {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2, model: 'm1' },
    });
    dispatch(taskId, { type: 'turn_end', status: 'completed' });
    dispatch(taskId, { type: 'session_ended', reason: 'completed' });

    const task = taskRepo.getById(db, taskId);
    expect(task?.status).toBe('awaiting_review');

    const history = conversationRepo.listHistory(db, taskId);
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0].status).toBe('completed');
    expect(history.turns[0].ended_at).not.toBeNull();

    const kinds = history.messages.map((m) => `${m.role}:${m.kind}`);
    expect(kinds).toEqual(['user:text', 'assistant:thinking', 'assistant:text']);
    expect(history.messages[2].content).toBe('你好世界');

    expect(history.toolCalls).toHaveLength(1);
    expect(history.toolCalls[0].status).toBe('success');
    expect(history.toolCalls[0].target).toBe('npm test');

    const usage = db.prepare('SELECT * FROM usage_records WHERE task_id = ?').all(taskId) as {
      input_tokens: number;
      output_tokens: number;
    }[];
    expect(usage).toHaveLength(1);
    expect(usage[0].input_tokens).toBe(10);

    // 单时间线：user(1) → thinking(2) → text(3) → tool(4)
    const timeline = [
      ...history.messages.map((m) => ({ seq: m.seq, kind: `msg:${m.kind}` })),
      ...history.toolCalls.map((t) => ({ seq: t.seq ?? 0, kind: `tool:${t.name}` })),
    ].sort((a, b) => a.seq - b.seq);
    expect(timeline.map((t) => t.kind)).toEqual([
      'msg:text',
      'msg:thinking',
      'msg:text',
      'tool:Bash',
    ]);
  });

  it('审批事件：permission_request 落 pending，permission_response 回写决议', () => {
    const { db, taskId, dispatch } = setup();
    dispatch(taskId, {
      type: 'permission_request',
      request: {
        id: 'p1',
        toolName: 'Bash',
        target: 'rm -rf x',
        reason: 'r',
        options: ['allow_once', 'allow_always', 'deny'],
        input: { command: 'rm -rf x' },
      },
    });
    dispatch(taskId, {
      type: 'permission_response',
      requestId: 'p1',
      decision: { behavior: 'deny', message: '太危险' },
    });
    const rows = db.prepare('SELECT * FROM approvals WHERE id = ?').all('p1') as {
      decision: string;
      reason: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('denied');
    expect(rows[0].reason).toBe('太危险');
  });

  it('失败：turn_end(failed) → failed + 原因记录；幂等终止事件不炸', () => {
    const { db, taskId, dispatch } = setup();
    dispatch(taskId, { type: 'turn_end', status: 'failed', reason: 'API 限流' });
    // 终止事件重复到达（session_ended failed 尾随）
    dispatch(taskId, { type: 'session_ended', reason: 'failed', error: 'API 限流' });
    const task = taskRepo.getById(db, taskId);
    expect(task?.status).toBe('failed');
    expect(task?.fail_reason).toContain('限流');
    expect(conversationRepo.getRunningTurn(db, taskId)).toBeNull();
  });

  it('取消：turn_end(cancelled) → cancelled（task 已 cancelled 时幂等跳过）', () => {
    const { db, taskId, dispatch } = setup();
    // services/agent.ts 的 cancel 路径先行迁移 + 关 Turn
    taskRepo.updateStatus(db, taskId, 'cancelled');
    const turn = conversationRepo.getRunningTurn(db, taskId);
    if (turn) conversationRepo.closeTurn(db, turn.id, 'cancelled');
    // utility 的 turn_end 随后到达：状态迁移应幂等跳过（不抛错）
    dispatch(taskId, { type: 'turn_end', status: 'cancelled' });
    dispatch(taskId, { type: 'session_ended', reason: 'cancelled' });
    expect(taskRepo.getById(db, taskId)?.status).toBe('cancelled');
  });

  it('fatal error → failed；非 fatal 仅记日志不改状态', () => {
    const { db, taskId, dispatch } = setup();
    dispatch(taskId, { type: 'error', message: '小毛病', fatal: false });
    expect(taskRepo.getById(db, taskId)?.status).toBe('running');
    dispatch(taskId, { type: 'error', message: '进程崩溃', fatal: true });
    expect(taskRepo.getById(db, taskId)?.status).toBe('failed');
    expect(taskRepo.getById(db, taskId)?.fail_reason).toBe('进程崩溃');
  });

  it('流式缓冲：thinking/text 交替换段各自落库', () => {
    const { db, taskId, dispatch } = setup();
    dispatch(taskId, { type: 'text_delta', delta: 'A1' });
    dispatch(taskId, { type: 'thinking_delta', delta: 'T1' });
    dispatch(taskId, { type: 'text_delta', delta: 'A2' });
    flushAll(dispatch, taskId);
    const msgs = conversationRepo.listHistory(db, taskId).messages;
    const assistant = msgs.filter((m) => m.role === 'assistant');
    expect(assistant.map((m) => `${m.kind}:${m.content}`)).toEqual([
      'text:A1',
      'thinking:T1',
      'text:A2',
    ]);
  });
});

describe('recoverInterruptedTasks（两级清理持久化侧）', () => {
  it('running/awaiting_approval → failed 带原因，其余状态不动', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/ws-x');
    const mk = (prompt: string) =>
      taskRepo.create(db, { workspaceId: ws.id, prompt, agentType: 'claude-code' });
    const running = mk('r');
    const waiting = mk('w');
    const done = mk('d');
    const ready = mk('q');
    taskRepo.updateStatus(db, running.id, 'running');
    conversationRepo.createTurn(db, running.id);
    taskRepo.updateStatus(db, waiting.id, 'running');
    taskRepo.updateStatus(db, waiting.id, 'awaiting_approval');
    taskRepo.updateStatus(db, done.id, 'running');
    taskRepo.updateStatus(db, done.id, 'awaiting_review');
    taskRepo.updateStatus(db, done.id, 'done');

    const n = recoverInterruptedTasks(db, '进程崩溃');
    expect(n).toBe(2);
    expect(taskRepo.getById(db, running.id)?.status).toBe('failed');
    expect(taskRepo.getById(db, running.id)?.fail_reason).toBe('进程崩溃');
    expect(taskRepo.getById(db, waiting.id)?.status).toBe('failed');
    expect(taskRepo.getById(db, done.id)?.status).toBe('done');
    expect(taskRepo.getById(db, ready.id)?.status).toBe('ready');
    expect(conversationRepo.getRunningTurn(db, running.id)).toBeNull();
  });
});
