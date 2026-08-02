import { useEffect } from 'react';
import { NavButtons } from './NavButtons';
import { useInspectorVisible } from '../hooks/useInspectorVisible';
import { useUiStore } from '../stores/ui';

/**
 * ticket #33（DESIGN.md §1.1 窗口 chrome 归零）：自定义顶栏废除后，
 * 侧栏折叠开关迁至内容区左上角的小图标行（不占栏位，吸顶常驻）。
 * 行本身是窗口拖拽区（hiddenInset 下替代原生标题栏拖拽），按钮 no-drag。
 * ticket #34（§1.2）：检查栏开关移至 DocumentFlow 内容区右上角（⌘J）。
 * Codex 对齐（附录 B）：导航按钮组（toggle + ‹ ›）主归宿 = 侧栏顶 strip
 * （红绿灯同行，Codex 同款）；本行仅在侧栏折叠后渲染按钮（strip 随侧栏隐藏，
 * 折叠态仍要有恢复入口）。⌘[ / ⌘] 键盘监听常驻（与本行是否渲染按钮无关）。
 */
export function ContentControls(): React.JSX.Element {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  // ticket #34（§1.2）：检查栏开关居本行右端（⌘J；变更新内容带状态点）——
  // 宿主 sticky 条不随文档滚动（旧 absolute 方案会被 .content 滚动顶出视口，实测半裁剪）
  const inspectorVisible = useInspectorVisible();
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const changesBadge = useUiStore((s) => s.changesBadge);

  // ⌘[ / ⌘]（win/linux 用 Ctrl）：后退/前进；焦点在输入控件内不抢（保留文本编辑语义）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== '[' && e.key !== ']') return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      if (e.key === '[') useUiStore.getState().goNavBack();
      else useUiStore.getState().goNavForward();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="content-controls">
      {sidebarCollapsed && <NavButtons />}
      <button
        type="button"
        className="icon-btn inspector-toggle"
        data-testid="toggle-inspector"
        aria-pressed={inspectorVisible}
        title={inspectorVisible ? '隐藏检查栏（⌘J）' : '显示检查栏（⌘J）'}
        onClick={() => toggleInspector(inspectorVisible)}
      >
        ⇥
        {changesBadge && (
          <span className="inspector-badge" data-testid="inspector-badge" aria-hidden />
        )}
      </button>
    </div>
  );
}
