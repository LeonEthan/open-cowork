import { useEffect, useState } from 'react';
import type { TaskListItem } from '../../../../shared/api';
import { STATUS_LABELS, agentLabel, statusDotClass } from '../../lib/taskStatus';
import { useAppStore } from '../../stores/appStore';
import { useDataStore } from '../../stores/data';
import { useUiStore } from '../../stores/ui';
import { useUsageStore } from '../../stores/usage';
import { describeTaskUsageShort, describeTaskUsageTitle } from '../../../../shared/usageFormat';
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
 * 3. 二期 Pinned（DESIGN.md 附录 A 延期项落地）：任务树顶部增设「置顶」分组——
 *    pinned=1 的任务从原 workspace 分组升入本组（不重复出现），元信息补 workspace 名；
 *    分组同样可折叠（复用 sidebarWsCollapsed，保留字 '$pinned'）。
 *    置顶开关为任务行 hover 露出的 icon 按钮（与 ws-remove 同约定），
 *    pinned 态常显（aria-pressed + accent，§2 白名单色）。
 *
 * 行选中/hover 样式见 app.css ticket #35 分组（§2 --bg-pill / §4 侧栏行约定）。
 * testid 保留纪律：new-task-toggle / task-item / task-status-dot / task-usage-chip /
 * workspace-item / workspace-remove / add-workspace 全部保留在对应元素上；
 * 二期新增 testid：pinned-group / pinned-toggle / task-pin-toggle。
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

/** 图钉 icon（置顶分组行 + 任务行置顶开关；inline SVG，currentColor，无装饰色） */
function PinIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 1.5 14.5 6.5l-2 .5-2.5 1-1 2.5-.5 2L6 10 2.5 13.5 6 10 3.5 7.5l2-.5 2.5-1 1-2.5.5-2Z"
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

/** 置顶分组在 sidebarWsCollapsed 中的保留 key（不可能与 workspace uuid 冲突） */
const PINNED_GROUP_KEY = '$pinned';

/**
 * 任务行（置顶分组与 workspace 分组共用）：
 * 状态点 + 标题 + 元信息（置顶组内补 workspace 名——脱离树上下文后的归属标注）+
 * 用量 chip + hover 露出的置顶开关。
 */
