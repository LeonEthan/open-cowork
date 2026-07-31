import * as taskRepo from '../db/taskRepo';
import type { PermissionDecision } from '../../agent/events';
import type { ServiceContext } from './index';

/**
 * 审批流 IPC（ticket #20）：renderer 托盘的决议回路与 per-task 权限档位切换。
 *
 * 通道（沿用 services/agent.ts 的 senderAllowed 校验模式）：
 * - agent:permission-respond：托盘决议 → ctx.approval.respond（幂等；未知/已结清
 *   请求返回 settled:false 而非抛错——双击/重连补发安全）；
 * - tasks:set-permission-mode：三档循环切换（readonly/auto/full），per-task 持久化
 *   到 tasks.permission_mode；不涉状态机，任何任务状态下可切换。
 */
export default function register(ctx: ServiceContext): void {
  const senderAllowed = (event: Electron.IpcMainInvokeEvent): boolean => {
    const win = ctx.getMainWindow();
    return !!win && event.sender === win.webContents;
  };

  ctx.ipcMain.handle(
    'agent:permission-respond',
    (event, taskId: unknown, requestId: unknown, decision: unknown) => {
      if (!senderAllowed(event)) throw new Error('agent:permission-respond 来源非法');
      if (typeof taskId !== 'string' || typeof requestId !== 'string') {
        throw new Error('agent:permission-respond 需要 { taskId, requestId, decision }');
      }
      const d = decision as Partial<PermissionDecision> | null;
      if (!d || typeof d !== 'object' || (d.behavior !== 'allow' && d.behavior !== 'deny')) {
        throw new Error("agent:permission-respond 的 decision.behavior 须为 'allow' | 'deny'");
      }
      const clean: PermissionDecision = {
        behavior: d.behavior,
        ...(typeof d.always === 'boolean' ? { always: d.always } : {}),
        ...(typeof d.message === 'string' && d.message.length > 0 ? { message: d.message } : {}),
      };
      return ctx.approval.respond({ taskId, requestId, decision: clean });
    },
  );

  ctx.ipcMain.handle('tasks:set-permission-mode', (event, taskId: unknown, mode: unknown) => {
    if (!senderAllowed(event)) throw new Error('tasks:set-permission-mode 来源非法');
    if (typeof taskId !== 'string') throw new Error('tasks:set-permission-mode 需要任务 id');
    if (mode !== 'readonly' && mode !== 'auto' && mode !== 'full') {
      throw new Error("tasks:set-permission-mode 的档位须为 'readonly' | 'auto' | 'full'");
    }
    const task = taskRepo.setPermissionMode(ctx.db, taskId, mode);
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('tasks:changed');
    return task;
  });
}
