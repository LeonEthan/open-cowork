import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import type { FileChange, FileChangeSource, FileChangeStatus, FileChangeType } from './entities';

/**
 * FileChange 仓储（ticket #24：diff 复查与回滚）。
 * 纯 Node 无 Electron 依赖，vitest 可直接用 ':memory:' 跑。
 *
 * ── pending 行 supersede 语义（测试锁定，编排者附注 3）──
 * 每次捕获（turn_end 后）重算「工作区 vs 任务基准」的全量 delta：
 * 1. 删除该任务全部 pending 行（它们代表「上一轮未复查的 delta」，已被新计算取代）；
 * 2. accepted / reverted 行保留（复查历史 + 恢复依据）；
 * 3. 新 delta 中「path 与 diff 均与某 accepted 行相同」的变更不再重复出现——
 *    接受不改工作区，同一 delta 复查一次即可；agent 追加改动后 diff 变化则重新入列；
 * 4. reverted 行不复用：被回滚的变更若重新出现（agent 重做），照常入 pending。
 */
export interface CapturedChange {
  /** 捕获目标目录（worktree_path ?? workspace.path）的相对路径，posix 分隔 */
  path: string;
  changeType: FileChangeType;
  /** unified diff 文本；二进制为 null */
  diff: string | null;
  added: number | null;
  removed: number | null;
}

export interface CaptureMeta {
  source: FileChangeSource;
  /** git 来源 pin 的 base SHA；snapshot 为 null */
  baseSha: string | null;
}

export function listByTask(db: Database, taskId: string): FileChange[] {
  return db
    .prepare('SELECT * FROM file_changes WHERE task_id = ? ORDER BY created_at ASC, id ASC')
    .all(taskId) as FileChange[];
}

export function getById(db: Database, id: string): FileChange | null {
  const row = db.prepare('SELECT * FROM file_changes WHERE id = ?').get(id) as
    | FileChange
    | undefined;
  return row ?? null;
}

export function nextCaptureRound(db: Database, taskId: string): number {
  const row = db
    .prepare('SELECT MAX(capture_round) AS m FROM file_changes WHERE task_id = ?')
    .get(taskId) as { m: number | null };
  return (row.m ?? 0) + 1;
}

/**
 * 一轮捕获落库（单事务）：pending supersede + accepted 复用（语义见文件头）。
 * 返回本轮新插入的 pending 行。
 */
export function applyCapture(
  db: Database,
  taskId: string,
  changes: CapturedChange[],
  meta: CaptureMeta,
  now: number = Date.now(),
): FileChange[] {
  const round = nextCaptureRound(db, taskId);
  const inserted: FileChange[] = [];
  db.transaction(() => {
    db.prepare("DELETE FROM file_changes WHERE task_id = ? AND status = 'pending'").run(taskId);
    const acceptedSame = db.prepare(
      `SELECT 1 FROM file_changes
       WHERE task_id = ? AND path = ? AND status = 'accepted'
         AND (diff = ? OR (diff IS NULL AND ? IS NULL))
       LIMIT 1`,
    );
    const insert = db.prepare(
      `INSERT INTO file_changes (id, task_id, path, change_type, diff, status,
                                 added, removed, source, base_sha, capture_round, snapshot_path,
                                 created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    );
    for (const c of changes) {
      if (acceptedSame.get(taskId, c.path, c.diff, c.diff)) continue;
      const row: FileChange = {
        id: randomUUID(),
        task_id: taskId,
        path: c.path,
        change_type: c.changeType,
        diff: c.diff,
        status: 'pending',
        added: c.added,
        removed: c.removed,
        source: meta.source,
        base_sha: meta.baseSha,
        capture_round: round,
        snapshot_path: null,
        created_at: now,
        resolved_at: null,
      };
      insert.run(
        row.id,
        row.task_id,
        row.path,
        row.change_type,
        row.diff,
        row.added,
        row.removed,
        row.source,
        row.base_sha,
        row.capture_round,
        row.created_at,
      );
      inserted.push(row);
    }
  })();
  return inserted;
}

/**
 * pending → accepted / reverted（文件级决议落库）。
 * snapshotPath：reverted 时记录回滚前备份（「恢复」来源）；回滚前文件不存在则传 null。
 */
export function resolve(
  db: Database,
  id: string,
  status: Exclude<FileChangeStatus, 'pending'>,
  snapshotPath: string | null,
  now: number = Date.now(),
): void {
  db.prepare(
    "UPDATE file_changes SET status = ?, resolved_at = ?, snapshot_path = ? WHERE id = ? AND status = 'pending'",
  ).run(status, now, snapshotPath, id);
}

/** reverted → pending（「恢复」：回滚的改动被拷回工作区，重新待复查） */
export function reopenAsPending(db: Database, id: string): void {
  db.prepare(
    "UPDATE file_changes SET status = 'pending', resolved_at = NULL WHERE id = ? AND status = 'reverted'",
  ).run(id);
}

/**
 * pin 任务基准 SHA（ticket #24 additive）：git 捕获的 base，落 tasks.base_sha
 * （与 #25 worktree pin 同列同语义——「任务改动从哪个基点量起」）。仅允许写一次或同值重写。
 */
export function setTaskBaseSha(db: Database, taskId: string, sha: string): void {
  const row = db.prepare('SELECT base_sha FROM tasks WHERE id = ?').get(taskId) as
    | { base_sha: string | null }
    | undefined;
  if (!row) throw new Error(`任务不存在: ${taskId}`);
  if (row.base_sha !== null && row.base_sha !== sha) {
    throw new Error(`任务 ${taskId} 已 pin base SHA（${row.base_sha}），拒绝改写为 ${sha}`);
  }
  db.prepare('UPDATE tasks SET base_sha = ? WHERE id = ?').run(sha, taskId);
}
