import { useEffect, useRef } from 'react';
import { inspectorTabs } from '../extensions/registry';
import { peekInspectorVisible, useInspectorVisible } from '../hooks/useInspectorVisible';
import { useAppStore } from '../stores/appStore';
import { useChangesStore } from '../stores/changes';
import { useUiStore } from '../stores/ui';

/**
 * 检查栏（320px，上下文化出现，§1.2 / ticket #34）：tab 经 extensions/inspector-tabs/ 自动注册。
 * 2026-08 修订（§1.2）：终端迁出为底部抽屉，检查栏收窄为变更单栏——仅剩一个 tab 时
 * tab 条退场，直接渲染唯一 tab 组件（多 tab 注册时仍渲染 tab 条，架构保留降级能力）。
 * - 无选中任务、或选中任务无变更时不渲染（0 宽不占位，非「折叠」）；
 *   手动覆盖偏好（展开/隐藏）经 ui store 持久化；开关在内容区右上角（⌘J）。
 * - 变更快照的订阅挂在栏本体（始终挂载）——可见性派生不依赖 tab 是否渲染；
 *   栏隐藏期间变更数增长只点亮开关上的状态点（§5 克制），不抢夺展开。
 * 无 tab 注册时安全降级（占位文案），不渲染空 tab 栏。
 */
export function Inspector(): React.JSX.Element | null {
  const activeTab = useUiStore((s) => s.activeInspectorTab);
  const setActiveTab = useUiStore((s) => s.setActiveInspectorTab);
  const visible = useInspectorVisible();

  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const refreshChanges = useChangesStore((s) => s.refresh);
  const changeCount = useChangesStore((s) =>
    currentTaskId ? (s.byTask[currentTaskId]?.length ?? 0) : 0,
  );
  const changesBadge = useUiStore((s) => s.changesBadge);
  const setChangesBadge = useUiStore((s) => s.setChangesBadge);

  // 默认选中第一个已注册 tab；持久化的 tab id 已不存在时回落
  useEffect(() => {
    if (inspectorTabs.length === 0) return;
    if (!activeTab || !inspectorTabs.some((t) => t.id === activeTab)) {
      setActiveTab(inspectorTabs[0].id);
    }
  }, [activeTab, setActiveTab]);

  // 选中任务变化：重拉变更快照（栏即使未渲染也要掌握 hasChanges，供自动规则派生）
  useEffect(() => {
    if (currentTaskId) void refreshChanges(currentTaskId);
  }, [currentTaskId, refreshChanges]);

  // main 广播 tasks:changed（turn_end 捕获落库 / 决议回写）→ 重拉变更快照
  useEffect(() => {
    const api = window.openCowork;
    if (!api || !currentTaskId) return;
    return api.onTasksChanged(() => {
      void refreshChanges(currentTaskId);
    });
  }, [currentTaskId, refreshChanges]);

  // 新内容轻提示：栏隐藏期间变更数增长 → 点亮开关状态点（不自动抢夺展开，§5）
  const prevCountRef = useRef(changeCount);
  useEffect(() => {
    if (!visible && changeCount > prevCountRef.current) setChangesBadge(true);
    prevCountRef.current = changeCount;
  }, [changeCount, visible, setChangesBadge]);

  // 栏可见即清除提示点
  useEffect(() => {
    if (visible && changesBadge) setChangesBadge(false);
  }, [visible, changesBadge, setChangesBadge]);

  // 全局快捷键 ⌘J（内容区右上角开关同效；写进开关 title 提示）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'j') return;
      e.preventDefault();
      useUiStore.getState().toggleInspector(peekInspectorVisible());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 上下文化：无可展示内容时不渲染占位（§1.2：不留 320px 空白、非折叠）
  if (!visible) return null;

  const active = inspectorTabs.find((t) => t.id === activeTab) ?? inspectorTabs[0];

  return (
    <aside className="inspector" data-testid="inspector">
      {inspectorTabs.length > 1 ? (
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
      ) : active ? (
        /* §1.2 修订：单 tab（变更单栏）时 tab 条退场，直接渲染唯一 tab 组件 */
        <div className="inspector-body">
          <active.component />
        </div>
      ) : (
        <div className="inspector-body">
          <div className="empty-state">（无已注册面板）</div>
        </div>
      )}
    </aside>
  );
}
