import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 应用数据根目录。
 * 默认 ~/.open-cowork/；可用环境变量 OPEN_COWORK_DATA_DIR 覆盖
 * （e2e、并行开发隔离测试数据都依赖它）。
 *
 * 目录布局（子目录名见 DATA_SUBDIRS）：
 *   <root>/open-cowork.db   全局单一 SQLite（十实体，WAL + FTS5）
 *   <root>/events/          agent 原始事件流 JSONL 旁路（排障/回放）
 *   <root>/worktrees/       per-task opt-in worktree 集中存放（ARCHITECTURE §8）
 *   <root>/snapshots/       非 git 任务基准快照 + 回滚备份（ticket #24，ARCHITECTURE §7）
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPEN_COWORK_DATA_DIR ?? join(homedir(), '.open-cowork');
}

export const DATA_SUBDIRS = ['events', 'worktrees', 'snapshots'] as const;

export const DB_FILE_NAME = 'open-cowork.db';
