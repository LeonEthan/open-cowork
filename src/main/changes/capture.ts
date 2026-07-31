import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/database';
import type { FileChange, Task } from '../db/entities';
import * as fileChangesRepo from '../db/fileChangesRepo';
import * as taskRepo from '../db/taskRepo';
import * as workspaceRepo from '../db/workspaceRepo';
import { captureGitChanges, isGitRepo, revParseHead } from './git';
import { captureSnapshotChanges, createBaseline } from './snapshot';

/**
 * 捕获编排（ticket #24）：任务开始 pin 基准，turn_end 后捕获归一 FileChange。
 *
 * 目录布局（<dataDir> = OPEN_COWORK_DATA_DIR 覆盖后的数据根）：
 *   snapshots/<taskId>/baseline/         非 git 兜底：任务开始时的工作区拷贝
 *   snapshots/<taskId>/rollback-backup/  回滚前的文件备份（「恢复」来源，review.ts）
 *
 * 捕获目标路径（编排者附注 1，与终端 cwd 同解析模式）：
 *   task.worktree_path ?? workspace.path（#25 会填 worktree_path）。
 *
 * git 基准：任务开始时 pin base SHA（rev-parse HEAD → tasks.base_sha，写一次，
 * fileChangesRepo.setTaskBaseSha 把关）；追问轮不重 pin——同一任务的变更始终
 * 相对任务开始前的基点量起。无提交的库 pin 不到，捕获时一切皆新增。
 *
 * 非 git 基准：任务开始时快照 baseline（幂等）；追问轮不重建。
 */

export function snapshotsDir(dataDir: string, taskId: string): string {
  return join(dataDir, 'snapshots', taskId);
}

export function baselineDir(dataDir: string, taskId: string): string {
  return join(snapshotsDir(dataDir, taskId), 'baseline');
}

export function rollbackBackupDir(dataDir: string, taskId: string): string {
  return join(snapshotsDir(dataDir, taskId), 'rollback-backup');
}

/** 捕获根目录解析（worktree 优先；workspace 行必须存在） */
export function captureRootFor(db: Database, task: Task): string {
  if (task.worktree_path) return task.worktree_path;
  const ws = workspaceRepo.getById(db, task.workspace_id);
  if (!ws) throw new Error(`workspace 不存在: ${task.workspace_id}`);
  return ws.path;
}

/**
 * 任务开始时 pin 基准（services/agent.ts start/followup 调用；幂等）。
 * git：写 tasks.base_sha（仅一次）；非 git：建 baseline 快照（已存在跳过）。
 */
export function prepareTaskCapture(db: Database, taskId: string, dataDir: string): void {
  const task = taskRepo.getById(db, taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  const root = captureRootFor(db, task);
  if (isGitRepo(root)) {
    if (!task.base_sha) {
      const sha = revParseHead(root);
      if (sha) fileChangesRepo.setTaskBaseSha(db, taskId, sha);
    }
    return;
  }
  createBaseline(root, baselineDir(dataDir, taskId));
}

/**
 * turn_end(completed) 后的捕获：重算「工作区 vs 基准」全量 delta 落库。
 * pending 行 supersede / accepted 复用语义见 fileChangesRepo.applyCapture。
 * git 来源补 pin（start 时未走 prepare 的兜底——如老任务）；非 git 补建 baseline
 * （重启/异常后首捕获的兜底：此时 baseline≈当前态，delta 为空，不炸即可）。
 */
export function captureTaskChanges(db: Database, taskId: string, dataDir: string): FileChange[] {
  const task = taskRepo.getById(db, taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  const root = captureRootFor(db, task);

  if (isGitRepo(root)) {
    let baseSha = task.base_sha;
    if (!baseSha) {
      baseSha = revParseHead(root);
      if (baseSha) fileChangesRepo.setTaskBaseSha(db, taskId, baseSha);
    }
    const changes = captureGitChanges(root, baseSha);
    return fileChangesRepo.applyCapture(db, taskId, changes, { source: 'git', baseSha });
  }

  const baseline = baselineDir(dataDir, taskId);
  if (!existsSync(baseline)) createBaseline(root, baseline);
  const changes = captureSnapshotChanges(root, baseline);
  return fileChangesRepo.applyCapture(db, taskId, changes, { source: 'snapshot', baseSha: null });
}
