import { useEffect, useRef } from 'react';
import { useTerminalDrawerVisible } from '../hooks/useTerminalDrawerVisible';
import { useAppStore } from '../stores/appStore';
import { useDataStore } from '../stores/data';
import { TERMINAL_GLOBAL_KEY, useUiStore } from '../stores/ui';
import { TerminalHost } from './terminal/TerminalHost';
import { destroySession, getOrCreateSession, sessions } from './terminal/sessions';

/** 抽屉拖拽调高的下限/上限（上限 = 窗口高 60%） */
const MIN_HEIGHT = 120;
const maxHeight = (): number => window.innerHeight * 0.6;

/** tab 标题：任务会话显任务标题（截 12 字），global 显「全局」 */
function tabLabel(key: string, taskTitle: string | undefined): string {
  if (key === TERMINAL_GLOBAL_KEY) return '全局';
  const title = taskTitle ?? key;
  return title.length > 12 ? `${title.slice(0, 12)}…` : title;
}

/**
 * 底部终端抽屉（§1.2 修订，附录 B：横贯中央列底部，Codex 截图4 对齐）：
 * - 可见性 = 手动覆盖（⌘T，持久化记忆）?? 当前上下文终端活跃（useTerminalDrawerVisible）；
 *   不可见返回 null，不占位；
 * - tab 集合 = （存活 pty 会话 ∪ renderer 会话）∩ {当前上下文 key, 'global'}——
 *   其他任务的会话不泄漏（ticket #38）；仅挂载激活 tab 的 TerminalHost，
 *   其余会话 detach 保活（xterm 缓冲不丢）；
 * - 手动唤起且无存活会话时自动为当前上下文建 tab（等同按了一次 +，懒启动起 shell）；
 * - 顶边拖拽把手调高（120 ~ 窗口 60%，写 terminalHeight 记忆）。
 */
export function TerminalDrawer(): React.JSX.Element | null {
  const visible = useTerminalDrawerVisible();
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const tasks = useDataStore((s) => s.tasks);
  const liveTerminals = useUiStore((s) => s.liveTerminals);
  const terminalHeight = useUiStore((s) => s.terminalHeight);
  const setTerminalHeight = useUiStore((s) => s.setTerminalHeight);
  const activeTerminalKey = useUiStore((s) => s.activeTerminalKey);
  const setActiveTerminalKey = useUiStore((s) => s.setActiveTerminalKey);
  const drawerRef = useRef<HTMLElement | null>(null);

  const contextKey = currentTaskId ?? TERMINAL_GLOBAL_KEY;
  // tab 集合：上下文候选 ∩（liveTerminals ∪ renderer 会话）
  const candidates =
    contextKey === TERMINAL_GLOBAL_KEY ? [TERMINAL_GLOBAL_KEY] : [contextKey, TERMINAL_GLOBAL_KEY];
  const present = new Set<string>([...Object.keys(liveTerminals), ...sessions.keys()]);
  const tabs = candidates.filter((k) => present.has(k));

  // 激活 tab：显式选择优先（须仍在集合内），否则回落当前上下文 key，再回落首个 tab
  const effectiveActive =
    activeTerminalKey && tabs.includes(activeTerminalKey)
      ? activeTerminalKey
      : tabs.includes(contextKey)
        ? contextKey
        : (tabs[0] ?? null);

  // 手动唤起且无存活会话 → 自动为当前上下文建 tab（懒启动由 TerminalHost 挂载触发）
  useEffect(() => {
    if (!visible || tabs.length > 0) return;
    getOrCreateSession(contextKey);
    setActiveTerminalKey(contextKey);
  }, [visible, tabs.length, contextKey, setActiveTerminalKey]);

  if (!visible) return null;

  const titleOf = (key: string): string | undefined =>
    key === TERMINAL_GLOBAL_KEY ? undefined : tasks.find((t) => t.id === key)?.title;

  /** 关闭 tab：dispose pty + 销毁 renderer 会话 + 摘除激活态（liveTerminals 由 pty:session 事件同步） */
  const closeTab = (key: string): void => {
    window.openCowork?.ptyDispose(key);
    const session = sessions.get(key);
    if (session) destroySession(session);
    if (activeTerminalKey === key) setActiveTerminalKey(null);
  };

  /** 新建当前上下文 tab（已在集合则置灰，见 disabled） */
  const newTab = (): void => {
    getOrCreateSession(contextKey);
    setActiveTerminalKey(contextKey);
  };

  /** 顶边拖拽调高：以抽屉底边为基准，指针纵坐标换算高度，钳制后写记忆 */
  const onGripPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const drawer = drawerRef.current;
    if (!drawer) return;
    const bottom = drawer.getBoundingClientRect().bottom;
    const onMove = (ev: PointerEvent): void => {
      const next = Math.min(maxHeight(), Math.max(MIN_HEIGHT, bottom - ev.clientY));
      setTerminalHeight(Math.round(next));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <section
      className="terminal-drawer"
      data-testid="terminal-drawer"
      ref={drawerRef}
      style={{ height: terminalHeight }}
    >
      <div
        className="terminal-drawer-grip"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onGripPointerDown}
      />
      <div className="terminal-drawer-tabs" role="tablist">
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            className="terminal-tab"
            aria-selected={key === effectiveActive}
            onClick={() => setActiveTerminalKey(key)}
          >
            <span className="terminal-tab-label">{tabLabel(key, titleOf(key))}</span>
            {key === effectiveActive && (
              <span
                role="button"
                className="terminal-tab-close"
                data-testid="terminal-tab-close"
                aria-label="关闭终端会话"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(key);
                }}
              >
                ✕
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="terminal-drawer-action"
          data-testid="terminal-new-tab"
          aria-label="新建终端会话"
          disabled={tabs.includes(contextKey)}
          onClick={newTab}
        >
          +
        </button>
        <span className="terminal-drawer-spacer" />
        <button
          type="button"
          className="terminal-drawer-action"
          data-testid="terminal-drawer-close"
          aria-label="隐藏终端抽屉（⌘T）"
          onClick={() => useUiStore.getState().toggleTerminalDrawer(true)}
        >
          ✕
        </button>
      </div>
      <div className="terminal-drawer-body">
        {effectiveActive ? <TerminalHost sessionKey={effectiveActive} /> : null}
      </div>
    </section>
  );
}
