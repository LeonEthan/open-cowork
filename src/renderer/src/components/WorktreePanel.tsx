import { useCallback, useEffect, useState } from 'react';
import { useWorktreeStore } from '../stores/worktree';
import '../styles/worktree.css';

/**
 * 检查栏「变更」tab 的 worktree 区块（ticket #25：worktree 隔离与回流）。
 *
 * 仅对 opt-in worktree 且 worktree 仍在的任务渲染：
 * - 状态行：隔离目录 + 逃生舱分支（cowork/<taskId>）；
 * - 「回流到原目录」：worktree 改动 git apply 落回原目录（未提交形态）；
 * - base 漂移（原仓 HEAD 离开 pin 的 base）：阻断自动回流，提示先处理，
 *   并提供「我已处理，强制回流」二次确认路径；
 * - 「清理 worktree」：两段式确认（避免原生 confirm，e2e 可驱动），
 *   磁盘回收 + tasks.worktree_path 置空后终端/diff 自动回退 workspace 原目录；
 *   分支默认保留作逃生舱。
 */

function errMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const idx = msg.lastIndexOf('Error: ');
  return idx >= 0 ? msg.slice(idx + 'Error: '.length) : msg;
}

export function WorktreePanel(props: { taskId: string }): React.JSX.Element | null {
  const { taskId } = props;
  const status = useWorktreeStore((s) => s.byTask[taskId]);
  const refresh = useWorktreeStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 漂移提示：状态探测漂移，或回流被漂移拒绝后sticky展示强制路径 */
  const [driftBlocked, setDriftBlocked] = useState(false);
  const [confirmingCleanup, setConfirmingCleanup] = useState(false);

  useEffect(() => {
    setErr(null);
    setNotice(null);
    setDriftBlocked(false);
    setConfirmingCleanup(false);
    void refresh(taskId);
  }, [taskId, refresh]);

  // main 广播 tasks:changed（回流/清理/状态迁移）→ 重拉状态
  useEffect(() => {
    const api = window.openCowork;
    if (!api) return;
    return api.onTasksChanged(() => {
      void refresh(taskId);
    });
  }, [taskId, refresh]);

  const run = useCallback(
    async (fn: (api: NonNullable<typeof window.openCowork>) => Promise<unknown>): Promise<void> => {
      const api = window.openCowork;
      if (!api || busy) return;
      setBusy(true);
      setErr(null);
      setNotice(null);
      try {
        await fn(api);
      } catch (e) {
        setErr(errMessage(e));
      } finally {
        setBusy(false);
        await refresh(taskId);
      }
    },
    [busy, taskId, refresh],
  );

  const backflow = useCallback(
    (force: boolean): void => {
      void run(async (api) => {
        try {
          const res = await api.worktree.backflow(taskId, { force });
          setDriftBlocked(false);
          setNotice(
            res.files > 0
              ? `已回流 ${res.files} 个文件到原目录（未提交改动，git status 可查）。`
              : 'worktree 没有可回流的改动。',
          );
        } catch (e) {
          const msg = errMessage(e);
          if (msg.includes('漂移')) setDriftBlocked(true);
          throw e;
        }
      });
    },
    [run, taskId],
  );

  // 未启用 / 已清理（path 置空）→ 不渲染；目录被外部删除（exists=false）仍显示，供清理收尾
  if (!status || !status.enabled || status.path === null) return null;

  const drifted = status.drifted || driftBlocked;

  return (
    <div className="worktree-panel" data-testid="worktree-panel">
      <div className="worktree-meta">
        <span className="worktree-title">worktree 隔离运行中</span>
        <span className="worktree-path" title={status.path}>
          {status.branch}
        </span>
      </div>
      {drifted && (
        <p className="worktree-drift" role="alert" data-testid="worktree-drift-hint">
          原仓已有新提交（base 漂移），自动回流已阻断。请先在原目录处理新提交，
          确认无误后可强制回流。
        </p>
      )}
      <div className="worktree-actions">
        {drifted ? (
          <button
            type="button"
            className="icon-btn"
            data-testid="worktree-backflow-force"
            disabled={busy}
            onClick={() => backflow(true)}
          >
            我已处理，强制回流
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            data-testid="worktree-backflow"
            disabled={busy}
            onClick={() => backflow(false)}
          >
            回流到原目录
          </button>
        )}
        {confirmingCleanup ? (
          <>
            <button
              type="button"
              className="icon-btn danger"
              data-testid="worktree-cleanup-confirm"
              disabled={busy}
              onClick={() =>
                void run(async (api) => {
                  await api.worktree.cleanup(taskId);
                  setConfirmingCleanup(false);
                  setNotice('worktree 已清理，磁盘已回收（分支保留作逃生舱）。');
                })
              }
            >
              确认清理（改动若未回流将丢失）
            </button>
            <button
              type="button"
              className="icon-btn"
              data-testid="worktree-cleanup-cancel"
              disabled={busy}
              onClick={() => setConfirmingCleanup(false)}
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            className="icon-btn"
            data-testid="worktree-cleanup"
            disabled={busy}
            onClick={() => setConfirmingCleanup(true)}
          >
            清理 worktree
          </button>
        )}
      </div>
      {notice && (
        <p className="worktree-notice" data-testid="worktree-message">
          {notice}
        </p>
      )}
      {err && (
        <p className="form-error" role="alert" data-testid="worktree-error">
          {err}
        </p>
      )}
    </div>
  );
}
