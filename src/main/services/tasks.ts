import * as taskRepo from '../db/taskRepo';
import type { TaskStatus } from '../db/entities';
import { cleanupWorktree, createTaskWorktree } from '../worktree/worktree';
import type { ServiceContext } from './index';

/**
 * tasks 服务（ticket #18）：任务创建（入库即 ready）与状态迁移。
 * 状态迁移合法性由 db/taskStateMachine 统一把关（非法迁移抛错，IPC 层原样拒绝）。
 * 本票尚无 agent 运行（#19 才接），任务创建后停留在 ready。
 */
const TASK_STATUSES: readonly TaskStatus[] = [
  'ready',
  'running',
  'awaiting_approval',
  'awaiting_review',
  'done',
  'failed',
  'cancelled',
];

export default function register(ctx: ServiceContext): void {
  // 来源校验（参照 services/worktree.ts guard 模式）
  const guard = (event: Electron.IpcMainInvokeEvent, channel: string): void => {
    const win = ctx.getMainWindow();
    if (!win || event.sender !== win.webContents) throw new Error(`${channel} 来源非法`);
  };

  // 变更后广播，renderer 统一 refreshAll
  const broadcast = (): void => {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('tasks:changed');
  };

  ctx.ipcMain.handle('tasks:list', () => taskRepo.list(ctx.db));

  ctx.ipcMain.handle('tasks:create', (_event, input: unknown) => {
    const raw = input as Partial<taskRepo.CreateTaskInput> | null;
    if (!raw || typeof raw.workspaceId !== 'string' || typeof raw.prompt !== 'string') {
      throw new Error('tasks:create 需要 { workspaceId, prompt }');
    }
    if (typeof raw.agentType !== 'string' || raw.agentType.length === 0) {
      throw new Error('tasks:create 需要 agentType');
    }
    const task = taskRepo.create(ctx.db, {
      workspaceId: raw.workspaceId,
      prompt: raw.prompt,
      title: typeof raw.title === 'string' ? raw.title : undefined,
      agentType: raw.agentType,
      providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      // ── ticket #25（additive）：opt-in worktree 隔离 ──
      useWorktree: raw.useWorktree === true,
    });
    // #25：勾选 worktree 的任务入库后立即建隔离目录 + pin base SHA；
    // 失败回滚干净（任务行级联删除——此时无任何子行，单 DELETE 即可）并原样抛错。
    if (task.use_worktree === 1) {
      try {
        createTaskWorktree(ctx.db, ctx.dataDir, task.id);
      } catch (err) {
        ctx.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        throw err;
      }
    }
    return taskRepo.getById(ctx.db, task.id) ?? task;
  });

  ctx.ipcMain.handle('tasks:update-status', (_event, id: unknown, status: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('tasks:update-status 需要任务 id');
    }
    if (typeof status !== 'string' || !TASK_STATUSES.includes(status as TaskStatus)) {
      throw new Error(`tasks:update-status 非法状态: ${String(status)}`);
    }
    return taskRepo.updateStatus(ctx.db, id, status as TaskStatus);
  });

  // 二期 Pinned：置顶切换（additive；不涉状态机，任何状态下可切）
  ctx.ipcMain.handle('tasks:set-pinned', (_event, id: unknown, pinned: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('tasks:set-pinned 需要任务 id');
    }
    if (typeof pinned !== 'boolean') {
      throw new Error('tasks:set-pinned 需要 boolean pinned');
    }
    return taskRepo.setPinned(ctx.db, id, pinned);
  });

  // Codex 对齐（additive）：重命名任务——trim 后非空校验在仓储层，成功后广播 tasks:changed
  ctx.ipcMain.handle('tasks:rename', (event, id: unknown, title: unknown) => {
    guard(event, 'tasks:rename');
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('tasks:rename 需要任务 id');
    }
    if (typeof title !== 'string') {
      throw new Error('tasks:rename 需要 string title');
    }
    const task = taskRepo.rename(ctx.db, id, title);
    broadcast();
    return task;
  });

  // Codex 对齐（additive）：删除任务——worktree 任务先做尽力而为的磁盘清理
  // （cleanupWorktree 幂等；清理失败不阻断删除，仅 console.warn），成功后广播 tasks:changed
  ctx.ipcMain.handle('tasks:remove', (event, id: unknown) => {
    guard(event, 'tasks:remove');
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('tasks:remove 需要任务 id');
    }
    const task = taskRepo.getById(ctx.db, id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (task.use_worktree === 1) {
      try {
        // 任务行随之消失，cowork/<taskId> 逃生舱分支一并删除（无保留意义）
        cleanupWorktree(ctx.db, ctx.dataDir, id, { deleteBranch: true });
      } catch (err) {
        console.warn(`[services/tasks] 删除任务 ${id} 的 worktree 清理失败（不阻断删除）:`, err);
      }
    }
    taskRepo.remove(ctx.db, id);
    broadcast();
    return { ok: true as const };
  });
}
