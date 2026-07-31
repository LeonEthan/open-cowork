import { describe, expect, it } from 'vitest';
import type { PermissionDecision, PermissionRequestPayload } from '../src/agent/events';
import { createApprovalService } from '../src/main/approval/service';
import type { ApprovalService } from '../src/main/approval/service';
import * as approvalRepo from '../src/main/db/approvalRepo';
import * as conversationRepo from '../src/main/db/conversationRepo';
import { openDatabase } from '../src/main/db/database';
import type { Database } from '../src/main/db/database';
import * as taskRepo from '../src/main/db/taskRepo';
import type { PermissionMode } from '../src/main/db/entities';
import * as workspaceRepo from '../src/main/db/workspaceRepo';

/**
 * 审批回路（内存库，ticket #20）：permission-ask → 策略裁决 / 托盘决议 →
 * 回执 postToAgent → 落库审计 → 任务状态机迁移（running ⇄ awaiting_approval）。
 * 覆盖：三档直裁、⌘1/2/3 决议、「总是允许」规则记忆与后续自动放行、
 * 并发排队、幂等重复决议、终止清账（fail-closed）。
 */

interface PostedMsg {
  type: string;
  command: {
    kind: string;
    taskId: string;
    requestId: string;
    decision: PermissionDecision;
  };
}

function makeRequest(over: Partial<PermissionRequestPayload> = {}): PermissionRequestPayload {
  return {
    id: over.id ?? `perm_${Math.random().toString(36).slice(2, 8)}`,
    toolName: 'Bash',
    target: 'npm install -D eslint',
    reason: '安装开发依赖',
    options: ['allow_once', 'allow_always', 'deny'],
    input: { command: 'npm install -D eslint' },
    ...over,
  };
}

function setup(opts: { mode?: PermissionMode } = {}): {
  db: Database;
  taskId: string;
  service: ApprovalService;
  posted: PostedMsg[];
  broadcasts: () => number;
  decisionsFor: (requestId: string) => PermissionDecision[];
} {
  const db = openDatabase(':memory:');
  const ws = workspaceRepo.add(db, '/tmp/ws-approval');
  const task = taskRepo.create(db, {
    workspaceId: ws.id,
    prompt: '实现需求',
    agentType: 'claude-code',
  });
  if (opts.mode) taskRepo.setPermissionMode(db, task.id, opts.mode);
  // 模拟 services/agent.ts 启动序列：ready → running
  taskRepo.updateStatus(db, task.id, 'running');

  const posted: PostedMsg[] = [];
  let broadcasts = 0;
  const service = createApprovalService({
    db,
    postToAgent: (msg) => {
      posted.push(msg as PostedMsg);
    },
    broadcastTasksChanged: () => {
      broadcasts += 1;
    },
  });
  return {
    db,
    taskId: task.id,
    service,
    posted,
    broadcasts: () => broadcasts,
    decisionsFor: (requestId) =>
      posted
        .filter((m) => m.command.kind === 'permission-respond' && m.command.requestId === requestId)
        .map((m) => m.command.decision),
  };
}

/** 模拟 dispatcher 的 permission_request 落库（事件流先行，审批服务随后裁决） */
function insertPendingRow(db: Database, taskId: string, req: PermissionRequestPayload): void {
  conversationRepo.insertApproval(db, {
    id: req.id,
    taskId,
    requestJson: JSON.stringify(req),
  });
}

describe('审批回路：三档直裁（handleAsk 即时回执）', () => {
  it('只读档：写/命令类立即 deny（含理由），读类立即 allow', () => {
    const { taskId, service, decisionsFor } = setup({ mode: 'readonly' });
    const bash = makeRequest({ id: 'p_deny', toolName: 'Bash', target: 'npm test' });
    service.handleAsk(taskId, bash);
    expect(decisionsFor('p_deny')).toHaveLength(1);
    expect(decisionsFor('p_deny')[0].behavior).toBe('deny');
    expect(decisionsFor('p_deny')[0].message).toContain('只读');

    const read = makeRequest({ id: 'p_read', toolName: 'Read', target: '/a.ts' });
    service.handleAsk(taskId, read);
    expect(decisionsFor('p_read')).toEqual([{ behavior: 'allow', always: false }]);
    // 直裁不进托盘
    expect(service.listPending(taskId)).toHaveLength(0);
  });

  it('放权档：一律立即 allow（always=false——档位直放不是规则命中）', () => {
    const { taskId, service, decisionsFor } = setup({ mode: 'full' });
    const req = makeRequest({ id: 'p_full' });
    service.handleAsk(taskId, req);
    expect(decisionsFor('p_full')).toEqual([{ behavior: 'allow', always: false }]);
    expect(service.listPending(taskId)).toHaveLength(0);
  });

  it('任务不存在：fail-closed 立即 deny', () => {
    const { service, decisionsFor } = setup();
    const req = makeRequest({ id: 'p_ghost' });
    service.handleAsk('no-such-task', req);
    expect(decisionsFor('p_ghost')).toHaveLength(1);
    expect(decisionsFor('p_ghost')[0].behavior).toBe('deny');
  });
});

