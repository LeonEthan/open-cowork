import { useEffect, useState } from 'react';
import { STATUS_LABELS, agentLabel, statusDotClass } from '../../lib/taskStatus';
import { AgentPicker } from '../../components/pickers/AgentPicker';
import { ProviderModelPicker } from '../../components/pickers/ProviderModelPicker';
import { useAppStore } from '../../stores/appStore';
import { useDataStore } from '../../stores/data';
import { useUsageStore } from '../../stores/usage';
import { describeTaskUsage, describeTaskUsageTitle } from '../../../../shared/usageFormat';
import type { SidebarSectionDef } from '../registry';

/**
 * 内置「任务」侧栏区块（ticket #18 实装，DESIGN.md §1）：
 * 任务项 = 状态点（六态，语义 token；仅 running pulse）+ 标题 + 元信息。
 * 顶部「新建任务」表单：需求描述 textarea + agent/provider/model picker
 * （agent picker 探测置灰 ticket #22；provider/model picker #21 实化，
 *  选择落库 task.provider_id/model）。
 * ticket #27：任务项第三行 = 用量汇总 chip（token 总量 + 折算金额，灰阶小字，
 * 口径全在 tooltip；无用量记录不渲染）。
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

  // 表单打开期间 workspace 列表变化（如刚添加第一个）时回填默认选择
  useEffect(() => {
    if (!workspaces.some((w) => w.id === workspaceId)) {
      setWorkspaceId(workspaces[0]?.id ?? '');
    }
  }, [workspaces, workspaceId]);

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
