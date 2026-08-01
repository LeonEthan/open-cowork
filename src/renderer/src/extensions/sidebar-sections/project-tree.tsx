import { useEffect, useState } from 'react';
import type { TaskListItem, WorkspaceWorktreeInfo } from '../../../../shared/api';
import { STATUS_LABELS, agentLabel, statusDotClass } from '../../lib/taskStatus';
import { AgentPicker } from '../../components/pickers/AgentPicker';
import { ProviderModelPicker } from '../../components/pickers/ProviderModelPicker';
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
 * 1. 功能行：「新建任务」icon + 文字行（data-testid="new-task-toggle" 保留；
 *    点击打开现行表单——composer 票 #36 落地前的过渡形态，届时改为聚焦中区 composer）。
 * 2. 任务树：按 workspace 分组——workspace 行（折叠 chevron + 文件夹 icon + 名称，
 *    可展开/折叠，默认展开，折叠态经 ui store 持久化记忆）+ 任务行缩进其下
 *    （状态点 + 标题 + 元信息保留；use_worktree=1 的任务带分支徽标，#25 数据已具备）。
 *    workspace 行 hover 露出管理操作（移除，级联删任务）。
 *    「添加 workspace」入口收在分组区底部。
 *
 * 行选中/hover 样式见 app.css ticket #35 分组（§2 --bg-pill / §4 侧栏行约定）。
 * testid 保留纪律：new-task-toggle / new-task-form / task-* 表单件 / task-item /
 * task-status-dot / task-usage-chip / workspace-item / workspace-remove / add-workspace
 * 全部保留在对应元素上，其余 spec（agent-conversation/approval-flow 等）不受牵连。
 */

function NewTaskForm(props: { onDone: () => void }): React.JSX.Element {
  const workspaces = useDataStore((s) => s.workspaces);
  const createTask = useDataStore((s) => s.createTask);
  const lastError = useDataStore((s) => s.lastError);

  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [agentType, setAgentType] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // ── ticket #25：worktree 隔离 opt-in（仅 git workspace 可选；非 git 置灰提示） ──
  const [useWorktree, setUseWorktree] = useState(false);
  const [wtInfo, setWtInfo] = useState<WorkspaceWorktreeInfo | null>(null);
  // ── ticket #25 end ──

  // 表单打开期间 workspace 列表变化（如刚添加第一个）时回填默认选择
  useEffect(() => {
    if (!workspaces.some((w) => w.id === workspaceId)) {
      setWorkspaceId(workspaces[0]?.id ?? '');
    }
  }, [workspaces, workspaceId]);

  // ── ticket #25：选中 workspace 变化 → 探测 worktree 可用性；不可用时收回勾选 ──
  useEffect(() => {
    const api = window.openCowork;
    if (!api || workspaceId.length === 0) {
      setWtInfo(null);
      setUseWorktree(false);
      return;
    }
    let cancelled = false;
    void api.worktree.workspaceCheck(workspaceId).then((info) => {
      if (cancelled) return;
      setWtInfo(info);
      if (!info.isGitRepo || !info.hasCommits) setUseWorktree(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  // ── ticket #25 end ──

  const canSubmit =
    workspaceId.length > 0 && prompt.trim().length > 0 && agentType.length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    const task = await createTask({
      workspaceId,
      prompt,
      agentType,
      providerId: providerId || null,
      model: model || null,
      // ── ticket #25：勾选且可用才下发（防御置灰态的脏勾选） ──
      useWorktree: useWorktree && wtInfo?.isGitRepo === true && wtInfo.hasCommits,
    });
    setSubmitting(false);
    if (task) props.onDone();
  };

  return (
    <form
      className="task-form"
      data-testid="new-task-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {workspaces.length === 0 && (
        <p className="muted">请先在下方「添加 Workspace…」加入一个本地目录。</p>
      )}
      <label className="field">
        <span className="field-label">Workspace</span>
        <select
          data-testid="task-workspace-select"
          value={workspaceId}
          disabled={workspaces.length === 0}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          {workspaces.length === 0 && <option value="">（无可用 workspace）</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">需求描述</span>
        <textarea
          data-testid="task-prompt-input"
          rows={4}
          placeholder="描述这个任务要做什么…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <AgentPicker value={agentType} onChange={setAgentType} />
      <ProviderModelPicker
        providerId={providerId}
        model={model}
        onProviderChange={setProviderId}
        onModelChange={setModel}
      />
      {/* ── ticket #25：worktree 隔离勾选（git workspace 可选；非 git/无提交置灰提示） ── */}
      <label className="field">
        <span className="worktree-check-row">
          <input
            type="checkbox"
            data-testid="task-worktree-checkbox"
            checked={useWorktree}
            disabled={!wtInfo || !wtInfo.isGitRepo || !wtInfo.hasCommits}
            onChange={(e) => setUseWorktree(e.target.checked)}
          />
          <span className="field-label">worktree 隔离</span>
        </span>
        <span className="muted worktree-hint" data-testid="task-worktree-hint">
          {!wtInfo
            ? '检测 workspace 是否为 git 仓库…'
            : !wtInfo.isGitRepo
              ? '仅 git workspace 可用 worktree 隔离（当前目录不在 git 工作树内）'
              : !wtInfo.hasCommits
                ? '仓库尚无提交，请先完成首次提交后再启用 worktree 隔离'
                : useWorktree
                  ? '任务将在独立 worktree 目录运行，原目录零改动；复查后可回流到原目录'
                  : '在独立 worktree 目录运行任务，改动与原目录隔离'}
        </span>
      </label>
      {/* ── ticket #25 end ── */}
      {lastError && (
        <p className="form-error" role="alert" data-testid="task-form-error">
          {lastError}
        </p>
      )}
      <div className="task-form-actions">
        <button
          type="submit"
          className="icon-btn"
          data-testid="task-create-submit"
          disabled={!canSubmit}
        >
          {submitting ? '创建中…' : '创建任务'}
        </button>
        <button type="button" className="icon-btn" onClick={props.onDone}>
          取消
        </button>
      </div>
    </form>
  );
}

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
  const [creating, setCreating] = useState(false);

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
      {/* 功能行（§1.3 第一段）：新建任务 icon + 文字行；点击打开现行表单（#36 前过渡形态） */}
      {creating ? (
        <NewTaskForm onDone={() => setCreating(false)} />
      ) : (
        <button
          type="button"
          className="tree-action"
          data-testid="new-task-toggle"
          onClick={() => setCreating(true)}
        >
          <span className="tree-action-icon" aria-hidden="true">
            ＋
          </span>
          新建任务
        </button>
      )}

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
