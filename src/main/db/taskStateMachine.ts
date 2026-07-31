import type { TaskStatus } from './entities';

/**
 * Task 六态状态机（ticket #18；spec 决策片段原样，PRD §4 / ARCHITECTURE §5）：
 *
 *   ready → running ⇄ awaiting_approval → awaiting_review → done
 *                    ↘ failed / cancelled（任意活跃态可入）
 *
 * 落地为边集（唯一权威来源，store/service 层共用；非法迁移一律拒绝）：
 *   ready → running
 *   running ⇄ awaiting_approval
 *   running → awaiting_review
 *   awaiting_approval → awaiting_review
 *   awaiting_review → done
 *   活跃态（ready / running / awaiting_approval / awaiting_review）→ failed | cancelled
 *   failed → ready（重试）
 * done / cancelled 为终态；不允许自迁移（x → x）。
 */

/** 活跃态：可被 agent 运行推进、且可入 failed/cancelled 的状态集合 */
const ACTIVE_STATUSES: readonly TaskStatus[] = [
  'ready',
  'running',
  'awaiting_approval',
  'awaiting_review',
];

const LEGAL_EDGES: ReadonlySet<string> = (() => {
  const edges = new Set<string>();
  const add = (from: TaskStatus, to: TaskStatus) => edges.add(`${from}->${to}`);

  add('ready', 'running');
  add('running', 'awaiting_approval');
  add('awaiting_approval', 'running');
  add('running', 'awaiting_review');
  add('awaiting_approval', 'awaiting_review');
  add('awaiting_review', 'done');
  for (const s of ACTIVE_STATUSES) {
    add(s, 'failed');
    add(s, 'cancelled');
  }
  add('failed', 'ready'); // 重试
  return edges;
})();

/** 迁移是否合法（纯函数，无副作用） */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  return LEGAL_EDGES.has(`${from}->${to}`);
}

/** 非法迁移抛错（写库前必须由本函数把关） */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法任务状态迁移: ${from} → ${to}`);
  }
}
