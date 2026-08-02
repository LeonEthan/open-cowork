import { beforeEach, describe, expect, it } from 'vitest';

/**
 * §1.2（2026-08 修订）可见性派生测试：
 * - 检查栏收窄为变更单栏——自动规则回归 hasTask && hasChanges，终端活跃不再拉起检查栏；
 * - 终端迁出为底部抽屉——resolveTerminalDrawerVisible 接管 ticket #38 活性派生
 *   （手动覆盖优先；自动 = 当前上下文存活 pty 会话，terminalActiveFor 定义不变）；
 * - 活性失效路径不变：shell 退出 / pty dispose / 应用重启（瞬态不落盘）。
 */

// vitest node 环境无 window/localStorage：zustand persist 默认经 window.localStorage 存取，
// 需要最小桩（只为了让 persist 真实写一次，验证瞬态字段不落盘；不验证持久化本身）
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

const {
  resolveInspectorVisible,
  resolveTerminalDrawerVisible,
  terminalActiveFor,
  useUiStore,
  TERMINAL_GLOBAL_KEY,
} = await import('../src/renderer/src/stores/ui');

describe('resolveInspectorVisible（§1.2 修订：覆盖优先 + 自动规则 hasTask && hasChanges）', () => {
  it('手动覆盖优先：open 恒可见 / hidden 恒隐藏', () => {
    const ctx = { hasTask: false, hasChanges: false };
    expect(resolveInspectorVisible('open', ctx)).toBe(true);
    expect(resolveInspectorVisible('hidden', { hasTask: true, hasChanges: true })).toBe(false);
  });

  it('自动规则：无任务 → 不占位', () => {
    expect(resolveInspectorVisible(null, { hasTask: false, hasChanges: false })).toBe(false);
  });

  it('自动规则：选中任务无变更 → 不占位（终端活跃已迁抽屉，不再拉起检查栏）', () => {
    expect(resolveInspectorVisible(null, { hasTask: true, hasChanges: false })).toBe(false);
  });

  it('自动规则：选中任务有变更 → 可见', () => {
    expect(resolveInspectorVisible(null, { hasTask: true, hasChanges: true })).toBe(true);
  });
});

describe('resolveTerminalDrawerVisible（§1.2 修订：抽屉 = 覆盖优先 + 上下文活跃派生）', () => {
  it('手动覆盖优先：open 恒可见（即使无活跃会话）/ hidden 恒隐藏（即使活跃）', () => {
    expect(resolveTerminalDrawerVisible('open', false)).toBe(true);
    expect(resolveTerminalDrawerVisible('hidden', true)).toBe(false);
  });

  it('自动派生：当前上下文终端活跃 → 可见；不活跃 → 不占位', () => {
    expect(resolveTerminalDrawerVisible(null, true)).toBe(true);
    expect(resolveTerminalDrawerVisible(null, false)).toBe(false);
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

describe('ui store：终端抽屉状态（§1.2 修订）', () => {
  beforeEach(() => {
    useUiStore.setState({
      terminalDrawerOverride: null,
      terminalHeight: 240,
      activeTerminalKey: null,
    });
  });

  it('toggleTerminalDrawer 按当前可见性写相反覆盖（仿 toggleInspector 语义）', () => {
    const s = useUiStore.getState();
    s.toggleTerminalDrawer(true);
    expect(useUiStore.getState().terminalDrawerOverride).toBe('hidden');
    s.toggleTerminalDrawer(false);
    expect(useUiStore.getState().terminalDrawerOverride).toBe('open');
  });

  it('抽屉偏好落盘：override/height 持久化记忆，activeTerminalKey 瞬态不落盘', () => {
    const s = useUiStore.getState();
    s.toggleTerminalDrawer(false); // → 'open'
    s.setTerminalHeight(320);
    s.setActiveTerminalKey('task-a');
    const raw = mem.get('open-cowork:ui');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(persisted.state.terminalDrawerOverride).toBe('open');
    expect(persisted.state.terminalHeight).toBe(320);
    expect('activeTerminalKey' in persisted.state).toBe(false);
  });
});
