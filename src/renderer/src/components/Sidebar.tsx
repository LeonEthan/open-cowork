import { useEffect, useRef, useState } from 'react';
import { sidebarSections } from '../extensions/registry';
import { STATUS_LABELS, statusDotClass } from '../lib/taskStatus';
import { useAppStore } from '../stores/appStore';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { NavButtons } from './NavButtons';

/**
 * 任务侧栏（240px，可折叠，§1）：区块经 extensions/sidebar-sections/ 自动注册。
 * 底部放设置入口（齿轮 → 设置视图）。
 * Codex 对齐改造（附录 B，§1.3 五段 IA）：顶部品牌行 = 字标 + 搜索 icon +
 * 待办通知 icon（本地待办聚合：待审批/待复查，非云端推送；附录 A 不引入账户 UI）。
 * 品牌行与 macOS 红绿灯同行（hiddenInset），左留白 76px 避让，行本身为拖拽区。
 */
export function Sidebar(): React.JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setView = useUiStore((s) => s.setView);
  const view = useUiStore((s) => s.view);

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} data-testid="task-sidebar" aria-hidden={collapsed}>
      {/* Codex 对齐（附录 B）：顶 strip = 红绿灯同行右侧的 toggle + ‹ ›（拖拽区）；
          侧栏折叠后按钮组退回内容区左上角（ContentControls） */}
      <div className="sidebar-chrome">
        <NavButtons />
      </div>
      <BrandRow />
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

/** 待办状态（通知弹层聚合口径：待审批 = fail-closed 链路等人裁决；待复查 = 变更等人验收） */
const NOTICE_STATUSES: Record<string, true> = { awaiting_approval: true, awaiting_review: true };

/** 品牌行（§1.3 第 0 段）：字标 + 搜索过滤 + 待办通知弹层 */
function BrandRow(): React.JSX.Element {
  const query = useUiStore((s) => s.sidebarQuery);
  const setQuery = useUiStore((s) => s.setSidebarQuery);
  const noticeOpen = useUiStore((s) => s.noticeOpen);
  const setNoticeOpen = useUiStore((s) => s.setNoticeOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const tasks = useDataStore((s) => s.tasks);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);
  const setView = useUiStore((s) => s.setView);
  const todos = tasks.filter((t) => NOTICE_STATUSES[t.status] === true);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  // 弹层/搜索框 Esc 关闭；通知弹层点击外部关闭
  const noticeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!noticeOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setNoticeOpen(false);
    };
    const onDown = (e: MouseEvent): void => {
      if (noticeRef.current && !noticeRef.current.contains(e.target as Node)) {
        setNoticeOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [noticeOpen, setNoticeOpen]);

  return (
    <div className="sidebar-brand-wrap" ref={noticeRef}>
      <div className="sidebar-brand">
        <span className="brand-word">open-cowork</span>
        <span className="composer-actions-flex" />
        <button
          type="button"
          className="icon-btn brand-icon"
          data-testid="sidebar-search-toggle"
          aria-pressed={searchOpen}
          title="搜索任务"
          onClick={() => {
            const next = !searchOpen;
            setSearchOpen(next);
            if (!next) setQuery('');
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn brand-icon"
          data-testid="notice-toggle"
          aria-pressed={noticeOpen}
          title={todos.length > 0 ? `待办（${todos.length}）` : '待办'}
          onClick={() => setNoticeOpen(!noticeOpen)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 2a4 4 0 0 0-4 4v2.5L2.8 11a.5.5 0 0 0 .4.8h9.6a.5.5 0 0 0 .4-.8L12 8.5V6a4 4 0 0 0-4-4Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          {todos.length > 0 && (
            <span className="notice-badge" data-testid="notice-badge" aria-hidden />
          )}
        </button>
      </div>
      {searchOpen && (
        <div className="sidebar-search">
          <input
            ref={inputRef}
            type="text"
            className="sidebar-search-input"
            data-testid="sidebar-search-input"
            placeholder="过滤任务…（Esc 清除）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                setSearchOpen(false);
              }
            }}
          />
        </div>
      )}
      {noticeOpen && (
        <div className="notice-popover" data-testid="notice-popover" role="menu">
          <p className="notice-title">待办</p>
          {todos.length === 0 ? (
            <p className="muted notice-empty">没有待审批或待复查的任务</p>
          ) : (
            <ul className="notice-list">
              {todos.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="notice-item"
                    data-testid="notice-item"
                    data-status={t.status}
                    onClick={() => {
                      setView('document');
                      setCurrentTaskId(t.id);
                      setNoticeOpen(false);
                    }}
                  >
                    <span className={statusDotClass(t.status)} aria-hidden />
                    <span className="notice-item-text">
                      <span className="notice-item-title">{t.title}</span>
                      <span className="notice-item-meta">
                        {STATUS_LABELS[t.status]} · {t.workspace_name}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
