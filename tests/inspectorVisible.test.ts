import { beforeEach, describe, expect, it } from 'vitest';

/**
 * ticket #38：检查栏「终端活跃」语义——从全局锁存改为「当前上下文存在存活 pty 会话」。
 * 钉住 §1.2 自动规则新语义（终审 follow-up：用过一次终端后检查栏常驻的退化）：
 * - 终端活跃按上下文（taskId 或 'global'）判定，不跨任务泄漏；
 * - 失效路径明确：shell 退出 / pty dispose / 应用重启（瞬态不落盘）；
 * - resolveInspectorVisible 纯函数签名保持（ctx.terminalActive 布尔输入），
 *   派生逻辑（哪个 key 算活跃）由 terminalActiveFor 承担。
 */

// vitest node 环境无 window/localStorage：zustand persist 默认经 window.localStorage 存取，
// 需要最小桩（只为了让 persist 真实写一次，验证 liveTerminals 不落盘；不验证持久化本身）
const mem = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;
(globalThis as { window?: unknown }).window = globalThis;

const { resolveInspectorVisible, terminalActiveFor, useUiStore, TERMINAL_GLOBAL_KEY } =
  await import('../src/renderer/src/stores/ui');

describe('resolveInspectorVisible（§1.2 纯函数：覆盖优先 + 自动规则）', () => {
  it('手动覆盖优先：open 恒可见 / hidden 恒隐藏', () => {
    const ctx = { hasTask: false, hasChanges: false, terminalActive: false };
    expect(resolveInspectorVisible('open', ctx)).toBe(true);
    expect(resolveInspectorVisible('hidden', { ...ctx, hasTask: true, hasChanges: true })).toBe(
      false,
    );
  });

  it('自动规则：无任务且无终端活跃 → 不占位', () => {
    expect(
      resolveInspectorVisible(null, { hasTask: false, hasChanges: false, terminalActive: false }),
    ).toBe(false);
  });

  it('自动规则：选中任务有变更 → 可见', () => {
    expect(
      resolveInspectorVisible(null, { hasTask: true, hasChanges: true, terminalActive: false }),
    ).toBe(true);
  });

  it('自动规则：当前上下文终端活跃 → 可见（含无任务的 global 会话）', () => {
    expect(
      resolveInspectorVisible(null, { hasTask: false, hasChanges: false, terminalActive: true }),
    ).toBe(true);
  });
});

describe('terminalActiveFor（ticket #38：按上下文派生，杜绝全局锁存泄漏）', () => {
  it('任务 A 的存活会话不泄漏到任务 B（终审回归核心）', () => {
    const live = { 'task-a': true as const };
    expect(terminalActiveFor(live, 'task-a')).toBe(true);
    expect(terminalActiveFor(live, 'task-b')).toBe(false);
  });

  it('无选中任务 → 只看 global 会话', () => {
    expect(terminalActiveFor({ [TERMINAL_GLOBAL_KEY]: true }, null)).toBe(true);
    expect(terminalActiveFor({ 'task-a': true }, null)).toBe(false);
  });

  it('无存活会话 → false', () => {
    expect(terminalActiveFor({}, 'task-a')).toBe(false);
    expect(terminalActiveFor({}, null)).toBe(false);
  });
});

describe('ui store：liveTerminals（瞬态，不落盘）', () => {
  beforeEach(() => {
    useUiStore.getState().setLiveTerminals([]);
  });

  it('setLiveTerminals 快照播种 + setTerminalAlive 增量增减', () => {
    const s = useUiStore.getState();
    s.setLiveTerminals(['task-a', TERMINAL_GLOBAL_KEY]);
    expect(useUiStore.getState().liveTerminals).toEqual({
      'task-a': true,
      [TERMINAL_GLOBAL_KEY]: true,
    });
    s.setTerminalAlive('task-b', true);
    expect(useUiStore.getState().liveTerminals['task-b']).toBe(true);
    s.setTerminalAlive('task-a', false);
    expect(useUiStore.getState().liveTerminals['task-a']).toBeUndefined();
  });

  it('liveTerminals 不落盘（瞬态语义：应用重启即失效）', () => {
    const s = useUiStore.getState();
    s.setTerminalAlive('task-x', true);
    const raw = mem.get('open-cowork:ui');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect('liveTerminals' in persisted.state).toBe(false);
    expect('terminalActivated' in persisted.state).toBe(false);
  });
});
