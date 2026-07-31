import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Database } from './database';
import type { Workspace } from './entities';

/**
 * Workspace 仓储（ticket #18）：本地目录即 workspace。
 * 纯 Node 无 Electron 依赖，vitest 可直接用 ':memory:' 跑。
 *
 * 约定：path 全局唯一（DB UNIQUE 约束），重复添加幂等返回既有行并刷新 last_opened_at；
 * remove 级联清掉其下任务及任务子行（turns/messages/tool_calls/approvals/file_changes/usage_records），
 * 单事务执行。
 */

export function list(db: Database): Workspace[] {
  return db
    .prepare('SELECT * FROM workspaces ORDER BY created_at ASC, id ASC')
    .all() as Workspace[];
}

export function getById(db: Database, id: string): Workspace | null {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
    | Workspace
    | undefined;
  return row ?? null;
}

/** 添加本地目录为 workspace；path 已存在时幂等返回既有行（并刷新 last_opened_at） */
export function add(db: Database, dirPath: string, now: number = Date.now()): Workspace {
  const existing = db
    .prepare('SELECT * FROM workspaces WHERE path = ?')
    .get(dirPath) as Workspace | undefined;
  if (existing) {
    db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(now, existing.id);
    return { ...existing, last_opened_at: now };
  }
  const ws: Workspace = {
    id: randomUUID(),
    path: dirPath,
    name: basename(dirPath) || dirPath,
    created_at: now,
    last_opened_at: now,
  };
  db.prepare(
    'INSERT INTO workspaces (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)',
  ).run(ws.id, ws.path, ws.name, ws.created_at, ws.last_opened_at);
  return ws;
}

/** 移除 workspace：级联删除其任务与任务子行，单事务 */
export function remove(db: Database, id: string): void {
  db.transaction(() => {
    const taskIds = (
      db.prepare('SELECT id FROM tasks WHERE workspace_id = ?').all(id) as { id: string }[]
    ).map((r) => r.id);
    for (const taskId of taskIds) {
      for (const table of [
        'usage_records',
        'file_changes',
        'approvals',
        'tool_calls',
        'messages',
        'turns',
      ] as const) {
        db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
      }
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    }
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  })();
}
