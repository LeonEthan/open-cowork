import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '../src/main/db/entities';
import { assertTransition, canTransition } from '../src/main/db/taskStateMachine';

/**
 * Task 六态状态机（ticket #18）：
 *   ready → running ⇄ awaiting_approval → awaiting_review → done
 *   任意活跃态 → failed / cancelled；failed → ready（重试）；done/cancelled 终态。
 * 表驱动：枚举全部 7×7 状态对，逐一核对合法性。
 */

const ALL: TaskStatus[] = [
  'ready',
  'running',
  'awaiting_approval',
  'awaiting_review',
  'done',
  'failed',
  'cancelled',
];

/** 合法边全集（与 spec 决策片段一一对应） */
const LEGAL: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  ['ready', 'running'],
  ['running', 'awaiting_approval'],
  ['awaiting_approval', 'running'], // ⇄ 回程
  ['running', 'awaiting_review'],
  ['awaiting_approval', 'awaiting_review'],
  ['awaiting_review', 'done'],
  // 活跃态 → failed / cancelled
  ['ready', 'failed'],
  ['ready', 'cancelled'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['awaiting_approval', 'failed'],
  ['awaiting_approval', 'cancelled'],
  ['awaiting_review', 'failed'],
  ['awaiting_review', 'cancelled'],
  // failed → ready（重试）
  ['failed', 'ready'],
];

const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));

describe('taskStateMachine', () => {
  it('合法迁移全部放行（表驱动）', () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from} → ${to} 应合法`).toBe(true);
      expect(() => assertTransition(from, to), `${from} → ${to} 不应抛错`).not.toThrow();
    }
  });

  it('7×7 全状态对逐一核对：合法集之外一律拒绝', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = legalSet.has(`${from}->${to}`);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
        if (!expected) {
          expect(() => assertTransition(from, to), `${from} → ${to} 应抛错`).toThrow(
            /非法任务状态迁移/,
          );
        }
      }
    }
  });

  it('代表性非法迁移被拒（票面点名）', () => {
    // done/cancelled 为终态
    expect(canTransition('done', 'running')).toBe(false);
    expect(canTransition('done', 'ready')).toBe(false);
    expect(canTransition('done', 'failed')).toBe(false);
    expect(canTransition('cancelled', 'ready')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
    // ready 不能直达 done / 跨级
    expect(canTransition('ready', 'done')).toBe(false);
    expect(canTransition('ready', 'awaiting_approval')).toBe(false);
    expect(canTransition('ready', 'awaiting_review')).toBe(false);
    // failed 仅可回 ready（重试），不可直达其他态
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('failed', 'done')).toBe(false);
    expect(canTransition('failed', 'cancelled')).toBe(false);
  });

  it('不允许自迁移（x → x）', () => {
    for (const s of ALL) {
      expect(canTransition(s, s), `${s} → ${s} 应被拒`).toBe(false);
    }
  });
});
