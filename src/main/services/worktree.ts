import { backflow, cleanupWorktree, workspaceWorktreeInfo, worktreeStatus } from '../worktree/worktree';
import type { ServiceContext } from './index';

/**
 * worktree 服务（ticket #25：worktree 隔离与回流）。
 *
 * 通道：
 * - worktree:workspace-check  创建表单勾选框启用依据（是否 git 仓 / 有无提交）；
 * - worktree:status           检查栏「回流到原目录」区块渲染基线（路径/分支/base/HEAD/漂移）；
 * - worktree:backflow         回流：worktree 改动 git apply 落回原目录（未提交形态）；
 *                             base 漂移且未 force 时 reject（UI 走「我已处理，强制回流」）；
 * - worktree:cleanup          手动清理：worktree remove + 集中目录删除 + 可选删分支
 *                             （默认保留 cowork/<taskId> 逃生舱）+ tasks.worktree_path 置空。
 *
 * 创建（tasks:create 勾选时即时建）在 services/tasks.ts；本服务只管查询与任务级操作。
 * 变更后广播 tasks:changed，renderer 重拉任务行与 worktree 状态。
 */
export default function register(ctx: ServiceContext): void {
  const broadcast = (): void => {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('tasks:changed');
  };

  const guard = (event: Electron.IpcMainInvokeEvent, channel: string): void => {
    const win = ctx.getMainWindow();
    if (!win || event.sender !== win.webContents) throw new Error(`${channel} 来源非法`);
  };

  const mustString = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || v.length === 0) throw new Error(`需要 ${what}`);
    return v;
  };

  ctx.ipcMain.handle('worktree:workspace-check', (event, workspaceId: unknown) => {
    guard(event, 'worktree:workspace-check');
    return workspaceWorktreeInfo(ctx.db, mustString(workspaceId, 'workspace id'));
  });

  ctx.ipcMain.handle('worktree:status', (event, taskId: unknown) => {
    guard(event, 'worktree:status');
    return worktreeStatus(ctx.db, mustString(taskId, '任务 id'));
  });

  ctx.ipcMain.handle('worktree:backflow', (event, taskId: unknown, opts: unknown) => {
    guard(event, 'worktree:backflow');
    const force =
      typeof opts === 'object' && opts !== null && (opts as { force?: unknown }).force === true;
    const result = backflow(ctx.db, mustString(taskId, '任务 id'), { force });
    broadcast();
    return { ok: true as const, files: result.files };
  });

  ctx.ipcMain.handle('worktree:cleanup', (event, taskId: unknown, opts: unknown) => {
    guard(event, 'worktree:cleanup');
    const deleteBranch =
      typeof opts === 'object' &&
      opts !== null &&
      (opts as { deleteBranch?: unknown }).deleteBranch === true;
    const result = cleanupWorktree(ctx.db, ctx.dataDir, mustString(taskId, '任务 id'), {
      deleteBranch,
    });
    broadcast();
    return result;
  });
}
