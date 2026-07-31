import { useEffect, useState } from 'react';
import { deriveAlwaysAllowRule } from '../../../main/approval/policy';
import type { TaskListItem } from '../../../shared/api';
import { selectPending, useApprovalsStore } from '../stores/approvals';
import { useConversationStore } from '../stores/conversation';
import type { PermissionItem } from '../stores/conversation';
import '../styles/approvals.css';

/**
 * 审批托盘（ticket #20；交互定稿 = prototype/approval-flow 变体 D，视觉归 DESIGN.md）：
 * 输入区上方底部托盘，逐条聚焦当前请求（工具名/目标/理由），键盘优先：
 *   ⌘1 批准一次 / ⌘2 总是允许（生成工具+目标模式规则）/ ⌘3 拒绝（展开附理由）；
 * 多条并发时排队预览（下一条：工具 · 目标）。
 *
 * 键盘监听只在有待审批时激活，且焦点在 INPUT/TEXTAREA（如拒绝理由框）时不抢——
 * 不干扰输入区焦点语义。队列真源为 conversation store 的 PermissionItem 时间线
 * （decision===null），本组件零自持数据。
 *
 * ⌘2 的规则预览复用 main 策略引擎的 deriveAlwaysAllowRule（纯函数零依赖，
 * 与「总是允许」落库同一口径——单一事实源，不经 IPC 往返）。
 */

/** 托盘可见的任务状态（其余状态——含 failed/cancelled 残留 pending 行——一律不呈现） */
const TRAY_STATUSES = new Set(['running', 'awaiting_approval']);

export function ApprovalTray({ task }: { task: TaskListItem }): React.JSX.Element | null {
  const items = useConversationStore((s) => s.byTask[task.id]?.items);
  const settling = useApprovalsStore((s) => s.settling);
  const respond = useApprovalsStore((s) => s.respond);
  const denyOpenFor = useApprovalsStore((s) => s.denyOpenFor);
  const openDeny = useApprovalsStore((s) => s.openDeny);
  const closeDeny = useApprovalsStore((s) => s.closeDeny);
  const lastError = useApprovalsStore((s) => s.lastError);

  const pending = selectPending(items ?? [], settling);
  const visible = TRAY_STATUSES.has(task.status) && pending.length > 0;
  const current = pending[0] ?? null;
  const queue = pending.slice(1);

  // 键盘优先（⌘1/2/3；win/linux 用 Ctrl）：仅托盘可见时激活；焦点在输入控件内不抢
  useEffect(() => {
    if (!visible || !current) return;
    const requestId = current.request.id;
    const canAlways = current.request.options.includes('allow_always');
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const tag = document.activeElement?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '1') {
        e.preventDefault();
        void respond(task.id, requestId, { behavior: 'allow' });
      } else if (e.key === '2' && canAlways) {
        e.preventDefault();
        void respond(task.id, requestId, { behavior: 'allow', always: true });
      } else if (e.key === '3') {
        e.preventDefault();
        openDeny(requestId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, current, task.id, respond, openDeny]);

  if (!visible || !current) return null;
  const mode = task.permission_mode ?? 'auto';

  return (
    <section className="approval-dock" data-testid="approval-tray" aria-label="审批托盘">
      <header className="approval-dock-title">
        待审批 <span className="approval-count">{pending.length}</span>
        <span className="approval-kbd-hint">⌘1 允许 · ⌘2 总是 · ⌘3 拒绝</span>
        {mode === 'readonly' && (
          <span className="approval-mode-note" data-testid="approval-readonly-note">
            只读档：写/命令类会被自动拒绝
          </span>
        )}
      </header>
      <ApprovalCard
        key={current.request.id}
        task={task}
        item={current}
        denyOpen={denyOpenFor === current.request.id}
        onOpenDeny={() => openDeny(current.request.id)}
        onCloseDeny={closeDeny}
        onRespond={(decision) => void respond(task.id, current.request.id, decision)}
      />
      {queue.length > 0 && (
        <div className="approval-queue" data-testid="approval-queue">
          {queue.map((it) => (
            <span className="approval-q" key={it.request.id} data-testid="approval-queue-item">
              下一条：{it.request.toolName}
              {it.request.target ? ` · ${it.request.target}` : ''}
            </span>
          ))}
        </div>
      )}
      {lastError && (
        <p className="form-error" role="alert" data-testid="approval-error">
          {lastError}
        </p>
      )}
    </section>
  );
}

// ── 当前聚焦卡片 ─────────────────────────────────────────────────────────

function ApprovalCard(props: {
  task: TaskListItem;
  item: PermissionItem;
  denyOpen: boolean;
  onOpenDeny: () => void;
  onCloseDeny: () => void;
  onRespond: (decision: { behavior: 'allow' | 'deny'; always?: boolean; message?: string }) => void;
}): React.JSX.Element {
  const { item, denyOpen, onOpenDeny, onCloseDeny, onRespond } = props;
  const { request } = item;
  const canAlways = request.options.includes('allow_always');
  const rule = deriveAlwaysAllowRule(request.toolName, request.target);
  const [reason, setReason] = useState('');

  return (
    <div className="approval-card" data-testid="approval-current">
      <div className="approval-head">
        <span className="approval-tool">{request.toolName}</span>
        {request.reason && <span className="approval-reason"> · {request.reason}</span>}
      </div>
      {request.target && (
        <div className="approval-target mono" data-testid="approval-target">
          {request.target}
        </div>
      )}
      {denyOpen ? (
        <div className="approval-deny" data-testid="approval-deny">
          <textarea
            className="approval-deny-input"
            data-testid="deny-reason-input"
            rows={2}
            autoFocus
            placeholder="拒绝理由（可选，会作为反馈发给 agent）…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="approval-actions">
            <button
              type="button"
              className="approval-btn danger"
              data-testid="deny-confirm"
              onClick={() =>
                onRespond({
                  behavior: 'deny',
                  ...(reason.trim().length > 0 ? { message: reason.trim() } : {}),
                })
              }
            >
              确认拒绝
            </button>
            <button type="button" className="approval-btn" data-testid="deny-cancel" onClick={onCloseDeny}>
              返回
            </button>
          </div>
        </div>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="approval-btn primary"
            data-testid="approve-once"
            onClick={() => onRespond({ behavior: 'allow' })}
          >
            允许一次<kbd>⌘1</kbd>
          </button>
          {canAlways && (
            <button
              type="button"
              className="approval-btn"
              data-testid="approve-always"
              title={`记忆规则：${rule.tool}: ${rule.targetPattern}`}
              onClick={() => onRespond({ behavior: 'allow', always: true })}
            >
              总是允许「{rule.tool}: {rule.targetPattern}」<kbd>⌘2</kbd>
            </button>
          )}
          <button
            type="button"
            className="approval-btn danger"
            data-testid="deny-open"
            onClick={onOpenDeny}
          >
            拒绝<kbd>⌘3</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
