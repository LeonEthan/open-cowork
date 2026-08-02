import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileChange } from '../../../../shared/api';
// ticket #39（additive 独立行，并行票据零冲突合并约定）：git 操作区块类型
import type { GitCompareFile, GitCompareResult, GitWorkingSummary } from '../../../../shared/api';
import { WorktreePanel } from '../../components/WorktreePanel';
import { useAppStore } from '../../stores/appStore';
import { useChangesStore } from '../../stores/changes';
import { useDataStore } from '../../stores/data';
import type { InspectorTabDef } from '../registry';
import '../../styles/changes.css';

/**
 * 检查栏「变更」tab（ticket #24：diff 复查与回滚）。
 * - 变更文件列表：path + +N/-N + 状态徽标（待复查/已接受/已回滚）；
 * - 选中文件内嵌 diff：逐行 +绿/-红/上下文灰（§2 diff 三色白名单）；
 * - 文件级「接受/回滚」，已回滚显示「恢复」；顶部任务级「全部接受/全部回滚」
 *   （awaiting_review 态出现，完成后任务 → done）；
 * - 数据：main 侧 file_changes 表（turn_end 捕获落库），tasks:changed 广播驱动重拉。
 * - ticket #39（Codex Environment 对齐）：tab 头部 git 操作区块——
 *   分支行（分支 chip + upstream ↑↓）/ 提交 + 推送 / worktree 任务「与 base 对比」展开行；
 *   无选中任务或非 git 目录整块不渲染。
 */

const STATUS_LABELS: Record<FileChange['status'], string> = {
  pending: '待复查',
  accepted: '已接受',
  reverted: '已回滚',
};

const TYPE_LABELS: Record<FileChange['change_type'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '改名',
};

/** 展示排序：待复查在前，已回滚次之，已接受垫底；组内按路径 */
function sortChanges(rows: FileChange[]): FileChange[] {
  const rank = (s: FileChange['status']): number =>
    s === 'pending' ? 0 : s === 'reverted' ? 1 : 2;
  return [...rows].sort((a, b) => rank(a.status) - rank(b.status) || a.path.localeCompare(b.path));
}

function errMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const idx = msg.lastIndexOf('Error: ');
  return idx >= 0 ? msg.slice(idx + 'Error: '.length) : msg;
}

// ── diff 渲染 ────────────────────────────────────────────────────────────

type DiffSign = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

