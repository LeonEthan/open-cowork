import { useUiStore } from '../stores/ui';

/**
 * 顶栏：折叠开关（侧栏/检查栏）、utility 直连状态行（MessageChannel demo 证明）、主题切换。
 * 视觉克制（§1）：bg-soft 底 + 1px 下边框，无阴影。
 */
export function TopBar(): React.JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const inspectorCollapsed = useUiStore((s) => s.inspectorCollapsed);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const utilityPong = useUiStore((s) => s.utilityPong);
  const utilityTick = useUiStore((s) => s.utilityTick);

  const resolvedDark =
    themeMode === 'dark' ||
    (themeMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn"
        data-testid="toggle-sidebar"
        aria-pressed={!sidebarCollapsed}
        title={sidebarCollapsed ? '展开任务侧栏' : '折叠任务侧栏'}
        onClick={toggleSidebar}
      >
        ⇤
      </button>
      <span className="brand">open-cowork</span>
      <span className="spacer" />
      <span className="utility-status" data-testid="utility-status">
        {utilityPong
          ? `utility ⇄ renderer · pong${utilityTick !== null ? ` · tick ${utilityTick}` : ''}`
          : 'utility: connecting…'}
      </span>
      <button
        type="button"
        className="icon-btn"
        data-testid="theme-toggle"
        title="切换明暗主题（跟随系统可在设置中调整）"
        onClick={() => setThemeMode(resolvedDark ? 'light' : 'dark')}
      >
        {resolvedDark ? '深色' : '浅色'}
      </button>
      <button
        type="button"
        className="icon-btn"
        data-testid="toggle-inspector"
        aria-pressed={!inspectorCollapsed}
        title={inspectorCollapsed ? '展开检查栏' : '折叠检查栏'}
        onClick={toggleInspector}
      >
        ⇥
      </button>
    </header>
  );
}
