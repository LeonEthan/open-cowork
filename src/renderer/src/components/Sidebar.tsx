import { sidebarSections } from '../extensions/registry';
import { useUiStore } from '../stores/ui';

/**
 * 任务侧栏（240px，可折叠，§1）：区块经 extensions/sidebar-sections/ 自动注册。
 * 底部放设置入口（齿轮 → 设置视图）。
 */
export function Sidebar(): React.JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setView = useUiStore((s) => s.setView);
  const view = useUiStore((s) => s.view);

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} data-testid="task-sidebar" aria-hidden={collapsed}>
      <div className="pane-body">
        {sidebarSections.map((s) =>
          // ticket #26（additive）：空标题区块裸渲染（agent 横幅：不健康才有内容，
          // 健康时连区块壳都不留）；有标题区块维持原壳
          s.title === '' ? (
            <s.component key={s.id} />
          ) : (
            <section key={s.id} className="settings-section" data-section-id={s.id}>
              <h2 className="pane-title">{s.title}</h2>
              <s.component />
            </section>
          ),
        )}
        {sidebarSections.length === 0 && <div className="empty-state">（无已注册区块）</div>}
      </div>
      <div className="pane-footer">
        <button
          type="button"
          className="icon-btn"
          data-testid="open-settings"
          aria-pressed={view === 'settings'}
          title="设置"
          onClick={() => setView(view === 'settings' ? 'document' : 'settings')}
        >
          设置
        </button>
      </div>
    </aside>
  );
}
