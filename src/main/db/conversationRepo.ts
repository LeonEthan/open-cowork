import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import type { Approval, ApprovalDecision, Message, MessageRole, ToolCall, Turn, TurnStatus, UsageRecord } from './entities';

/**
 * 会话持久化仓储（ticket #19）：Turn / Message / ToolCall / Approval / UsageRecord
 * 的落库函数。纯 Node 无 Electron 依赖，vitest 可直接用 ':memory:' 跑。
 *
 * 调用方是 main 侧 agent 事件分派（agentEvents.ts）与 agent 服务（services/agent.ts）；
 * 所有任务状态迁移仍走 taskRepo.updateStatus（状态机把关），本文件不碰 tasks.status。
 */

// ── Turn ─────────────────────────────────────────────────────────────────

export function nextTurnIdx(db: Database, taskId: string): number {
  const row = db
    .prepare('SELECT MAX(idx) AS m FROM turns WHERE task_id = ?')
    .get(taskId) as { m: number | null };
  return (row.m ?? 0) + 1;
}

export function createTurn(db: Database, taskId: string, now: number = Date.now()): Turn {
  const turn: Turn = {
    id: randomUUID(),
    task_id: taskId,
    idx: nextTurnIdx(db, taskId),
    status: 'running',
    started_at: now,
    ended_at: null,
  };
  db.prepare(
    'INSERT INTO turns (id, task_id, idx, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(turn.id, turn.task_id, turn.idx, turn.status, turn.started_at, turn.ended_at);
  return turn;
}

/** 当前进行中的轮次（无则 null） */
export function getRunningTurn(db: Database, taskId: string): Turn | null {
  const row = db
    .prepare("SELECT * FROM turns WHERE task_id = ? AND status = 'running' ORDER BY idx DESC LIMIT 1")
    .get(taskId) as Turn | undefined;
  return row ?? null;
}

/** 关闭轮次（幂等：已关闭则跳过） */
export function closeTurn(db: Database, turnId: string, status: TurnStatus, now: number = Date.now()): void {
  if (status === 'running') throw new Error('closeTurn 不允许回写 running');
  db.prepare(
    "UPDATE turns SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'",
  ).run(status, now, turnId);
}

// ── seq（messages 与 tool_calls 共用同一任务内计数器，单时间线排序依据） ──

export function nextSeq(db: Database, taskId: string): number {
  const m = db.prepare('SELECT MAX(seq) AS m FROM messages WHERE task_id = ?').get(taskId) as {
    m: number | null;
  };
  const t = db.prepare('SELECT MAX(seq) AS m FROM tool_calls WHERE task_id = ?').get(taskId) as {
    m: number | null;
  };
  return Math.max(m.m ?? 0, t.m ?? 0) + 1;
}

// ── Message ──────────────────────────────────────────────────────────────

export interface InsertMessageInput {
  taskId: string;
  turnId: string | null;
  role: MessageRole;
  /** text / thinking（thinking 折叠呈现，DESIGN.md §4） */
  kind: string;
  content: string;
  seq: number;
}

export function insertMessage(
  db: Database,
  input: InsertMessageInput,
  now: number = Date.now(),
): Message {
  const msg: Message = {
    id: randomUUID(),
    task_id: input.taskId,
    turn_id: input.turnId,
    role: input.role,
    kind: input.kind,
    content: input.content,
    seq: input.seq,
    created_at: now,
  };
  db.prepare(
    `INSERT INTO messages (id, task_id, turn_id, role, kind, content, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(msg.id, msg.task_id, msg.turn_id, msg.role, msg.kind, msg.content, msg.seq, msg.created_at);
  return msg;
}

/** 流式段落的整量回写（content 为累计全文；FTS 触发器随 UPDATE 同步） */
export function updateMessageContent(db: Database, messageId: string, content: string): void {
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
}

// ── ToolCall ─────────────────────────────────────────────────────────────

export interface UpsertToolCallInput {
  id: string;
  taskId: string;
  turnId: string | null;
  name: string;
  target: string | null;
  status: ToolCall['status'];
  inputJson?: string;
  outputJson?: string | null;
  seq?: number;
  now?: number;
}

/** 幂等 upsert：首次（running）插入，后续（success/error/denied）按 id 更新 */
export function upsertToolCall(db: Database, input: UpsertToolCallInput): void {
  const now = input.now ?? Date.now();
  const existing = db.prepare('SELECT id, seq FROM tool_calls WHERE id = ?').get(input.id) as
    | { id: string; seq: number | null }
    | undefined;
  if (!existing) {
    const ended = input.status === 'success' || input.status === 'error' || input.status === 'denied';
    db.prepare(
      `INSERT INTO tool_calls (id, task_id, turn_id, message_id, name, target, input_json,
                               output_json, status, seq, started_at, ended_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.taskId,
      input.turnId,
      input.name,
      input.target,
      input.inputJson ?? '{}',
      input.outputJson ?? null,
      input.status,
      input.seq ?? nextSeq(db, input.taskId),
      now,
      ended ? now : null,
    );
    return;
  }
  const ended = input.status === 'success' || input.status === 'error' || input.status === 'denied';
  db.prepare(
    `UPDATE tool_calls SET status = ?, output_json = COALESCE(?, output_json),
                            target = COALESCE(?, target), ended_at = CASE WHEN ? THEN ? ELSE ended_at END
     WHERE id = ?`,
  ).run(input.status, input.outputJson ?? null, input.target, ended ? 1 : 0, now, input.id);
}

// ── Approval（#20 审批流会扩展；本票最小落库：请求 pending → 决议回写） ──

export function insertApproval(
  db: Database,
  input: { id: string; taskId: string; toolCallId?: string | null; requestJson: string },
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO approvals (id, task_id, tool_call_id, request_json, decision, reason, rule_pattern,
                            created_at, decided_at)
     VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)
     ON CONFLICT(id) DO NOTHING`,
  ).run(input.id, input.taskId, input.toolCallId ?? null, input.requestJson, now);
}

export function decideApproval(
  db: Database,
  id: string,
  decision: ApprovalDecision,
  reason: string | null,
  now: number = Date.now(),
): void {
  db.prepare('UPDATE approvals SET decision = ?, reason = ?, decided_at = ? WHERE id = ?').run(
    decision,
    reason,
    now,
    id,
  );
}

// ── UsageRecord（#27 接通折算：cost_usd / pricing_source 落库时一次锁定） ──

export function insertUsageRecord(
  db: Database,
  input: {
    taskId: string;
    turnId: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** ticket #27：provider 快照（订阅途径 = null） */
    providerId?: string | null;
    /** ticket #27：models.dev 折算结果（订阅制/无价目 = null，口径见 usage/pricing.ts） */
    costUsd?: number | null;
    pricingSource?: 'models.dev' | 'subscription' | null;
  },
  now: number = Date.now(),
): UsageRecord {
  const rec: UsageRecord = {
    id: randomUUID(),
    task_id: input.taskId,
    turn_id: input.turnId,
    provider_id: input.providerId ?? null,
    model: input.model,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    cache_read_tokens: input.cacheReadTokens,
    cache_write_tokens: input.cacheWriteTokens,
    cost_usd: input.costUsd ?? null,
    pricing_source: input.pricingSource ?? null,
    recorded_at: now,
  };
  db.prepare(
    `INSERT INTO usage_records (id, task_id, turn_id, provider_id, model, input_tokens,
                                output_tokens, cache_read_tokens, cache_write_tokens,
                                cost_usd, pricing_source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rec.id,
    rec.task_id,
    rec.turn_id,
    rec.provider_id,
    rec.model,
    rec.input_tokens,
    rec.output_tokens,
    rec.cache_read_tokens,
    rec.cache_write_tokens,
    rec.cost_usd,
    rec.pricing_source,
    rec.recorded_at,
  );
  return rec;
}

