/**
 * 迁移 006（ticket #24）：diff 复查与回滚支撑。
 * - file_changes.added / removed：diff 行统计（+N / -N；二进制或无 diff 文本时为 NULL）。
 * - file_changes.source：捕获来源——'git'（原生 status/diff）| 'snapshot'（非 git 快照兜底，
 *   ARCHITECTURE §7）。
 * - file_changes.base_sha：捕获时 pin 的 base SHA（git 来源；与 tasks.base_sha 同值，行级冗余
 *   供诊断与未来 worktree 回流（#25）消费；snapshot 来源为 NULL）。
 * - file_changes.capture_round：捕获轮次（追问后下一轮 turn_end 重新捕获递增；
 *   pending 行每轮 supersede——语义见 db/fileChangesRepo.ts）。
 * - file_changes.snapshot_path：回滚前备份的文件内容（snapshots/<taskId>/rollback-backup/...），
 *   「恢复」操作的来源；NULL = 未回滚，或回滚前该文件在工作区不存在（恢复 = 删除文件）。
 * 纯 additive：仅新增可空列，不动既有列（status 沿用 001 的 CHECK：pending/accepted/reverted，
 * 「rolledback」即 'reverted'）与数据。
 */
export default {
  name: 'diff-review-rollback',
  sql: `
ALTER TABLE file_changes ADD COLUMN added INTEGER;
ALTER TABLE file_changes ADD COLUMN removed INTEGER;
ALTER TABLE file_changes ADD COLUMN source TEXT;
ALTER TABLE file_changes ADD COLUMN base_sha TEXT;
ALTER TABLE file_changes ADD COLUMN capture_round INTEGER;
ALTER TABLE file_changes ADD COLUMN snapshot_path TEXT;
`,
};
