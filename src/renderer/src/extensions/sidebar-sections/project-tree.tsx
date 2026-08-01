import { useEffect } from 'react';
import type { TaskListItem } from '../../../../shared/api';
import { STATUS_LABELS, agentLabel, statusDotClass } from '../../lib/taskStatus';
import { useAppStore } from '../../stores/appStore';
import { useDataStore } from '../../stores/data';
import { useUiStore } from '../../stores/ui';
import { useUsageStore } from '../../stores/usage';
import { describeTaskUsage, describeTaskUsageTitle } from '../../../../shared/usageFormat';
import type { SidebarSectionDef } from '../registry';
import '../../styles/worktree.css';

/**
 * 侧栏「工程树」区块（ticket #35，DESIGN.md §1.3 侧栏信息架构）：
 * 合并原 workspaces.tsx 与 task-list.tsx 两个区块为一个 project-tree section
 * （注册面自动拾取，id 从 workspaces/tasks 改为 project-tree）。
 *
 * 自上而下（§1.3 前两段；底部设置行在 Sidebar.tsx pane-footer）：
 * 1. 功能行：「新建任务」icon + 文字行（data-testid="new-task-toggle" 保留）。
 *    ticket #36：侧栏新建表单退场——点击改为回到文档视图、取消任务选中
 *    （露出首页 composer）并聚焦其输入框；创建内联化在 composer 完成。
 * 2. 任务树：按 workspace 分组——workspace 行（折叠 chevron + 文件夹 icon + 名称，
 *    可展开/折叠，默认展开，折叠态经 ui store 持久化记忆）+ 任务行缩进其下
 *    （状态点 + 标题 + 元信息保留；use_worktree=1 的任务带分支徽标，#25 数据已具备）。
 *    workspace 行 hover 露出管理操作（移除，级联删任务）。
 *    「添加 workspace」入口收在分组区底部。
 *
 * 行选中/hover 样式见 app.css ticket #35 分组（§2 --bg-pill / §4 侧栏行约定）。
 * testid 保留纪律：new-task-toggle / task-item / task-status-dot / task-usage-chip /
 * workspace-item / workspace-remove / add-workspace 全部保留在对应元素上；
 * 侧栏表单的 new-task-form / task-prompt-input / task-create-submit /
 * task-workspace-select / task-worktree-checkbox 随 #36 表单退场移除
 * （建任务 testid 面迁往首页 composer，e2e 同步重写）。
 */

/** 文件夹 icon（workspace 行；inline SVG，currentColor，无装饰色） */
function FolderIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4a1 1 0 0 1 1-1h3.2l1.6 2h6.2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** worktree 分支徽标：分支名与 main 侧 worktreeBranch()（cowork/<taskId>）约定一致 */
function branchBadgeLabel(t: TaskListItem): string {
  return `cowork/${t.id}`;
}