function TaskRow({
  t,
  showWorkspace,
  testid = 'task-item',
}: {
  t: TaskListItem;
  showWorkspace?: boolean;
  /** Recents 分组传 'recent-item'——同一任务在树分组与 Recents 并存时 testid 面不重复（e2e 计数纪律） */
  testid?: string;
}): React.JSX.Element {
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);
  const setCurrentWorkspaceId = useAppStore((s) => s.setCurrentWorkspaceId);
  const toggleTaskPinned = useDataStore((s) => s.toggleTaskPinned);
  const usage = useUsageStore((s) => s.totals[t.id]);
  const pinned = t.pinned === 1;
  // Recents 行（testid=recent-item）内部 testid 同步换 recent- 前缀——
  // 同一任务在树分组与 Recents 并存，e2e strict 模式不允许重复解析
  const tid = testid === 'task-item' ? 'task' : 'recent';

  return (
    <li className="task-row">
      <button
        type="button"
        className="task-item"
        data-testid={testid}
        data-status={t.status}
        aria-current={t.id === currentTaskId ? 'true' : undefined}
        onClick={() => {
          const next = t.id === currentTaskId ? null : t.id;
          setCurrentTaskId(next);
          // Codex 对齐（附录 B）：选中任务即选中其 workspace——侧栏 pill 与首页 hero 跟随
          if (next !== null) setCurrentWorkspaceId(t.workspace_id);
        }}
      >
        <span className={statusDotClass(t.status)} data-testid={`${tid}-status-dot`} />
        <span className="task-text">
          {/* 附录 B 审计 P0：行高 3→2——用量 chip 挪 title 行右端（Codex recents「2h ago」位），
              meta 一行收口（ws · agent · 状态 · 分支徽标） */}
          <span className="task-title-row">
            <span className="task-title">{t.title}</span>
            {usage && usage.records > 0 && (
              <span className="task-usage" data-testid={`${tid}-usage-chip`} title={describeTaskUsageTitle(usage)}>
                {describeTaskUsageShort(usage)}
              </span>
            )}
          </span>
          <span className="task-meta">
            {showWorkspace === true && <>{t.workspace_name} · </>}
            {agentLabel(t.agent_type)} · {STATUS_LABELS[t.status]}
            {/* ticket #25 数据已具备：worktree 任务带分支徽标 */}
            {t.use_worktree === 1 && (
              <span
                className="task-branch-badge"
                data-testid={`${tid}-branch-badge`}
                title="worktree 隔离分支"
              >
                {branchBadgeLabel(t)}
              </span>
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="icon-btn task-pin"
        data-testid={`${tid}-pin-toggle`}
        aria-pressed={pinned}
        title={pinned ? `取消置顶「${t.title}」` : `置顶「${t.title}」`}
        onClick={() => void toggleTaskPinned(t)}
      >
        <PinIcon />
      </button>
    </li>
  );
}

function ProjectTreeSection(): React.JSX.Element {
  const workspaces = useDataStore((s) => s.workspaces);
  const tasks = useDataStore((s) => s.tasks);
  const loaded = useDataStore((s) => s.loaded);
  const addWorkspaceViaDialog = useDataStore((s) => s.addWorkspaceViaDialog);
  const removeWorkspace = useDataStore((s) => s.removeWorkspace);
  const wsCollapsed = useUiStore((s) => s.sidebarWsCollapsed);
  const toggleSidebarWorkspace = useUiStore((s) => s.toggleSidebarWorkspace);
  // ticket #36：功能行聚焦中区 composer（回文档视图 + 取消任务选中 + 聚焦输入框）
  const setView = useUiStore((s) => s.setView);
  const requestComposerFocus = useUiStore((s) => s.requestComposerFocus);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);
  // Codex 对齐改造（附录 B）：workspace 行选中态 + 搜索过滤 + Recents 分组
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  const setCurrentWorkspaceId = useAppStore((s) => s.setCurrentWorkspaceId);
  const query = useUiStore((s) => s.sidebarQuery).trim().toLowerCase();
  const [recentsExpanded, setRecentsExpanded] = useState(false);

  // ticket #27：任务用量 chip 聚合（挂载 + 任务行变更广播时重拉；turn_end 实时刷新在 usage store）
  const refreshUsageTotals = useUsageStore((s) => s.refreshTotals);
  useEffect(() => {
    void refreshUsageTotals();
    const api = window.openCowork;
    if (!api) return;
    return api.onTasksChanged(() => {
      void refreshUsageTotals();
    });
  }, [refreshUsageTotals]);

  // 二期 Pinned：置顶任务升入任务树顶部分组，不再重复出现于原 workspace 分组
  // Codex 对齐（附录 B）：搜索过滤（任务标题 / workspace 名，大小写不敏感）；
  // 过滤期间强制展开分组并隐藏零命中分组
  const matchTask = (t: TaskListItem): boolean =>
    query.length === 0 ||
    t.title.toLowerCase().includes(query) ||
    t.workspace_name.toLowerCase().includes(query);
  const visibleTasks = query.length === 0 ? tasks : tasks.filter(matchTask);
  const pinnedTasks = visibleTasks.filter((t) => t.pinned === 1);
  const pinnedCollapsed = query.length === 0 && wsCollapsed[PINNED_GROUP_KEY] === true;

  // Recents 分组（§1.3 第 3 段）：跨 workspace 平铺，按更新时间倒序，默认 5 条
  const recents = [...visibleTasks].sort((a, b) => b.updated_at - a.updated_at);
  const recentShown = recents.slice(0, recentsExpanded ? 20 : 5);

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

      {/* 任务树（§1.3 第二段）：置顶分组（二期）+ 按 workspace 分组，任务缩进其下 */}
      {workspaces.length === 0 ? (
        <div className="empty-state">{loaded ? '尚未添加 workspace' : '加载中…'}</div>
      ) : (
        <ul className="ws-tree">
          {pinnedTasks.length > 0 && (
            <li className="ws-group" data-testid="pinned-group">
              {/* Codex 对齐（附录 B 视觉复核）：分组头 = 小灰标签（保留点击折叠） */}
              <button
                type="button"
                className="tree-label"
                data-testid="pinned-toggle"
                aria-expanded={!pinnedCollapsed}
                onClick={() => toggleSidebarWorkspace(PINNED_GROUP_KEY)}
              >
                置顶
              </button>
              {!pinnedCollapsed && (
                <ul className="task-list">
                  {pinnedTasks.map((t) => (
                    <TaskRow key={t.id} t={t} showWorkspace />
                  ))}
                </ul>
              )}
            </li>
          )}
          {/* Codex 对齐（附录 B 视觉复核）：项目分组小灰标签 */}
          <h3 className="tree-label" data-testid="projects-label">
            项目
          </h3>
          {workspaces.map((w) => {
            const wsTasks = visibleTasks.filter((t) => t.workspace_id === w.id && t.pinned !== 1);
            // 过滤期间隐藏零命中分组（过滤串命中 workspace 名时其任务全命中，不会走到这）
            if (query.length > 0 && wsTasks.length === 0) return null;
            const collapsed = query.length === 0 && wsCollapsed[w.id] === true;
            return (
              <li key={w.id} className="ws-group">
                <div className="ws-row" data-testid="workspace-item">
                  {/* Codex 对齐（附录 B 视觉复核）：行无 chevron 装饰——单击 = 选中
                      （pill 高亮 + 首页 hero 跟随）并切换折叠，与原 Codex 项目行同交互 */}
                  <button
                    type="button"
                    className="ws-toggle"
                    data-testid="workspace-toggle"
                    aria-expanded={!collapsed}
                    aria-current={w.id === currentWorkspaceId ? 'true' : undefined}
                    title={w.path}
                    onClick={() => {
                      setCurrentWorkspaceId(w.id);
                      setCurrentTaskId(null);
                      setView('document');
                      toggleSidebarWorkspace(w.id);
                    }}
                  >
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
                        <TaskRow key={t.id} t={t} />
                      ))}
                    </ul>
                  ))}
              </li>
            );
          })}
        </ul>
      )}

      {/* Recents 分组（§1.3 第 3 段；Codex 对齐附录 B）：跨 workspace 最近任务平铺 */}
      {recents.length > 0 && (
        <div className="recents-group" data-testid="recents-group">
          <h3 className="tree-label">最近</h3>
          <ul className="task-list">
            {recentShown.map((t) => (
              <TaskRow key={t.id} t={t} showWorkspace testid="recent-item" />
            ))}
          </ul>
          {recents.length > 5 && (
            <button
              type="button"
              className="icon-btn recents-more"
              data-testid="recents-more"
              onClick={() => setRecentsExpanded((v) => !v)}
            >
              {recentsExpanded ? '收起' : `显示更多（${recents.length}）`}
            </button>
          )}
        </div>
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
