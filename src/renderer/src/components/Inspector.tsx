import { useEffect } from 'react';
import { inspectorTabs } from '../extensions/registry';
import { useUiStore } from '../stores/ui';

/**
 * 检查栏（320px，可折叠，§1）：tab 经 extensions/inspector-tabs/ 自动注册。
 * 无 tab 注册时安全降级（占位文案），不渲染空 tab 栏。
 */
export function Inspector(): React.JSX.Element {
  const collapsed = useUiStore((s) => s.inspectorCollapsed);
  const activeTab = useUiStore((s) => s.activeInspectorTab);
  const setActiveTab = useUiStore((s) => s.setActiveInspectorTab);

  // 默认选中第一个已注册 tab；持久化的 tab id 已不存在时回落
  useEffect(() => {
    if (inspectorTabs.length === 0) return;
    if (!activeTab || !inspectorTabs.some((t) => t.id === activeTab)) {
      setActiveTab(inspectorTabs[0].id);
    }
  }, [activeTab, setActiveTab]);

  const active = inspectorTabs.find((t) => t.id === activeTab) ?? inspectorTabs[0];

  return (
    <aside className={`inspector${collapsed ? ' collapsed' : ''}`} data-testid="inspector" aria-hidden={collapsed}>
      {inspectorTabs.length > 0 ? (
        <>
          <div className="inspector-tabs" role="tablist">
            {inspectorTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="inspector-tab"
                aria-selected={t.id === active?.id}
                data-testid={`inspector-tab-${t.id}`}
                onClick={() => setActiveTab(t.id)}
              >
                {t.title}
              </button>
            ))}
          </div>
          <div className="inspector-body" role="tabpanel">
            {active ? <active.component /> : null}
          </div>
        </>
      ) : (
        <div className="inspector-body">
          <div className="empty-state">（无已注册面板）</div>
        </div>
      )}
    </aside>
  );
}
