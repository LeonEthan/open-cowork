import { captureRootFor } from '../changes/capture';
import * as taskRepo from '../db/taskRepo';
import { commitAll, compareWithBase, push, workingSummary } from '../git';
import type { ServiceContext } from './index';

/**
 * git 操作服务（ticket #39，Codex Environment 对齐：检查栏「变更」tab 增强）。
 *
 * 通道：
 * - git:working-summary    分支行数据（分支名 + upstream ahead/behind；非 git 不抛，isGitRepo=false）；
 * - git:commit-all         git add -A + commit -m（无改动 / 空信息 reject 中文可读错误）；
 * - git:push               git push -u origin HEAD（失败 reject stderr 首行摘要）；
 * - git:compare-with-base  worktree 任务：工作区（含未提交）vs base_sha 的文件清单与 +/- 统计；
 *                          非 worktree 或无 base → supported=false。
 *
 * cwd 一律解析为 task.worktree_path ?? workspace.path（captureRootFor）。
 * commit/push 成功后广播 tasks:changed（renderer 重拉任务行与变更快照）。
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

  /** 任务存在性校验 + cwd 解析（worktree_path ?? workspace.path） */
  const mustTaskRoot = (taskId: string): string => {
    const task = taskRepo.getById(ctx.db, taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    return captureRootFor(ctx.db, task);
  };

  ctx.ipcMain.handle('git:working-summary', (event, taskId: unknown) => {
    guard(event, 'git:working-summary');
    return workingSummary(mustTaskRoot(mustString(taskId, '任务 id')));
  });

  ctx.ipcMain.handle('git:commit-all', (event, taskId: unknown, message: unknown) => {
    guard(event, 'git:commit-all');
    const result = commitAll(
      mustTaskRoot(mustString(taskId, '任务 id')),
      mustString(message, '提交信息'),
    );
    broadcast();
    return result;
  });

  ctx.ipcMain.handle('git:push', (event, taskId: unknown) => {
    guard(event, 'git:push');
    const result = push(mustTaskRoot(mustString(taskId, '任务 id')));
    broadcast();
    return result;
  });

  ctx.ipcMain.handle('git:compare-with-base', (event, taskId: unknown) => {
    guard(event, 'git:compare-with-base');
    const id = mustString(taskId, '任务 id');
    const task = taskRepo.getById(ctx.db, id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    // 仅 worktree 任务（有 pin 的 base SHA）支持对比；其余 supported=false 由 UI 隐藏入口
    if (task.use_worktree !== 1 || !task.base_sha) {
      return { supported: false, baseLabel: null, files: [], insertions: 0, deletions: 0 };
    }
    return compareWithBase(captureRootFor(ctx.db, task), task.base_sha);
  });
}
