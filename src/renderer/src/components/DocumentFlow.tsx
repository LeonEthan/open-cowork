import { useEffect, useRef, useState, Fragment } from 'react';
import { settingsSections } from '../extensions/registry';
import { agentLabel } from '../lib/taskStatus';
import { diffstatOf, groupByTurn, matchGroupTurns } from '../lib/turnGroups';
import { useAppStore } from '../stores/appStore';
import { useChangesStore } from '../stores/changes';
import { useConversationStore } from '../stores/conversation';
import type { ConversationItem } from '../stores/conversation';
import { useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { useUsageStore } from '../stores/usage';
import { describeTurnUsage, describeTurnUsageTitle } from '../../../shared/usageFormat';
import type { FileChange, PermissionMode, TaskListItem } from '../../../shared/api';
import { ApprovalTray } from './ApprovalTray';
import { ContentControls } from './ContentControls';
import { ContextRing } from './ContextRing';
import { HomeView } from './HomeView';
import { Markdown } from './Markdown';
import { PermissionModePicker } from './pickers/PermissionModePicker';
import { TaskHeader } from './TaskHeader';
import { WorkGroupRow } from './WorkGroupRow';

/**
 * 内容栏（文档流，§1 的主角）：max-width 860px 居中。
 * - 设置视图：区块经 extensions/settings-sections/ 自动注册；
 * - 选中任务（ticket #19）：文档式会话流——用户消息、agent markdown 流式回复、
 *   工具调用极简行（icon + 名称 + 目标 + 状态，§4）、思考过程左边线折叠（§4）、
 *   failed 态原因 + 重试；
 * - ticket #27：每轮末尾用量灰字（token + 折算金额，口径在 tooltip）；
 *   动作行末尾 context 水位环（>80% 警告 + 压缩建议）；
 * - ticket #34：内容区右上角检查栏开关（小图标 + ⌘J；变更新内容时带状态点提示）；
 * - ticket #36：composer 升格——审批托盘 + composer 收进底部 sticky dock
 *   （composer = 760px 底部居中悬浮卡片，16px 圆角档、三行结构，§3/§4）；
 *   未选中任务 = 首页空态（hero + starter 卡片 + 创建 composer，见 HomeView）。
 */

export function DocumentFlow(): React.JSX.Element {
  const view = useUiStore((s) => s.view);
  // ticket #33：侧栏折叠时内容区顶到窗口左缘，折叠开关行让位红绿灯（hiddenInset）
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const tasks = useDataStore((s) => s.tasks);
  const task = currentTaskId ? (tasks.find((t) => t.id === currentTaskId) ?? null) : null;

  return (
    <main
      className={`content${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      data-testid="document-flow"
    >
      {/* ticket #33（§1.1）：折叠开关小图标行居内容区左上（设置/文档视图均常驻）；
          ticket #34 检查栏开关同条右端（迁 ContentControls，随 sticky 条常驻不随滚动） */}
      <ContentControls />
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
          // ticket #36：首页空态 = hero + starter 卡片 + 创建 composer（创建内联化）
          <HomeView />
        )}
      </div>
    </main>
  );
}

/** 空变更快照的稳定引用（selector 回退用，防 getSnapshot 缓存破坏） */
const NO_CHANGES: FileChange[] = [];

// ── 会话视图 ─────────────────────────────────────────────────────────────

function TaskConversationView({ task }: { task: TaskListItem }): React.JSX.Element {
  const conversation = useConversationStore((s) => s.byTask[task.id]);
  const applyHistory = useConversationStore((s) => s.applyHistory);
  const loadUsageContext = useUsageStore((s) => s.loadContext);
  const themeMode = useUiStore((s) => s.themeMode);

  // 选中任务：从 main 重拉历史基线（实时端口负责增量；key=task.id 切换时重挂本组件）；
  // ticket #27：同机拉水位环分母与基线已占（usage:context）
  useEffect(() => {
    const api = window.openCowork;
    if (!api) return;
    let alive = true;
    void api.agent.history(task.id).then((h) => {
      if (alive) applyHistory(task.id, h);
    });
    void loadUsageContext(task.id);
    return () => {
      alive = false;
    };
  }, [task.id, applyHistory, loadUsageContext]);

  const items = conversation?.items ?? [];
  // ready 态预览：首轮未跑前把创建时的需求描述呈现为首条用户消息（开跑后由落库消息接管）
  const displayItems: ConversationItem[] =
    items.length === 0 && task.status === 'ready' ? [{ kind: 'user', text: task.prompt }] : items;

  // Codex 对齐（附录 B）：按轮分组——工具/思考/审批行折叠进「工作中/已工作」摘要行；
  // 组 ↔ 轮次元数据配对（时长数据源），live 轮走 conversation 的计时锚点
  const groups = groupByTurn(displayItems);
  const groupTurns = matchGroupTurns(groups, conversation?.turns ?? []);
  // ⚠️ selector 不得就地 ?? []（每次调用新引用 → getSnapshot 缓存破坏，无限重渲染）
  const taskChanges = useChangesStore((s) => s.byTask[task.id]);
  const stat = diffstatOf(taskChanges ?? NO_CHANGES);

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
    <article className="task-article" data-testid="current-task">
      <TaskHeader task={task} />

      {task.status === 'failed' && <FailedBanner task={task} />}

      <div className="conversation" data-testid="conversation">
        {displayItems.length === 0 && (
          <p className="muted">（尚无对话——点击下方「开始」让 agent 开跑。）</p>
        )}
        {groups.map((g, gi) => {
          const isLast = gi === groups.length - 1;
          const active = isLast && (conversation?.turnActive ?? false);
          const gt = groupTurns[gi];
          let startedAt: number | null = null;
          let durationMs: number | null = null;
          if (active) startedAt = gt?.startedAt ?? conversation?.turnStartedAt ?? null;
          else if (gt?.endedAt != null) durationMs = gt.endedAt - gt.startedAt;
          else if (
            isLast &&
            conversation?.turnStartedAt != null &&
            conversation?.turnEndedAt != null
          )
            durationMs = conversation.turnEndedAt - conversation.turnStartedAt;
          return (
            <Fragment key={gi}>
              {g.user && <ConversationItemView item={g.user} themeKey={themeKey} />}
              {g.work.length > 0 && (
                <WorkGroupRow
                  active={active}
                  startedAt={startedAt}
                  durationMs={durationMs}
                  diffstat={isLast && stat.files > 0 ? stat : null}
                  work={g.work}
                >
                  {g.work.map((item, i) => (
                    <ConversationItemView key={i} item={item} themeKey={themeKey} />
                  ))}
                </WorkGroupRow>
              )}
              {g.texts.map((item, i) => (
                <ConversationItemView key={`t${i}`} item={item} themeKey={themeKey} />
              ))}
              {g.usage.map((item, i) => (
                <ConversationItemView key={`u${i}`} item={item} themeKey={themeKey} />
              ))}
              {g.errors.map((item, i) => (
                <ConversationItemView key={`e${i}`} item={item} themeKey={themeKey} />
              ))}
            </Fragment>
          );
        })}
        <div ref={endRef} className="conversation-end" />
      </div>

      {/* ticket #36（§3/§4）：审批托盘 + composer 收进底部 sticky dock——
          托盘保持在 composer 上方（相对位置关系不变），composer 为 760px 悬浮卡片 */}
      <div className="composer-dock">
        <ApprovalTray task={task} />
        <Composer task={task} />
      </div>
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
      return <AssistantMsg item={item} themeKey={props.themeKey} />;
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
    case 'usage':
      return <UsageRow item={item} />;
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

/**
 * assistant 消息（Codex 对齐附录 B）：流式光标语义不变（ticket #37 终审）；
 * 非流式时 hover 露出操作行——仅 copy（反馈 👍/👎 与分享不做：本地无反馈回路）。
 */
function AssistantMsg({
  item,
  themeKey,
}: {
  item: Extract<ConversationItem, { kind: 'text' }>;
  themeKey: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={`msg msg-assistant${item.streaming ? ' streaming' : ''}`}
      data-testid="msg-assistant"
    >
      <Markdown text={item.text} themeKey={themeKey} />
      {item.streaming && <span className="stream-cursor" data-testid="stream-cursor" />}
      {!item.streaming && (
        <div className="msg-actions">
          <button
            type="button"
            className="icon-btn msg-copy"
            data-testid="msg-copy"
            title={copied ? '已复制' : '复制'}
            onClick={() => {
              void navigator.clipboard.writeText(item.text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? (
              '✓'
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
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

/** 审批行（ticket #20：时间线只读呈现；逐条裁决交互在输入区上方托盘 ApprovalTray） */
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

/** ticket #27：每轮末尾的用量灰字（本轮 in/out token + 折算金额；口径全在 tooltip） */
function UsageRow({ item }: { item: Extract<ConversationItem, { kind: 'usage' }> }): React.JSX.Element {
  return (
    <p
      className="turn-usage"
      data-testid="turn-usage"
      data-pending={item.usage.pending ? 'true' : 'false'}
      title={describeTurnUsageTitle(item.usage)}
    >
      {describeTurnUsage(item.usage)}
    </p>
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
  // ticket #36：create 成功而 start 失败的跨视图提示（首页 composer 写入；重试成功即清）
  const composerNotice = useUiStore((s) => s.composerNotice);
  const setComposerNotice = useUiStore((s) => s.setComposerNotice);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Codex 对齐（附录 B）：非 worktree 任务在上下文行显示 workspace 当前分支（组件按 task.id key 重挂，挂载即取）
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    const api = window.openCowork;
    if (!api || task.use_worktree === 1) return;
    let cancelled = false;
    void api.workspaces.currentBranch(task.workspace_id).then((info) => {
      if (!cancelled) setBranch(info.isGitRepo ? info.branch : null);
    });
    return () => {
      cancelled = true;
    };
  }, [task.workspace_id, task.use_worktree]);

  const status = task.status;
  const canType = status === 'awaiting_review';
  const canStart = status === 'ready';
  // #20：awaiting_approval 期间 agent 仍存活等裁决——取消键保持可用
  const cancellable = status === 'running' || status === 'awaiting_approval';
  const mode: PermissionMode = task.permission_mode ?? 'auto';

  // Codex 对齐（附录 B，§4）：权限档位 chip 弹层化——选定即 per-task 持久化
  const changeMode = async (next: PermissionMode): Promise<void> => {
    const api = window.openCowork;
    if (!api || next === mode) return;
    try {
      await api.approvals.setPermissionMode(task.id, next);
      await refreshAll(); // tasks:changed 亦会触发重拉，这里抢一拍让 chip 即时更新
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

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
      setComposerNotice(null); // 重试成功，清除跨视图提示
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
      setComposerNotice(null);
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
      : status === 'awaiting_approval'
        ? '待审批——请在上方托盘裁决（⌘1 允许 / ⌘2 总是 / ⌘3 拒绝）'
        : cancellable
          ? 'agent 运行中…'
          : status === 'awaiting_review'
            ? mode === 'readonly'
              ? '追问…（只读档：写/命令类将被自动拒绝）'
              : '追问…（Enter 发送，Shift+Enter 换行）'
            : status === 'failed'
              ? '任务已失败——先点上方「重试」'
              : '任务已结束';

  // ticket #36：create+start 流程中 start 失败的提示仅属于本任务
  const notice = composerNotice?.taskId === task.id ? composerNotice.message : null;

  return (
    <div className="composer" data-testid="composer">
      <div className="composer-box">
        {/* 第一行·上下文行（Codex 对齐，附录 B 视觉复核）：分段条——该任务的
            workspace / Local 环境 / 分支（worktree 或原目录当前分支） */}
        <div className="composer-context">
          <span className="context-item" data-testid="composer-workspace-chip">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 5.5 8 2l6 3.5v5L8 14l-6-3.5v-5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M2 5.5 8 9l6-3.5M8 9v5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            {task.workspace_name}
          </span>
          <span className="context-item" data-testid="composer-env-chip" title="本地运行，无云端环境">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 13.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            Local
          </span>
          {task.use_worktree === 1 && (
            <span className="context-item mono" data-testid="composer-branch-chip" title="worktree 隔离分支">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="4.5" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="11.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
                <path d="M4.5 6v4a3 3 0 0 0 3 3h2" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              cowork/{task.id}
            </span>
          )}
          {task.use_worktree !== 1 && branch && (
            <span className="context-item mono" data-testid="composer-branch-chip" title="当前 git 分支">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="4.5" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="11.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
                <path d="M4.5 6v4a3 3 0 0 0 3 3h2" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              {branch}
            </span>
          )}
        </div>
        {/* 第二行·输入区 */}
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
        {/* 第三行·动作行（§4）：权限档位 chip（弹层，附录 B）｜ agent/provider/model 合并 chip +
            context 水位环 + 发送/取消（右置） */}
        <div className="composer-actions">
          {/* ticket #20：权限档位 per-task 持久化；附录 B：循环切换改 radio 弹层 */}
          <PermissionModePicker mode={mode} onChange={(next) => void changeMode(next)} />
          <span className="composer-actions-flex" />
          <span className="chip composer-agent-model" data-testid="composer-agent-model-chip">
            <span data-testid="composer-agent-chip">{agentLabel(task.agent_type)}</span>
            {task.provider_name && (
              <span data-testid="composer-provider-chip">· {task.provider_name}</span>
            )}
            {task.model && <span data-testid="composer-model-chip">· {task.model}</span>}
          </span>
          {/* ticket #27：context 水位环（动作行右置；>80% 警告 + 压缩建议） */}
          <ContextRing taskId={task.id} />
          {cancellable ? (
            <button
              type="button"
              className="send-circle"
              data-testid="cancel-button"
              disabled={busy}
              title={busy ? '取消中…' : '取消'}
              onClick={() => void cancel()}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="send-circle"
              data-testid="send-button"
              disabled={sendDisabled}
              title={busy ? '发送中…' : canStart ? '开始' : '发送'}
              onClick={() => void send()}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 13V3m0 0-4 4m4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {(err ?? notice) && (
        <p className="form-error" role="alert" data-testid="composer-error">
          {err ?? notice}
        </p>
      )}
    </div>
  );
}
