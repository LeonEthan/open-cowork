import { useUiStore } from '../stores/ui';

/**
 * 窗口导航按钮组（Codex 对齐，附录 B）：侧栏 toggle + 前进/后退。
 * Codex 布局 = 红绿灯同行右侧（侧栏顶 strip）；侧栏折叠时 strip 随之隐藏，
 * 按钮组退回内容区左上角（ContentControls，§1.1 原归宿）。
 * 三键共用一组 data-testid（toggle-sidebar / nav-back / nav-forward）——
 * 两处挂载点互斥渲染（展开时 strip、折叠时内容区），同一时刻只有一个实例。
 */
export function NavButtons(): React.JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const canBack = useUiStore((s) => s.navBack.length > 0);
  const canForward = useUiStore((s) => s.navForward.length > 0);

  return (
    <>
      <button
        type="button"
        className="icon-btn chrome-btn"
        data-testid="toggle-sidebar"
        aria-pressed={!sidebarCollapsed}
        title={sidebarCollapsed ? '展开任务侧栏' : '折叠任务侧栏'}
        onClick={toggleSidebar}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <button
        type="button"
        className="icon-btn chrome-btn"
        data-testid="nav-back"
        disabled={!canBack}
        title="后退（⌘[）"
        onClick={() => useUiStore.getState().goNavBack()}
      >
        ‹
      </button>
      <button
        type="button"
        className="icon-btn chrome-btn"
        data-testid="nav-forward"
        disabled={!canForward}
        title="前进（⌘]）"
        onClick={() => useUiStore.getState().goNavForward()}
      >
        ›
      </button>
    </>
  );
}