function ProjectTreeSection(): React.JSX.Element {
  const workspaces = useDataStore((s) => s.workspaces);
  const tasks = useDataStore((s) => s.tasks);
  const loaded = useDataStore((s) => s.loaded);
  const addWorkspaceViaDialog = useDataStore((s) => s.addWorkspaceViaDialog);
  const removeWorkspace = useDataStore((s) => s.removeWorkspace);
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);
  const wsCollapsed = useUiStore((s) => s.sidebarWsCollapsed);
  const toggleSidebarWorkspace = useUiStore((s) => s.toggleSidebarWorkspace);
  // ticket #36：功能行聚焦中区 composer（回文档视图 + 取消任务选中 + 聚焦输入框）
  const setView = useUiStore((s) => s.setView);
  const requestComposerFocus = useUiStore((s) => s.requestComposerFocus);

  // ticket #27：任务用量 chip 聚合（挂载 + 任务行变更广播时重拉；turn_end 实时刷新在 usage store）
  const usageTotals = useUsageStore((s) => s.totals);
  const refreshUsageTotals = useUsageStore((s) => s.refreshTotals);
  useEffect(() => {
    void refreshUsageTotals();
    const api = window.openCowork;
    if (!api) return;
    return api.onTasksChanged(() => {
      void refreshUsageTotals();
    });
  }, [refreshUsageTotals]);

  return (
    <div className="tree-section">
      {/* 功能行（§1.3 第一段）：新建任务 icon + 文字行——
          ticket #36：表单退场，点击聚焦首页 composer（创建内联化入口） */}
      <button
        type="button"
        className="tree-action"
        data-testid="new-task-toggle"
        onClick={() => {
          setView('document');
          setCurrentTaskId(null);
          requestComposerFocus();
        }}
      >
        <span className="tree-action-icon" aria-hidden="true">
          ＋
        </span>
        新建任务
      </button>

      {/* 任务树（§1.3 第二段）：按 workspace 分组，任务缩进其下 */}
      {workspaces.length === 0 ? (
        <div className="empty-state">{loaded ? '尚未添加 workspace' : '加载中…'}</div>
      ) : (
        <ul className="ws-tree">
          {workspaces.map((w) => {
            const wsTasks = tasks.filter((t) => t.workspace_id === w.id);
            const collapsed = wsCollapsed[w.id] === true;
            return (
              <li key={w.id} className="ws-group">
                <div className="ws-row" data-testid="workspace-item">
                  <button
                    type="button"
                    className="ws-toggle"
                    data-testid="workspace-toggle"
                    aria-expanded={!collapsed}
                    title={w.path}
                    onClick={() => toggleSidebarWorkspace(w.id)}
                  >
                    <span className="ws-chevron" aria-hidden="true">
                      {collapsed ? '▸' : '▾'}
                    </span>
                    <span className="ws-icon">
                      <FolderIcon />
                    </span>
                    <span className="ws-name">{w.name}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn ws-remove"
                    data-testid="workspace-remove"
                    title={`移除 workspace「${w.name}」（其下任务一并删除）`}
                    onClick={() => void removeWorkspace(w.id)}
                  >
                    ×
                  </button>
                </div>
                {!collapsed &&
                  (wsTasks.length === 0 ? (
                    <div className="ws-empty muted">暂无任务</div>
                  ) : (
                    <ul className="task-list">
                      {wsTasks.map((t) => (
                        <li key={t.id}>
                          <button
                            type="button"
                            className="task-item"
                            data-testid="task-item"
                            data-status={t.status}
                            aria-current={t.id === currentTaskId ? 'true' : undefined}
                            onClick={() => setCurrentTaskId(t.id === currentTaskId ? null : t.id)}
                          >
                            <span className={statusDotClass(t.status)} data-testid="task-status-dot" />
                            <span className="task-text">
                              <span className="task-title">{t.title}</span>
                              <span className="task-meta">
                                {agentLabel(t.agent_type)} · {STATUS_LABELS[t.status]}
                                {/* ticket #25 数据已具备：worktree 任务带分支徽标 */}
                                {t.use_worktree === 1 && (
                                  <span
                                    className="task-branch-badge"
                                    data-testid="task-branch-badge"
                                    title="worktree 隔离分支"
                                  >
                                    {branchBadgeLabel(t)}
                                  </span>
                                )}
                              </span>
                              {usageTotals[t.id] && usageTotals[t.id].records > 0 && (
                                <span
                                  className="task-usage"
                                  data-testid="task-usage-chip"
                                  title={describeTaskUsageTitle(usageTotals[t.id])}
                                >
                                  {describeTaskUsage(usageTotals[t.id])}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ))}
              </li>
            );
          })}
        </ul>
      )}

      {/* 「添加 workspace」入口收进分组区底部（§1.3） */}
      <button
        type="button"
        className="icon-btn tree-add"
        data-testid="add-workspace"
        onClick={() => void addWorkspaceViaDialog()}
      >
        添加 Workspace…
      </button>
    </div>
  );
}

const def: SidebarSectionDef = {
  id: 'project-tree',
  title: '', // 无标题裸区块（§1.3：功能行 + 任务树，无多余分组装饰）
  order: 5, // agent-banner=1 之后；原 workspaces=5 / tasks=10 合并为本区块
  component: ProjectTreeSection,
};

export default def;
