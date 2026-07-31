import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Database } from '../db/database';

/**
 * 终端 cwd 解析（ticket #28 内置终端 tab）。
 *
 * 规则（编排者附注 4）：
 *   currentTaskId → 读 task 行 → worktree_path 非空则用（worktree 任务，ARCHITECTURE §8）；
 *   否则用其 workspace.path；无选中任务回退 os.homedir()。
 *
 * 「有则用」：worktree 允许手动清理、workspace 目录也可能被移动，
 * 失效路径逐级回退（worktree → workspace → home），保证终端永远开得出来。
 * 只读查询，不写库。
 */
export function resolveTerminalCwd(
  db: Database,
  taskId: string | null,
  home: () => string = homedir,
): string {
  if (!taskId) return home();

  const task = db
    .prepare('SELECT workspace_id, worktree_path FROM tasks WHERE id = ?')
    .get(taskId) as { workspace_id: string; worktree_path: string | null } | undefined;
  if (!task) return home();

  if (task.worktree_path && existsSync(task.worktree_path)) return task.worktree_path;

  const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(task.workspace_id) as
    | { path: string }
    | undefined;
  if (ws?.path && existsSync(ws.path)) return ws.path;

  return home();
}
