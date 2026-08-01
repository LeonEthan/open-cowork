import { useUiStore } from '../stores/ui';

/**
 * ticket #33（DESIGN.md §1.1 窗口 chrome 归零）：自定义顶栏废除后，
 * 侧栏/检查栏折叠开关迁至内容区左上角的小图标行（不占栏位，吸顶常驻）。
 * 保留原 data-testid（toggle-sidebar / toggle-inspector）以减少 e2e 牵连。
 * 行本身是窗口拖拽区（hiddenInset 下替代原生标题栏），按钮 no-drag。
 */
export function ContentControls(): React.JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const inspectorCollapsed = useUiStore((s) => s.inspectorCollapsed);

  return (
    <div className="content-controls">
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
    </div>
  );
}
