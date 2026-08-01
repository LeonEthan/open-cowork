import { useUiStore } from '../stores/ui';

/**
 * ticket #33（DESIGN.md §1.1 窗口 chrome 归零）：自定义顶栏废除后，
 * 侧栏折叠开关迁至内容区左上角的小图标行（不占栏位，吸顶常驻）。
 * 保留原 data-testid（toggle-sidebar）以减少 e2e 牵连。
 * 行本身是窗口拖拽区（hiddenInset 下替代原生标题栏），按钮 no-drag。
 * ticket #34（§1.2）：检查栏开关移至 DocumentFlow 内容区右上角（⌘J，
 * 上下文化出现），本行不再承载 toggle-inspector。
 */
export function ContentControls(): React.JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);

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
    </div>
  );
}