describe('审批回路：托盘决议（自动档未命中 → ask → respond）', () => {
  it('首个 pending：running → awaiting_approval；⌘1 批准一次后结清回 running', () => {
    const { db, taskId, service, decisionsFor, broadcasts } = setup();
    const req = makeRequest({ id: 'p1' });
    insertPendingRow(db, taskId, req);

    service.handleAsk(taskId, req);
    expect(decisionsFor('p1')).toHaveLength(0); // 不直裁，等托盘
    expect(taskRepo.getById(db, taskId)?.status).toBe('awaiting_approval');
    expect(service.listPending(taskId)).toHaveLength(1);

    const r = service.respond({ taskId, requestId: 'p1', decision: { behavior: 'allow' } });
    expect(r.settled).toBe(true);
    expect(decisionsFor('p1')).toEqual([{ behavior: 'allow', always: false }]);
    expect(taskRepo.getById(db, taskId)?.status).toBe('running');
    expect(broadcasts()).toBeGreaterThanOrEqual(2);
  });

  it('并发两条：结清一条不回 running，全部结清才 awaiting_approval → running', () => {
    const { db, taskId, service } = setup();
    const r1 = makeRequest({ id: 'pa' });
    const r2 = makeRequest({ id: 'pb', toolName: 'Write', target: '/repo/x.ts' });
    service.handleAsk(taskId, r1);
    service.handleAsk(taskId, r2);
    expect(taskRepo.getById(db, taskId)?.status).toBe('awaiting_approval');
    expect(service.listPending(taskId)).toHaveLength(2);

    service.respond({ taskId, requestId: 'pa', decision: { behavior: 'allow' } });
    expect(taskRepo.getById(db, taskId)?.status).toBe('awaiting_approval'); // 还有一条

    service.respond({ taskId, requestId: 'pb', decision: { behavior: 'deny', message: '先别写' } });
    expect(taskRepo.getById(db, taskId)?.status).toBe('running');
  });

  it('⌘3 拒绝附理由：deny + message 回执', () => {
    const { taskId, service, decisionsFor } = setup();
    const req = makeRequest({ id: 'p_deny_reason' });
    service.handleAsk(taskId, req);
    service.respond({
      taskId,
      requestId: 'p_deny_reason',
      decision: { behavior: 'deny', message: '太危险，不许删' },
    });
    expect(decisionsFor('p_deny_reason')).toEqual([
      { behavior: 'deny', message: '太危险，不许删' },
    ]);
  });

  it('幂等：重复/陌生决议一律 settled:false 不重复回执', () => {
    const { taskId, service, decisionsFor } = setup();
    const req = makeRequest({ id: 'p_idem' });
    service.handleAsk(taskId, req);
    expect(service.respond({ taskId, requestId: 'p_idem', decision: { behavior: 'allow' } }).settled).toBe(true);
    expect(service.respond({ taskId, requestId: 'p_idem', decision: { behavior: 'deny' } }).settled).toBe(false);
    expect(service.respond({ taskId, requestId: 'stranger', decision: { behavior: 'allow' } }).settled).toBe(false);
    expect(decisionsFor('p_idem')).toHaveLength(1); // 只回执一次
  });

  it('降级 driver 不给 allow_always 选项时，⌘2 被钳制为普通 allow 且不记忆规则', () => {
    const { db, taskId, service, decisionsFor } = setup();
    const req = makeRequest({ id: 'p_degraded', options: ['allow_once', 'deny'] });
    insertPendingRow(db, taskId, req);
    service.handleAsk(taskId, req);
    service.respond({ taskId, requestId: 'p_degraded', decision: { behavior: 'allow', always: true } });
    expect(decisionsFor('p_degraded')).toEqual([{ behavior: 'allow', always: false }]);
    expect(approvalRepo.listRules(db)).toHaveLength(0);
  });
});

