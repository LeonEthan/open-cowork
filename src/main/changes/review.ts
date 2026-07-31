import { copyFileSync, existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from '../db/database';
import type { FileChange } from '../db/entities';
import * as fileChangesRepo from '../db/fileChangesRepo';
import * as taskRepo from '../db/taskRepo';
import { baselineDir, captureRootFor, rollbackBackupDir } from './capture';
import { readBaseFile } from './git';

/**
 * 复查决议与回滚/恢复（ticket #24 / ARCHITECTURE §7）。
 *
 * ── 回滚（pending → reverted）──
 * 1. 回滚前把当前文件内容备份到 snapshots/<taskId>/rollback-backup/<path>
 *    （每文件一个备份槽：重复「回滚→恢复→再回滚」循环时覆盖为最新回滚前状态，
 *    恢复语义始终是「回到最近一次回滚前的样子」；编排者附注 2 的 <序号> 布局
 *    在本票简化为单槽——多代历史无消费方，见报告 concerns）；
 * 2. 按捕获来源还原工作区：
 *    git：modified/deleted → `git show <base>:<path>` 写回（不用 checkout——
 *         永不碰 index / 永不 commit，测试断言 git log 与 index 不变）；
 *         added → 删除文件（并向上清理空目录）；
 *    snapshot：modified/deleted → 从 baseline 拷回；added → 删除文件；
 * 3. fileChangesRepo.resolve 落库（snapshot_path = 备份路径；回滚前文件不存在为 null）。
 *
 * ── 恢复（reverted → pending）──
 * snapshot_path 非空：备份拷回工作区；为 null（回滚前文件本不存在）：删除该文件。
 * 恢复后改动重新出现在工作区，行回 pending 待复查。
 *
 * ── 任务级整体操作 ──
 * 全部接受：pending 批量 → accepted；全部回滚：逐文件回滚（部分失败即抛错，
 * 已完成的行保持 reverted、重试幂等）。两者完成后 awaiting_review → done
 * （taskRepo.updateStatus 经 taskStateMachine.assertTransition 把关）。
 * 文件级操作只改 file_changes.status，不碰任务状态。
 *
 * 快照期保留：done/cancelled 后 snapshots 目录不清理（清理策略属 #25），
 * 因此恢复/文件级回滚在 done 后仍可用。
 */

/** FileChange.path 必须是不逃逸捕获根的 posix 相对路径 */
export function assertSafeRelativePath(p: string): void {
  if (
    p.length === 0 ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.split('/').some((seg) => seg === '..' || seg === '')
  ) {
    throw new Error(`非法相对路径: ${JSON.stringify(p)}`);
  }
}

/** 删除文件后向上清理空目录（不越出 root；非空即停） */
function pruneEmptyDirs(root: string, relPath: string): void {
  let dir = dirname(relPath);
  while (dir !== '.' && dir !== '') {
    try {
      rmdirSync(join(root, dir));
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}

/** 回滚前备份当前文件；文件不存在（回滚 deleted 行）返回 null */
function backupCurrent(root: string, relPath: string, backupDir: string): string | null {
  const abs = join(root, relPath);
  if (!existsSync(abs)) return null;
  const dest = join(backupDir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(abs, dest);
  return dest;
}

/** 还原工作区到基准（回滚的工作区侧；备份已先行完成） */
function revertInWorkspace(
  db: Database,
  dataDir: string,
  row: FileChange,
  root: string,
): void {
  const abs = join(root, row.path);
  if (row.change_type === 'renamed') {
    // 捕获不产 renamed（git staged rename 拆 删+增，快照同口径）——防御性拒绝
    throw new Error(`renamed 类型不由捕获产生，拒绝回滚: ${row.path}`);
  }
  if (row.change_type === 'added') {
    rmSync(abs, { force: true });
    pruneEmptyDirs(root, row.path);
    return;
  }
  // modified / deleted：从基准还原内容
  const source = row.source ?? (row.base_sha ? 'git' : 'snapshot'); // 006 前旧行兜底
  if (source === 'git') {
    if (!row.base_sha) throw new Error(`git 来源缺 base_sha，无法回滚: ${row.path}`);
    const content = readBaseFile(root, row.base_sha, row.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return;
  }
  const from = join(baselineDir(dataDir, row.task_id), row.path);
  if (!existsSync(from)) throw new Error(`baseline 缺失，无法回滚: ${row.path}`);
  mkdirSync(dirname(abs), { recursive: true });
  copyFileSync(from, abs);
}

function mustRow(db: Database, id: string): FileChange {
  const row = fileChangesRepo.getById(db, id);
  if (!row) throw new Error(`变更记录不存在: ${id}`);
  assertSafeRelativePath(row.path);
  return row;
}

/** 文件级接受：pending → accepted（不改工作区——接受即保留现状） */
export function acceptChange(db: Database, id: string): void {
  const row = mustRow(db, id);
  if (row.status !== 'pending') throw new Error(`仅待复查的变更可接受（当前 ${row.status}）`);
  fileChangesRepo.resolve(db, id, 'accepted', null);
}

/** 文件级回滚：备份 → 还原基准 → pending → reverted */
export function rollbackChange(db: Database, dataDir: string, id: string): void {
  const row = mustRow(db, id);
  if (row.status !== 'pending') throw new Error(`仅待复查的变更可回滚（当前 ${row.status}）`);
  const task = taskRepo.getById(db, row.task_id);
  if (!task) throw new Error(`任务不存在: ${row.task_id}`);
  const root = captureRootFor(db, task);
  const backup = backupCurrent(root, row.path, rollbackBackupDir(dataDir, row.task_id));
  revertInWorkspace(db, dataDir, row, root);
  fileChangesRepo.resolve(db, id, 'reverted', backup);
}

/** 恢复：回滚的改动拷回工作区（reverted → pending）；备份槽保留供再回滚 */
export function restoreChange(db: Database, dataDir: string, id: string): void {
  const row = mustRow(db, id);
  if (row.status !== 'reverted') throw new Error(`仅已回滚的变更可恢复（当前 ${row.status}）`);
  const task = taskRepo.getById(db, row.task_id);
  if (!task) throw new Error(`任务不存在: ${row.task_id}`);
  const root = captureRootFor(db, task);
  const abs = join(root, row.path);
  if (row.snapshot_path) {
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(row.snapshot_path, abs);
  } else {
    // 回滚前文件不存在（被回滚的是 deleted 行）→ 恢复 = 再删一次
    rmSync(abs, { force: true });
    pruneEmptyDirs(root, row.path);
  }
  fileChangesRepo.reopenAsPending(db, id);
}

/** 任务级整体接受：全部 pending → accepted，任务 awaiting_review → done */
export function acceptAll(db: Database, taskId: string): void {
  const task = taskRepo.getById(db, taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  db.prepare(
    "UPDATE file_changes SET status = 'accepted', resolved_at = ? WHERE task_id = ? AND status = 'pending'",
  ).run(Date.now(), taskId);
  // 状态机把关：非 awaiting_review 抛错（此时行已接受，但那是幂等的同向迁移，安全）
  taskRepo.updateStatus(db, taskId, 'done');
}

/** 任务级整体回滚：逐文件回滚全部 pending（部分失败抛错、可重试），完成后 → done */
export function rollbackAll(db: Database, dataDir: string, taskId: string): void {
  const task = taskRepo.getById(db, taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  const pending = fileChangesRepo
    .listByTask(db, taskId)
    .filter((r) => r.status === 'pending');
  const failures: string[] = [];
  for (const row of pending) {
    try {
      rollbackChange(db, dataDir, row.id);
    } catch (err) {
      failures.push(`${row.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`部分文件回滚失败（已成功的保持已回滚，可重试）：${failures.join('；')}`);
  }
  taskRepo.updateStatus(db, taskId, 'done');
}
