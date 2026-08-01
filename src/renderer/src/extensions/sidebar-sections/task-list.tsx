import { useEffect, useState } from 'react';
import type { WorkspaceWorktreeInfo } from '../../../../shared/api';
import { STATUS_LABELS, agentLabel, statusDotClass } from '../../lib/taskStatus';
import { AgentPicker } from '../../components/pickers/AgentPicker';
import { ProviderModelPicker } from '../../components/pickers/ProviderModelPicker';
import { useAppStore } from '../../stores/appStore';
import { useDataStore } from '../../stores/data';
import type { SidebarSectionDef } from '../registry';
import '../../styles/worktree.css';

/**
 * 内置「任务」侧栏区块（ticket #18 实装，DESIGN.md §1）：
 * 任务项 = 状态点（六态，语义 token；仅 running pulse）+ 标题 + 元信息。
 * 顶部「新建任务」表单：需求描述 textarea + agent/provider/model picker
 * （agent picker 探测置灰 ticket #22；provider/model picker #21 实化，
 *  选择落库 task.provider_id/model）。
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
        <p className="muted">请先在上方的 Workspace 区块添加一个本地目录。</p>
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

function TaskListSection(): React.JSX.Element {
  const tasks = useDataStore((s) => s.tasks);
  const loaded = useDataStore((s) => s.loaded);
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);
  const [creating, setCreating] = useState(false);

  return (
    <div className="task-section">
      {creating ? (
        <NewTaskForm onDone={() => setCreating(false)} />
      ) : (
        <button
          type="button"
          className="icon-btn"
          data-testid="new-task-toggle"
          onClick={() => setCreating(true)}
        >
          新建任务
        </button>
      )}
      {tasks.length === 0 ? (
        <div className="empty-state">{loaded ? '暂无任务' : '加载中…'}</div>
      ) : (
        <ul className="task-list">
          {tasks.map((t) => (
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
                    {t.workspace_name} · {agentLabel(t.agent_type)} · {STATUS_LABELS[t.status]}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const def: SidebarSectionDef = {
  id: 'tasks',
  title: '任务',
  order: 10,
  component: TaskListSection,
};

export default def;
