import { randomUUID } from 'node:crypto';
import type { AlwaysAllowRule } from '../../agent/events';
import type { Database } from './database';
import type { Approval, AlwaysAllowRuleRow } from './entities';

/**
 * 审批域仓储（ticket #20）：always_allow_rules 规则 + approvals 行的审计辅助。
 * 纯 Node 无 Electron 依赖，vitest 可直接用 ':memory:' 跑。
 *
 * 分工（与 conversationRepo.ts 的边界）：
 * - conversationRepo 管「事件流驱动的落库」（insertApproval 请求落 pending /
 *   decideApproval 决议回写）——本文件不重复；
 * - 本文件管「审批链路主动动作」：规则记忆、rule_pattern 标注、
 *   终止路径的 pending 审批清账（fail-closed）。
 */

// ── always_allow_rules（「总是允许」规则，全局作用域） ─────────────────────

function toRow(rule: AlwaysAllowRule, now: number): AlwaysAllowRuleRow {
  return { id: randomUUID(), tool: rule.tool, target_pattern: rule.targetPattern, created_at: now };
}

function fromRow(row: AlwaysAllowRuleRow): AlwaysAllowRule {
  return { tool: row.tool, targetPattern: row.target_pattern };
}

/** 全部规则（策略引擎输入；按创建时间升序，先记的规则优先命中） */
export function listRules(db: Database): AlwaysAllowRule[] {
  const rows = db
    .prepare('SELECT * FROM always_allow_rules ORDER BY created_at ASC, rowid ASC')
    .all() as AlwaysAllowRuleRow[];
  return rows.map(fromRow);
}

/**
 * 记忆一条规则（幂等：(tool, target_pattern) 已存在则原样返回，不重复插入）。
 * 返回 { rule, created }——created=false 表示命中去重。
 */
export function insertRuleIfAbsent(
  db: Database,
  rule: AlwaysAllowRule,
  now: number = Date.now(),
): { rule: AlwaysAllowRule; created: boolean } {
  const existing = db
    .prepare('SELECT * FROM always_allow_rules WHERE tool = ? AND target_pattern = ?')
    .get(rule.tool, rule.targetPattern) as AlwaysAllowRuleRow | undefined;
  if (existing) return { rule: fromRow(existing), created: false };
  const row = toRow(rule, now);
  db.prepare(
    'INSERT INTO always_allow_rules (id, tool, target_pattern, created_at) VALUES (?, ?, ?, ?)',
  ).run(row.id, row.tool, row.target_pattern, row.created_at);
  return { rule, created: true };
}

/** 规则展示标签（托盘「总是允许「Bash: npm *」」与 approvals.rule_pattern 同口径） */
export function ruleLabel(rule: AlwaysAllowRule): string {
  return `${rule.tool}: ${rule.targetPattern}`;
}

// ── approvals 行审计辅助 ───────────────────────────────────────────────────

/** 标注规则命中/来源（自动放行命中的规则、⌘2 生成的规则；幂等覆盖写同值） */
export function setApprovalRulePattern(db: Database, approvalId: string, pattern: string): void {
  db.prepare('UPDATE approvals SET rule_pattern = ? WHERE id = ?').run(pattern, approvalId);
}

/** 任务的全部 pending 审批行（重连恢复托盘渲染基线用） */
export function listPendingApprovals(db: Database, taskId: string): Approval[] {
  return db
    .prepare("SELECT * FROM approvals WHERE task_id = ? AND decision = 'pending' ORDER BY created_at ASC")
    .all(taskId) as Approval[];
}

/**
 * 终止路径清账（fail-closed）：任务轮次/会话结束、取消、崩溃恢复时，
 * 把仍是 pending 的审批行记为 denied（只动 pending，幂等；返回清账条数）。
 * 正常决议路径不走这里——driver 补发的 permission_response 经
 * conversationRepo.decideApproval 落库（单一写者，不双写）。
 */
export function denyPendingApprovals(
  db: Database,
  taskId: string,
  reason: string,
  now: number = Date.now(),
): number {
  const res = db
    .prepare(
      "UPDATE approvals SET decision = 'denied', reason = ?, decided_at = ? WHERE task_id = ? AND decision = 'pending'",
    )
    .run(reason, now, taskId);
  return res.changes;
}
