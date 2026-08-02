import { useEffect, useRef, useState } from 'react';
import type { TaskListItem } from '../../../shared/api';
import { STATUS_LABELS, agentLabel, statusDotClass } from '../lib/taskStatus';
import { useAppStore } from '../stores/appStore';
import { errMessage, useDataStore } from '../stores/data';

/**
 * 会话标题行（Codex 对齐改造，DESIGN.md 附录 B）：
 * 左侧 = 标题（「…」菜单选重命名后换内联输入框）+ 状态行（状态点 + 元信息）；
 * 右侧 = 「Open in ⌄」（本地等价物：在 Finder 显示 / 在默认应用打开——
 * worktree 任务指向隔离目录）+「…」菜单（重命名 / 置顶切换 / 删除两步确认）。
 * 删除成功后回首页（取消任务选中）。
 */
export function TaskHeader({ task }: { task: TaskListItem }): React.JSX.Element {
  const refreshAll = useDataStore((s) => s.refreshAll);
  const toggleTaskPinned = useDataStore((s) => s.toggleTaskPinned);
  const workspaces = useDataStore((s) => s.workspaces);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);

  const [openInOpen, setOpenInOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(task.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const ws = workspaces.find((w) => w.id === task.workspace_id);
  const targetPath =
    task.use_worktree === 1 && task.worktree_path ? task.worktree_path : (ws?.path ?? null);
  const pinned = task.pinned === 1;

  // Esc / 点击外部关闭弹层；删除二次确认随弹层关闭复位
  useEffect(() => {
    if (!openInOpen && !menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpenInOpen(false);
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    };
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpenInOpen(false);
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [openInOpen, menuOpen]);

  const commitRename = async (): Promise<void> => {
    const api = window.openCowork;
    const title = nameDraft.trim();
    if (!api || title.length === 0 || title === task.title) {
      setRenaming(false);
      setNameDraft(task.title);
      return;
    }
    setBusy(true);
    try {
      await api.tasks.rename(task.id, title);
      await refreshAll();
      setRenaming(false);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (): Promise<void> => {
    const api = window.openCowork;
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.tasks.remove(task.id);
      await refreshAll();
      setCurrentTaskId(null);
    } catch (e) {
      setErr(errMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="task-header" ref={wrapRef}>
      <div className="task-header-main">
        {renaming ? (
          <input
            className="task-rename-input"
            data-testid="task-rename-input"
            value={nameDraft}
            disabled={busy}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') {
                setRenaming(false);
                setNameDraft(task.title);
              }
            }}
            onBlur={() => void commitRename()}
          />
        ) : (
          <h1 className="doc-title" data-testid="task-title">
            {task.title}
          </h1>
        )}
        <p className="task-detail-status">
          <span className={statusDotClass(task.status)} data-testid="detail-status-dot" />
          <span data-testid="detail-status-label">{STATUS_LABELS[task.status]}</span>
          <span className="muted">
            · {task.workspace_name} · {agentLabel(task.agent_type)}
            {task.provider_name ? ` · ${task.provider_name}` : ''}
            {task.model ? ` · ${task.model}` : ''}
          </span>
        </p>
        {err && (
          <p className="form-error" role="alert" data-testid="task-header-error">
            {err}
          </p>
        )}
      </div>
      <div className="task-header-actions">
        {targetPath && (
          <div className="menu-anchor">
            <button
              type="button"
              className="chip chip-btn"
              data-testid="task-open-in"
              aria-expanded={openInOpen}
              onClick={() => setOpenInOpen((v) => !v)}
            >
              Open in ⌄
            </button>
            {openInOpen && (
              <div className="menu-popover" data-testid="task-open-in-menu" role="menu">
                <button
                  type="button"
                  className="menu-item"
                  data-testid="task-show-in-finder"
                  onClick={() => {
                    setOpenInOpen(false);
                    void window.openCowork?.shell.showInFolder(targetPath);
                  }}
                >
                  在 Finder 显示
                </button>
                <button
                  type="button"
                  className="menu-item"
                  data-testid="task-open-path"
                  onClick={() => {
                    setOpenInOpen(false);
                    void window.openCowork?.shell
                      .openPath(targetPath)
                      .catch((e: unknown) => setErr(errMessage(e)));
                  }}
                >
                  在默认应用打开
                </button>
              </div>
            )}
          </div>
        )}
        <div className="menu-anchor">
          <button
            type="button"
            className="icon-btn"
            data-testid="task-menu"
            aria-expanded={menuOpen}
            title="任务操作"
            onClick={() => setMenuOpen((v) => !v)}
          >
            …
          </button>
          {menuOpen && (
            <div className="menu-popover" data-testid="task-menu-popover" role="menu">
              <button
                type="button"
                className="menu-item"
                data-testid="task-rename"
                onClick={() => {
                  setMenuOpen(false);
                  setNameDraft(task.title);
                  setRenaming(true);
                }}
              >
                重命名
              </button>
              <button
                type="button"
                className="menu-item"
                data-testid="task-pin-menu"
                onClick={() => {
                  setMenuOpen(false);
                  void toggleTaskPinned(task);
                }}
              >
                {pinned ? '取消置顶' : '置顶'}
              </button>
              <button
                type="button"
                className={`menu-item menu-item-danger${confirmDelete ? ' confirming' : ''}`}
                data-testid="task-delete"
                disabled={busy}
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  void doDelete();
                }}
              >
                {confirmDelete ? '确认删除？（会话与变更记录一并删除）' : '删除任务'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