function diffSign(line: string): DiffSign {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('Binary files')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function DiffView({ change }: { change: FileChange }): React.JSX.Element {
  if (change.diff === null || change.diff.length === 0) {
    return (
      <div className="change-diff" data-testid="change-diff" data-path={change.path}>
        <div className="diff-line meta">（二进制或无文本 diff——可在终端核查该文件）</div>
      </div>
    );
  }
  const lines = change.diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // 文本末换行不渲染空行
  return (
    <div className="change-diff" data-testid="change-diff" data-path={change.path}>
      {lines.map((line, i) => {
        const sign = diffSign(line);
        return (
          <div key={i} className={`diff-line ${sign}`} data-sign={sign}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

// ── 文件行 ───────────────────────────────────────────────────────────────

interface RowProps {
  change: FileChange;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onAction: (action: 'accept' | 'rollback' | 'restore', change: FileChange) => void;
}

function ChangeRow({ change, selected, busy, onSelect, onAction }: RowProps): React.JSX.Element {
  const hasStats = change.added !== null || change.removed !== null;
  return (
    <li>
      <div
        className={`change-row${selected ? ' selected' : ''}`}
        data-testid="change-row"
        data-path={change.path}
        data-status={change.status}
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <div className="change-main">
          <span className="change-path" title={change.path}>
            {change.path}
          </span>
          <span className="change-meta">
            <span className={`change-badge ${change.status}`}>{STATUS_LABELS[change.status]}</span>
            <span>{TYPE_LABELS[change.change_type]}</span>
            {hasStats && (
              <span className="change-stats" data-testid="change-stats">
                <span className="stat-add">+{change.added ?? 0}</span>{' '}
                <span className="stat-del">-{change.removed ?? 0}</span>
              </span>
            )}
          </span>
        </div>
        {/* 操作键不触发行选中 */}
        <span className="change-actions" onClick={(e) => e.stopPropagation()}>
          {change.status === 'pending' && (
            <>
              <button
                type="button"
                className="icon-btn"
                data-testid="change-accept"
                data-path={change.path}
                disabled={busy}
                onClick={() => onAction('accept', change)}
              >
                接受
              </button>
              <button
                type="button"
                className="icon-btn btn-danger"
                data-testid="change-rollback"
                data-path={change.path}
                disabled={busy}
                onClick={() => onAction('rollback', change)}
              >
                回滚
              </button>
            </>
          )}
          {change.status === 'reverted' && (
            <button
              type="button"
              className="icon-btn"
              data-testid="change-restore"
              data-path={change.path}
              disabled={busy}
              onClick={() => onAction('restore', change)}
            >
              恢复
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

// ── ticket #39：git 操作区块（分支行 / 提交推送 / 与 base 对比） ──────────

const COMPARE_STATUS_LABELS: Record<GitCompareFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '改名',
};

interface GitOpsPanelProps {
  taskId: string;
  /** worktree 任务才渲染「与 base 对比」行 */
  useWorktree: boolean;
  /** 提交/推送成功后让父级重拉 changes store */
  onChanged: () => void;
}

function GitOpsPanel({ taskId, useWorktree, onChanged }: GitOpsPanelProps): React.JSX.Element | null {
  const [summary, setSummary] = useState<GitWorkingSummary | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [opBusy, setOpBusy] = useState<'commit' | 'push' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compare, setCompare] = useState<GitCompareResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const loadSummary = useCallback(async (): Promise<void> => {
    const api = window.openCowork;
    if (!api) return;
    try {
      setSummary(await api.git.workingSummary(taskId));
    } catch {
      setSummary(null); // 分支行拉取失败按不渲染处理（不阻断变更列表）
    }
  }, [taskId]);

  // 选中任务变化：重拉分支行 + 收起重对比区块
  useEffect(() => {
    setErr(null);
    setCommitMsg('');
    setCompareOpen(false);
    setCompare(null);
    void loadSummary();
  }, [loadSummary]);

  const runOp = useCallback(
    async (kind: 'commit' | 'push'): Promise<void> => {
      const api = window.openCowork;
      if (!api || opBusy) return; // busy 态防重
      setOpBusy(kind);
      setErr(null);
      try {
        if (kind === 'commit') {
          await api.git.commitAll(taskId, commitMsg);
          setCommitMsg(''); // 提交成功清空输入
        } else {
          await api.git.push(taskId);
        }
        await loadSummary(); // 分支行重拉（ahead/behind 变化）
        onChanged(); // changes store 刷新
      } catch (e) {
        setErr(errMessage(e));
      } finally {
        setOpBusy(null);
      }
    },
    [opBusy, taskId, commitMsg, loadSummary, onChanged],
  );

  const toggleCompare = useCallback((): void => {
    const api = window.openCowork;
    if (compareOpen) {
      setCompareOpen(false);
      return;
    }
    setCompareOpen(true);
    if (!api || compare) return; // 已拉过不重复请求（折叠后展开复用缓存）
    setCompareLoading(true);
    setErr(null);
    void api.git
      .compareWithBase(taskId)
      .then(setCompare)
      .catch((e: unknown) => setErr(errMessage(e)))
      .finally(() => setCompareLoading(false));
  }, [compareOpen, compare, taskId]);

  // 非 git 目录 / 拉取失败：整块不渲染
  if (!summary?.isGitRepo) return null;

  return (
    <div className="git-ops" data-testid="git-ops-panel">
      {/* 分支行：分支名 chip（mono）+ upstream 小字（null 不渲染） */}
      <div className="git-branch-row" data-testid="git-branch-row">
        <span className="git-branch-chip">{summary.branch ?? '未知分支'}</span>
        {(summary.ahead !== null || summary.behind !== null) && (
          <span className="git-upstream">
            {summary.ahead !== null && ` ↑${summary.ahead}`}
            {summary.behind !== null && ` ↓${summary.behind}`}
          </span>
        )}
      </div>
      {/* Commit or push 行 */}
      <div className="git-commit-row">
        <input
          type="text"
          className="git-commit-input"
          data-testid="git-commit-input"
          placeholder="提交信息…"
          value={commitMsg}
          disabled={opBusy !== null}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && commitMsg.trim().length > 0) void runOp('commit');
          }}
        />
        <button
          type="button"
          className="icon-btn btn-primary"
          data-testid="git-commit-button"
          disabled={opBusy !== null || commitMsg.trim().length === 0}
          onClick={() => void runOp('commit')}
        >
          {opBusy === 'commit' ? '提交中…' : '提交'}
        </button>
        <button
          type="button"
          className="icon-btn"
          data-testid="git-push-button"
          disabled={opBusy !== null}
          onClick={() => void runOp('push')}
        >
          {opBusy === 'push' ? '推送中…' : '推送'}
        </button>
      </div>
      {err && (
        <p className="git-ops-error" role="alert" data-testid="git-ops-error">
          {err}
        </p>
      )}
      {/* Compare branch 行（仅 worktree 任务） */}
      {useWorktree && (
        <div className="git-compare">
          <button
            type="button"
            className="git-compare-toggle"
            data-testid="git-compare-toggle"
            aria-expanded={compareOpen}
            onClick={toggleCompare}
          >
            {compareOpen ? '▾' : '▸'} 与 base 对比
          </button>
          {compareOpen && (
            <div className="git-compare-body">
              {compareLoading && <p className="git-compare-meta">对比中…</p>}
              {compare && !compare.supported && (
                <p className="git-compare-meta">该任务没有可对比的 base。</p>
              )}
              {compare && compare.supported && (
                <>
                  <p className="git-compare-summary">
                    base <span className="git-base-label">{compare.baseLabel}</span> ·{' '}
                    {compare.files.length} 个文件 <span className="stat-add">+{compare.insertions}</span>{' '}
                    <span className="stat-del">−{compare.deletions}</span>
                  </p>
                  {compare.files.length > 0 && (
                    <ul className="git-compare-list" data-testid="git-compare-list">
                      {compare.files.map((f) => (
                        <li key={f.path} className="git-compare-item">
                          <span className={`git-compare-status ${f.status}`}>
                            {COMPARE_STATUS_LABELS[f.status]}
                          </span>
                          <span className="git-compare-path">{f.path}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── tab 本体 ─────────────────────────────────────────────────────────────

function ChangesTab(): React.JSX.Element {
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const task = useDataStore((s) => s.tasks.find((t) => t.id === currentTaskId) ?? null);
  const changes = useChangesStore((s) => (currentTaskId ? s.byTask[currentTaskId] : undefined));
  const refresh = useChangesStore((s) => s.refresh);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 选中任务变化：重拉 + 清错（快照由 main 广播增量驱动，见下）
  useEffect(() => {
    setErr(null);
    if (currentTaskId) void refresh(currentTaskId);
  }, [currentTaskId, refresh]);

  // main 广播 tasks:changed（turn_end 捕获落库 / 决议回写 / 状态迁移）→ 重拉
  useEffect(() => {
    const api = window.openCowork;
    if (!api || !currentTaskId) return;
    return api.onTasksChanged(() => {
      void refresh(currentTaskId);
    });
  }, [currentTaskId, refresh]);

  const sorted = useMemo(() => sortChanges(changes ?? []), [changes]);
  const selected = sorted.find((c) => c.id === selectedId) ?? sorted[0] ?? null;

  const run = useCallback(
    async (fn: (api: NonNullable<typeof window.openCowork>) => Promise<unknown>): Promise<void> => {
      const api = window.openCowork;
      if (!api || busy) return;
      setBusy(true);
      setErr(null);
      try {
        await fn(api);
        if (currentTaskId) await refresh(currentTaskId);
      } catch (e) {
        setErr(errMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, currentTaskId, refresh],
  );

  const onRowAction = useCallback(
    (action: 'accept' | 'rollback' | 'restore', change: FileChange): void => {
      void run((api) => api.changes[action](change.id));
    },
    [run],
  );

  if (!currentTaskId || !task) {
    return (
      <div className="empty-state" data-testid="changes-empty">
        选中任务后，这里会列出它的文件变更与 diff。
      </div>
    );
  }

  const pendingCount = sorted.filter((c) => c.status === 'pending').length;

  return (
    <div className="changes-panel" data-testid="changes-panel">
      {/* ── ticket #39：git 操作区块（分支行 / 提交推送 / 与 base 对比）；非 git 目录内部返回 null ── */}
      <GitOpsPanel
        taskId={task.id}
        useWorktree={task.use_worktree === 1}
        onChanged={() => void refresh(task.id)}
      />
      {/* ── ticket #25：worktree 任务的「回流到原目录 / 清理 worktree」任务级操作 ── */}
      {task.use_worktree === 1 && <WorktreePanel taskId={task.id} />}
      {task.status === 'awaiting_review' && (
        <div className="changes-taskbar" data-testid="changes-taskbar">
          <span className="changes-count" data-testid="changes-count">
            {pendingCount > 0 ? `${pendingCount} 项待复查` : '无待复查变更'}
          </span>
          <span className="changes-taskbar-actions">
            <button
              type="button"
              className="icon-btn btn-primary"
              data-testid="changes-accept-all"
              disabled={busy}
              onClick={() => void run((api) => api.changes.acceptAll(task.id))}
            >
              全部接受
            </button>
            <button
              type="button"
              className="icon-btn btn-danger"
              data-testid="changes-rollback-all"
              disabled={busy || pendingCount === 0}
              onClick={() => void run((api) => api.changes.rollbackAll(task.id))}
            >
              全部回滚
            </button>
          </span>
        </div>
      )}
      {err && (
        <p className="form-error" role="alert" data-testid="changes-error">
          {err}
        </p>
      )}
      {sorted.length === 0 ? (
        <div className="empty-state" data-testid="changes-empty">
          暂无变更。任务完成后，文件改动与 diff 将列在这里。
        </div>
      ) : (
        <>
          <ul className="changes-list" data-testid="changes-list">
            {sorted.map((c) => (
              <ChangeRow
                key={c.id}
                change={c}
                selected={selected?.id === c.id}
                busy={busy}
                onSelect={() => setSelectedId(c.id)}
                onAction={onRowAction}
              />
            ))}
          </ul>
          {selected && <DiffView change={selected} />}
        </>
      )}
    </div>
  );
}

const def: InspectorTabDef = {
  id: 'changes',
  title: '变更',
  order: 20, // 编排者附注 4：变更(20) / 终端(30)
  component: ChangesTab,
};

export default def;
