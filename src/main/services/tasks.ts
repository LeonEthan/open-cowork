import * as taskRepo from '../db/taskRepo';
import type { TaskStatus } from '../db/entities';
import { createTaskWorktree } from '../worktree/worktree';
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
}
