import { settingsSections } from '../extensions/registry';
import { STATUS_LABELS, agentLabel, statusDotClass } from '../lib/taskStatus';
import { useAppStore } from '../stores/appStore';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';

/**
 * 内容栏（文档流，§1 的主角）：max-width 860px 居中。
 * - 设置视图：区块经 extensions/settings-sections/ 自动注册；
 * - 选中任务（ticket #18）：显示该任务的需求描述与状态占位
 *   （agent 运行接入由 #19 交付，届时对话事件流渲染于此）；
 * - 未选中任务：保持空态（文案克制，§7：无营销性/装饰性元素）。
 */
export function DocumentFlow(): React.JSX.Element {
  const view = useUiStore((s) => s.view);
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const tasks = useDataStore((s) => s.tasks);
  const task = currentTaskId ? (tasks.find((t) => t.id === currentTaskId) ?? null) : null;

  return (
    <main className="content" data-testid="document-flow">
      <div className="content-inner">
        {view === 'settings' ? (
          <>
            <h1 className="doc-title">设置</h1>
            {settingsSections.map((s) => (
              <s.component key={s.id} />
            ))}
            {settingsSections.length === 0 && <p className="muted">（无已注册设置区块）</p>}
          </>
        ) : task ? (
          <article data-testid="current-task">
            <h1 className="doc-title">{task.title}</h1>
            <p className="task-detail-status">
              <span className={statusDotClass(task.status)} />
              <span>{STATUS_LABELS[task.status]}</span>
              <span className="muted">
                · {task.workspace_name} · {agentLabel(task.agent_type)}
                {task.model ? ` · ${task.model}` : ''}
              </span>
            </p>
            <h2 className="pane-title">需求描述</h2>
            <p className="task-prompt" data-testid="current-task-prompt">
              {task.prompt}
            </p>
            <p className="muted">（任务尚未运行——agent 接入后，对话将以文档流呈现在这里。）</p>
          </article>
        ) : (
          <>
            <h1 className="doc-title">开始</h1>
            <p className="muted">还没有进行中的任务。</p>
            <p className="muted">创建任务后，对话将以文档流呈现在这里。</p>
          </>
        )}
      </div>
    </main>
  );
}