/** 任务的用量记录（recorded_at 升序；轮次小字 reconcile 与历史重拉用） */
export function listUsageByTask(db: Database, taskId: string): UsageRecord[] {
  return db
    .prepare('SELECT * FROM usage_records WHERE task_id = ? ORDER BY recorded_at ASC, id ASC')
    .all(taskId) as UsageRecord[];
}

/** 全任务用量聚合（侧栏 chip；cost 只加总非 NULL 行，缓存单列，口径见 shared/usageFormat.ts） */
export interface UsageTotalsRow {
  task_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  priced_records: number;
  subscription_records: number;
  records: number;
}

export function usageTotalsByTask(db: Database): UsageTotalsRow[] {
  return db
    .prepare(
      `SELECT task_id,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(cost_usd) AS cost_usd,
              SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced_records,
              SUM(CASE WHEN pricing_source = 'subscription' THEN 1 ELSE 0 END) AS subscription_records,
              COUNT(*) AS records
       FROM usage_records GROUP BY task_id`,
    )
    .all() as UsageTotalsRow[];
}

// ── 历史重拉（renderer 选中任务时渲染用） ─────────────────────────────────

export interface TaskHistory {
  turns: Turn[];
  messages: Message[];
  toolCalls: ToolCall[];
  /** ticket #20（additive）：仍 pending 的审批行——重启/重连后恢复审批托盘的渲染基线 */
  approvals: Approval[];
  /** ticket #27（additive）：用量记录——文档流每轮末尾灰字的渲染基线（含折算口径） */
  usageRecords: UsageRecord[];
}

export function listHistory(db: Database, taskId: string): TaskHistory {
  const turns = db
    .prepare('SELECT * FROM turns WHERE task_id = ? ORDER BY idx ASC')
    .all(taskId) as Turn[];
  const messages = db
    .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY seq ASC')
    .all(taskId) as Message[];
  const toolCalls = db
    .prepare('SELECT * FROM tool_calls WHERE task_id = ? ORDER BY seq ASC, started_at ASC')
    .all(taskId) as ToolCall[];
  const approvals = db
    .prepare("SELECT * FROM approvals WHERE task_id = ? AND decision = 'pending' ORDER BY created_at ASC")
    .all(taskId) as Approval[];
  const usageRecords = listUsageByTask(db, taskId);
  return { turns, messages, toolCalls, approvals, usageRecords };
}