describe('「总是允许」：规则记忆 → 持久化 → 后续同类自动放行', () => {
  it('⌘2 → 规则写 always_allow_rules + approvals.rule_pattern 标注；后续同模式 auto_allow', () => {
    const { db, taskId, service, decisionsFor } = setup();
    const first = makeRequest({ id: 'p_first', target: 'npm install -D eslint' });
    insertPendingRow(db, taskId, first);
    service.handleAsk(taskId, first);
    service.respond({ taskId, requestId: 'p_first', decision: { behavior: 'allow', always: true } });

    // 规则持久化（Bash 首词模式）
    const rules = approvalRepo.listRules(db);
    expect(rules).toEqual([{ tool: 'Bash', targetPattern: 'npm *' }]);
    // 审计标注
    const row = db.prepare("SELECT * FROM approvals WHERE id = 'p_first'").get() as {
      rule_pattern: string | null;
    };
    expect(row.rule_pattern).toBe('Bash: npm *');
    expect(decisionsFor('p_first')).toEqual([{ behavior: 'allow', always: true }]);

    // 后续同模式请求：自动档直接放行（规则命中标注，always=true 与规则语义一致）
    const second = makeRequest({ id: 'p_second', target: 'npm test' });
    insertPendingRow(db, taskId, second);
    service.handleAsk(taskId, second);
    expect(decisionsFor('p_second')).toEqual([{ behavior: 'allow', always: true }]);
    expect(service.listPending(taskId)).toHaveLength(0); // 不进托盘
    const row2 = db.prepare("SELECT * FROM approvals WHERE id = 'p_second'").get() as {
      rule_pattern: string | null;
    };
    expect(row2.rule_pattern).toBe('Bash: npm *');

    // 未命中规则的请求照常进托盘
    const third = makeRequest({ id: 'p_third', target: 'yarn build' });
    service.handleAsk(taskId, third);
    expect(service.listPending(taskId).map((p) => p.request.id)).toEqual(['p_third']);
  });

  it('规则插入幂等：重复 ⌘2 不产生重复规则行', () => {
    const { db, taskId, service } = setup();
    for (const id of ['p_r1', 'p_r2']) {
      const req = makeRequest({ id, target: 'npm run build' });
      service.handleAsk(taskId, req);
      service.respond({ taskId, requestId: id, decision: { behavior: 'allow', always: true } });
    }
    expect(approvalRepo.listRules(db)).toEqual([{ tool: 'Bash', targetPattern: 'npm *' }]);
  });
});

describe('终止路径清账（fail-closed）', () => {
  it('cancelForTask：pending 回执 deny + 落库 denied；事后 respond 为 no-op', () => {
    const { db, taskId, service, decisionsFor } = setup();
    const req = makeRequest({ id: 'p_cancel' });
    insertPendingRow(db, taskId, req);
    service.handleAsk(taskId, req);
    expect(service.listPending(taskId)).toHaveLength(1);

    service.cancelForTask(taskId, '轮次结束，待审批请求已取消');
    expect(service.listPending(taskId)).toHaveLength(0);
    expect(decisionsFor('p_cancel')).toEqual([
      { behavior: 'deny', message: '轮次结束，待审批请求已取消' },
    ]);
    const row = db.prepare("SELECT * FROM approvals WHERE id = 'p_cancel'").get() as {
      decision: string;
      reason: string | null;
    };
    expect(row.decision).toBe('denied');
    expect(row.reason).toBe('轮次结束，待审批请求已取消');

    expect(
      service.respond({ taskId, requestId: 'p_cancel', decision: { behavior: 'allow' } }).settled,
    ).toBe(false);
  });

  it('cancelAll：跨任务清账（utility 崩溃路径）', () => {
    const { db, taskId, service } = setup();
    const ws2 = workspaceRepo.add(db, '/tmp/ws-approval-2');
    const task2 = taskRepo.create(db, { workspaceId: ws2.id, prompt: 'p2', agentType: 'claude-code' });
    taskRepo.updateStatus(db, task2.id, 'running');

    service.handleAsk(taskId, makeRequest({ id: 'p_t1' }));
    service.handleAsk(task2.id, makeRequest({ id: 'p_t2' }));
    expect(service.listPending(taskId)).toHaveLength(1);
    expect(service.listPending(task2.id)).toHaveLength(1);

    service.cancelAll('agent 适配层进程退出');
    expect(service.listPending(taskId)).toHaveLength(0);
    expect(service.listPending(task2.id)).toHaveLength(0);
  });
});

describe('approvalRepo 规则仓储', () => {
  it('insertRuleIfAbsent 幂等 + listRules 按创建序', () => {
    const db = openDatabase(':memory:');
    const r1 = approvalRepo.insertRuleIfAbsent(db, { tool: 'Bash', targetPattern: 'npm *' }, 1000);
    const r2 = approvalRepo.insertRuleIfAbsent(db, { tool: 'Write', targetPattern: '/a.ts' }, 2000);
    const dup = approvalRepo.insertRuleIfAbsent(db, { tool: 'Bash', targetPattern: 'npm *' }, 3000);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(dup.created).toBe(false);
    expect(approvalRepo.listRules(db)).toEqual([
      { tool: 'Bash', targetPattern: 'npm *' },
      { tool: 'Write', targetPattern: '/a.ts' },
    ]);
  });

  it('denyPendingApprovals 只动 pending 行（已决议不受影响）', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/ws-x');
    const task = taskRepo.create(db, { workspaceId: ws.id, prompt: 'p', agentType: 'claude-code' });
    conversationRepo.insertApproval(db, { id: 'a1', taskId: task.id, requestJson: '{}' });
    conversationRepo.insertApproval(db, { id: 'a2', taskId: task.id, requestJson: '{}' });
    conversationRepo.decideApproval(db, 'a2', 'approved_once', null);
    const n = approvalRepo.denyPendingApprovals(db, task.id, '清账');
    expect(n).toBe(1);
    const rows = db.prepare('SELECT id, decision FROM approvals ORDER BY id').all() as {
      id: string;
      decision: string;
    }[];
    expect(rows).toEqual([
      { id: 'a1', decision: 'denied' },
      { id: 'a2', decision: 'approved_once' },
    ]);
  });
});
