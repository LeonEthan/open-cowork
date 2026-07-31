import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/main/db/database';
import { knownMigrationVersions, runMigrations } from '../src/main/db/migrate';
import { resolveDataDir } from '../src/shared/paths';

const TEN_ENTITIES = [
  'workspaces',
  'tasks',
  'turns',
  'messages',
  'tool_calls',
  'approvals',
  'file_changes',
  'usage_records',
  'providers',
  'custom_agents',
];

describe('walking skeleton sanity', () => {
  it('迁移 runner 在内存库建出十实体表 + FTS5 虚表，并推进 user_version', () => {
    const db = openDatabase(':memory:');
    try {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table')")
          .all() as { name: string }[]
      ).map((r) => r.name);

      for (const t of TEN_ENTITIES) expect(tables, `缺少表 ${t}`).toContain(t);
      expect(tables).toContain('messages_fts');

      const version = db.pragma('user_version', { simple: true }) as number;
      expect(version).toBe(Math.max(...knownMigrationVersions()));

      // 幂等：重复执行不报错、版本不变
      expect(runMigrations(db)).toBe(version);

      // 端到端小回路：建 workspace → task → message，FTS 触发器同步可 MATCH
      const now = Date.now();
      db.prepare(
        'INSERT INTO workspaces (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)',
      ).run('w1', '/tmp/w1', 'w1', now, now);
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, title, prompt, agent_type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('t1', 'w1', 'hello', 'do something', 'claude-code', 'ready', now, now);
      db.prepare(
        'INSERT INTO messages (id, task_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('m1', 't1', 'user', 'hello walking skeleton', 1, now);

      const hits = db
        .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
        .all('walking') as { rowid: number }[];
      expect(hits).toHaveLength(1);

      // Task 六态 CHECK 约束生效（六态 + failed/cancelled 之外一律拒绝）
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (id, workspace_id, title, agent_type, status, created_at, updated_at)
             VALUES ('t2', 'w1', 'x', 'pi', 'bogus', 1, 1)`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('OPEN_COWORK_DATA_DIR 可覆盖数据根目录，默认 ~/.open-cowork', () => {
    expect(resolveDataDir({ OPEN_COWORK_DATA_DIR: '/tmp/oc-test' })).toBe('/tmp/oc-test');
    expect(resolveDataDir({})).toMatch(/\.open-cowork$/);
  });
});
