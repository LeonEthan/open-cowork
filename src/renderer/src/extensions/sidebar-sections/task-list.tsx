import { useEffect, useState } from 'react';
import { AGENT_OPTIONS, STATUS_LABELS, agentLabel, statusDotClass } from '../../lib/taskStatus';
import { useAppStore } from '../../stores/appStore';
import { useDataStore } from '../../stores/data';
import type { SidebarSectionDef } from '../registry';

/**
 * 内置「任务」侧栏区块（ticket #18 实装，DESIGN.md §1）：
 * 任务项 = 状态点（六态，语义 token；仅 running pulse）+ 标题 + 元信息。
 * 顶部「新建任务」表单：需求描述 textarea + agent/provider/model 占位 picker。
 */

// ── 静态占位 picker 数据：真实 provider/model 目录由 #19/#21/#26 注水替换 ──
const PROVIDER_OPTIONS = [{ value: '', label: '默认 provider（占位 · #21 接入）' }] as const;
const MODEL_OPTIONS = [{ value: '', label: '默认 model（占位 · #21/#26 接入）' }] as const;

function NewTaskForm(props: { onDone: () => void }): React.JSX.Element {
  const workspaces = useDataStore((s) => s.workspaces);
  const createTask = useDataStore((s) => s.createTask);
  const lastError = useDataStore((s) => s.lastError);

  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [agentType, setAgentType] = useState(AGENT_OPTIONS[0].value);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 表单打开期间 workspace 列表变化（如刚添加第一个）时回填默认选择
  useEffect(() => {
    if (!workspaces.some((w) => w.id === workspaceId)) {
      setWorkspaceId(workspaces[0]?.id ?? '');
    }
  }, [workspaces, workspaceId]);

  const canSubmit = workspaceId.length > 0 && prompt.trim().length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    const task = await createTask({
      workspaceId,
      prompt,
      agentType,
      providerId: providerId || null,
      model: model || null,
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
      <label className="field">
        <span className="field-label">Agent</span>
        <select
          data-testid="task-agent-select"
          value={agentType}
          onChange={(e) => setAgentType(e.target.value)}
        >
          {AGENT_OPTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Provider</span>
        <select
          data-testid="task-provider-select"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Model</span>
        <select
          data-testid="task-model-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
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
