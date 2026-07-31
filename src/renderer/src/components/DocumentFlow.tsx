import { useEffect, useRef, useState } from 'react';
import { settingsSections } from '../extensions/registry';
import { STATUS_LABELS, agentLabel, statusDotClass } from '../lib/taskStatus';
import { useAppStore } from '../stores/appStore';
import { useConversationStore } from '../stores/conversation';
import type { ConversationItem } from '../stores/conversation';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import type { TaskListItem } from '../../../shared/api';
import { Markdown } from './Markdown';

/**
 * 内容栏（文档流，§1 的主角）：max-width 860px 居中。
 * - 设置视图：区块经 extensions/settings-sections/ 自动注册；
 * - 选中任务（ticket #19）：文档式会话流——用户消息、agent markdown 流式回复、
 *   工具调用极简行（icon + 名称 + 目标 + 状态，§4）、思考过程左边线折叠（§4）、
 *   failed 态原因 + 重试；底部输入区：单圆角框 + agent/model chip + 发送/取消键；
 * - 未选中任务：保持空态（文案克制，§7）。
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
          <TaskConversationView key={task.id} task={task} />
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

// ── 会话视图 ─────────────────────────────────────────────────────────────

function TaskConversationView({ task }: { task: TaskListItem }): React.JSX.Element {
  const conversation = useConversationStore((s) => s.byTask[task.id]);
  const applyHistory = useConversationStore((s) => s.applyHistory);
  const themeMode = useUiStore((s) => s.themeMode);

  // 选中任务：从 main 重拉历史基线（实时端口负责增量；key=task.id 切换时重挂本组件）
  useEffect(() => {
    const api = window.openCowork;
    if (!api) return;
    let alive = true;
    void api.agent.history(task.id).then((h) => {
      if (alive) applyHistory(task.id, h);
    });
    return () => {
      alive = false;
    };
  }, [task.id, applyHistory]);

  const items = conversation?.items ?? [];
  // ready 态预览：首轮未跑前把创建时的需求描述呈现为首条用户消息（开跑后由落库消息接管）
  const displayItems: ConversationItem[] =
    items.length === 0 && task.status === 'ready' ? [{ kind: 'user', text: task.prompt }] : items;

  // 自动吸底：新增条目/流式增长时，若视口本在底部附近则跟随
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = endRef.current?.closest('.content');
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) endRef.current?.scrollIntoView({ block: 'end' });
  }, [displayItems]);

  const themeKey = `${themeMode}:${document.documentElement.dataset.theme ?? ''}`;

  return (
    <article data-testid="current-task">
      <h1 className="doc-title">{task.title}</h1>
      <p className="task-detail-status">
        <span className={statusDotClass(task.status)} data-testid="detail-status-dot" />
        <span data-testid="detail-status-label">{STATUS_LABELS[task.status]}</span>
        <span className="muted">
          · {task.workspace_name} · {agentLabel(task.agent_type)}
          {task.model ? ` · ${task.model}` : ''}
        </span>
      </p>

      {task.status === 'failed' && <FailedBanner task={task} />}

      <div className="conversation" data-testid="conversation">
        {displayItems.length === 0 && (
          <p className="muted">（尚无对话——点击下方「开始」让 agent 开跑。）</p>
        )}
        {displayItems.map((item, i) => (
          <ConversationItemView key={i} item={item} themeKey={themeKey} />
        ))}
        <div ref={endRef} />
      </div>

      <Composer task={task} />
    </article>
  );
}

// ── 时间线条目 ───────────────────────────────────────────────────────────

function ConversationItemView(props: { item: ConversationItem; themeKey: string }): React.JSX.Element {
  const { item } = props;
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg msg-user" data-testid="msg-user">
          <Markdown text={item.text} themeKey={props.themeKey} />
        </div>
      );
    case 'text':
      return (
        <div className="msg msg-assistant" data-testid="msg-assistant">
          <Markdown text={item.text} themeKey={props.themeKey} />
          {item.streaming && <span className="stream-cursor" data-testid="stream-cursor" />}
        </div>
      );
    case 'thinking':
      return (
        <details className="thinking" data-testid="msg-thinking">
          <summary>思考过程{item.streaming ? '…' : ''}</summary>
          <div className="thinking-body">
            <Markdown text={item.text} themeKey={props.themeKey} />
          </div>
        </details>
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'permission':
      return <PermissionRow item={item} />;
    case 'error':
      return (
        <p className="msg-error" data-testid="msg-error" role="alert">
          {item.message}
        </p>
      );
    default:
      return <></>;
  }
}

/** 工具调用极简行（§4：icon + 名称 + 目标 + 状态；禁止大卡片） */
function ToolRow({ item }: { item: Extract<ConversationItem, { kind: 'tool' }> }): React.JSX.Element {
  const { call } = item;
  const statusIcon =
    call.status === 'running' ? '●' : call.status === 'done' ? '✓' : '✗';
  const statusLabel =
    call.status === 'running' ? '运行中' : call.status === 'done' ? '完成' : '出错';
  return (
    <div className={`tool-row ${call.status}`} data-testid="tool-row" data-status={call.status}>
      <span className={`tool-icon ${call.status}`} aria-hidden>
        {statusIcon}
      </span>
      <span className="tool-name">{call.name}</span>
      {call.target && <span className="tool-target mono">{call.target}</span>}
      <span className={`tool-status ${call.status}`}>{statusLabel}</span>
    </div>
  );
}

