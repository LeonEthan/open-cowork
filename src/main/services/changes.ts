import * as review from '../changes/review';
import * as fileChangesRepo from '../db/fileChangesRepo';
import type { ServiceContext } from './index';

/**
 * changes 服务（ticket #24：diff 复查与回滚）：
 * 检查栏「变更」tab 的查询与决议通道。
 *
 * - 文件级：accept / rollback / restore（只改 file_changes.status + 工作区文件）；
 * - 任务级：accept-all / rollback-all（完成后 awaiting_review → done，
 *   状态机经 taskRepo.updateStatus 把关，非法态 IPC 层原样拒绝）；
 * - 每次变更后广播 tasks:changed，renderer 重拉任务行与变更列表。
 * 捕获本身不在本服务——turn_end 触发，见 agentEvents.ts 挂钩与 changes/capture.ts。
 */
export default function register(ctx: ServiceContext): void {
  const broadcast = (): void => {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('tasks:changed');
  };

  const senderAllowed = (event: Electron.IpcMainInvokeEvent): boolean => {
    const win = ctx.getMainWindow();
    return !!win && event.sender === win.webContents;
  };

  const guard = (event: Electron.IpcMainInvokeEvent, channel: string): void => {
    if (!senderAllowed(event)) throw new Error(`${channel} 来源非法`);
  };

  const mustString = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || v.length === 0) throw new Error(`需要 ${what}`);
    return v;
  };

  ctx.ipcMain.handle('changes:list', (event, taskId: unknown) => {
    guard(event, 'changes:list');
    return fileChangesRepo.listByTask(ctx.db, mustString(taskId, '任务 id'));
  });

  ctx.ipcMain.handle('changes:accept', (event, id: unknown) => {
    guard(event, 'changes:accept');
    review.acceptChange(ctx.db, mustString(id, '变更 id'));
    broadcast();
    return { ok: true as const };
  });

  ctx.ipcMain.handle('changes:rollback', (event, id: unknown) => {
    guard(event, 'changes:rollback');
    review.rollbackChange(ctx.db, ctx.dataDir, mustString(id, '变更 id'));
    broadcast();
    return { ok: true as const };
  });

  ctx.ipcMain.handle('changes:restore', (event, id: unknown) => {
    guard(event, 'changes:restore');
    review.restoreChange(ctx.db, ctx.dataDir, mustString(id, '变更 id'));
    broadcast();
    return { ok: true as const };
  });

  ctx.ipcMain.handle('changes:accept-all', (event, taskId: unknown) => {
    guard(event, 'changes:accept-all');
    review.acceptAll(ctx.db, mustString(taskId, '任务 id'));
    broadcast();
    return { ok: true as const };
  });

  ctx.ipcMain.handle('changes:rollback-all', (event, taskId: unknown) => {
    guard(event, 'changes:rollback-all');
    review.rollbackAll(ctx.db, ctx.dataDir, mustString(taskId, '任务 id'));
    broadcast();
    return { ok: true as const };
  });
}