/** 审批行（本票为全允许桩的即时回执呈现；托盘交互是 #20 的范围） */
function PermissionRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'permission' }>;
}): React.JSX.Element {
  const { request, decision } = item;
  const decided = decision !== null;
  const allowed = decision?.behavior === 'allow';
  return (
    <div className="tool-row permission-row" data-testid="permission-row">
      <span className={`tool-icon ${decided ? (allowed ? 'done' : 'error') : 'running'}`} aria-hidden>
        {decided ? (allowed ? '✓' : '✗') : '●'}
      </span>
      <span className="tool-name">权限</span>
      <span className="tool-target mono">
        {request.toolName}
        {request.target ? `: ${request.target}` : ''}
      </span>
      <span className={`tool-status ${decided ? (allowed ? 'done' : 'error') : 'running'}`}>
        {decided ? (allowed ? '已允许' : '已拒绝') : '待审批'}
      </span>
    </div>
  );
}

// ── failed 态 ────────────────────────────────────────────────────────────

function FailedBanner({ task }: { task: TaskListItem }): React.JSX.Element {
  const refreshAll = useDataStore((s) => s.refreshAll);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const retry = async (): Promise<void> => {
    const api = window.openCowork;
    if (!api || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.tasks.updateStatus(task.id, 'ready'); // failed → ready（重试）
      await refreshAll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="failed-banner" data-testid="failed-banner" role="alert">
      <p className="failed-reason">任务失败：{task.fail_reason ?? '未知原因'}</p>
      <div className="failed-actions">
        <button type="button" className="icon-btn" data-testid="retry-button" disabled={busy} onClick={() => void retry()}>
          {busy ? '重置中…' : '重试'}
        </button>
      </div>
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}

// ── 输入区 ───────────────────────────────────────────────────────────────

function Composer({ task }: { task: TaskListItem }): React.JSX.Element {
  const appendUserMessage = useConversationStore((s) => s.appendUserMessage);
  const refreshAll = useDataStore((s) => s.refreshAll);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const status = task.status;
  const canType = status === 'awaiting_review';
  const canStart = status === 'ready';
  const running = status === 'running';

  const send = async (): Promise<void> => {
    const api = window.openCowork;
    if (!api || busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (canStart) {
        await api.agent.start(task.id);
        appendUserMessage(task.id, task.prompt); // 乐观呈现；main 侧已落库
      } else if (canType && text.trim().length > 0) {
        await api.agent.followup(task.id, text.trim());
        appendUserMessage(task.id, text.trim());
        setText('');
      }
      await refreshAll(); // 状态迁移（→running）立即反映到侧栏/状态行
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    const api = window.openCowork;
    if (!api || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.agent.cancel(task.id);
      await refreshAll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendDisabled =
    busy || (canStart ? false : canType ? text.trim().length === 0 : true);
  const placeholder =
    status === 'ready'
      ? '首轮将以创建时的需求描述开跑'
      : running
        ? 'agent 运行中…'
        : status === 'awaiting_review'
          ? '追问…（Enter 发送，Shift+Enter 换行）'
          : status === 'failed'
            ? '任务已失败——先点上方「重试」'
            : '任务已结束';

  return (
    <div className="composer" data-testid="composer">
      <div className="composer-box">
        <div className="composer-chips">
          <span className="chip" data-testid="composer-agent-chip">
            {agentLabel(task.agent_type)}
          </span>
          {task.model && (
            <span className="chip" data-testid="composer-model-chip">
              {task.model}
            </span>
          )}
        </div>
        <textarea
          className="composer-input"
          data-testid="composer-input"
          rows={3}
          placeholder={placeholder}
          value={text}
          disabled={!canType || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && canType) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          {running ? (
            <button
              type="button"
              className="icon-btn"
              data-testid="cancel-button"
              disabled={busy}
              onClick={() => void cancel()}
            >
              {busy ? '取消中…' : '取消'}
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              data-testid="send-button"
              disabled={sendDisabled}
              onClick={() => void send()}
            >
              {busy ? '发送中…' : canStart ? '开始' : '发送'}
            </button>
          )}
        </div>
      </div>
      {err && (
        <p className="form-error" role="alert" data-testid="composer-error">
          {err}
        </p>
      )}
    </div>
  );
}
