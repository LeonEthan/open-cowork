import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import { knownMigrationVersions, runMigrations } from '../src/main/db/migrate';
import m001 from '../src/main/db/migrations/001_initial';

/**
 * 迁移 additive 性（ticket #18 迁移 002）：
 * - 002 只新增可空列 session_id，不动既有列与数据；
 * - 老库（仅应用过 001，且已有任务行）升级后数据原样保留。
 */
describe('migrations additive（#18）', () => {
  const tmpDirs: string[] = [];
  afterAll(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  it('tasks 表含 session_id 可空列；既有行升级后数据保留', () => {
    // 构造「老库」：只应用迁移 001，并写入一行任务（此时无 session_id 列）
    const db: Database.Database = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(m001.sql);
      db.pragma('user_version = 1');
      const now = Date.now();
      db.prepare(
        'INSERT INTO workspaces (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)',
      ).run('w1', '/tmp/oc-alpha', 'oc-alpha', now, now);
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, title, prompt, agent_type, status, created_at, updated_at)
         VALUES ('t1', 'w1', '存量任务', 'do it', 'pi', 'ready', ?, ?)`,
      ).run(now, now);

      // 升级：runner 只补跑 002
      const version = runMigrations(db);
      expect(version).toBe(Math.max(...knownMigrationVersions()));

      // 新列存在且可空
      const cols = (db.pragma('table_info(tasks)') as { name: string; notnull: number }[]).map(
        (c) => c.name,
      );
      expect(cols).toContain('session_id');

      // 存量行原样保留，session_id 为 NULL
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t1') as Record<
        string,
        unknown
      >;
      expect(row.title).toBe('存量任务');
      expect(row.status).toBe('ready');
      expect(row.session_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('文件库：写入后关闭重开，数据完整恢复（重启恢复链路）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-cowork-mig-'));
    tmpDirs.push(dir);
    const file = join(dir, 'open-cowork.db');

    const now = Date.now();
    let db = openDatabase(file);
    db.prepare(
      'INSERT INTO workspaces (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)',
    ).run('w1', '/tmp/oc-alpha', 'oc-alpha', now, now);
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, prompt, agent_type, status, created_at, updated_at)
       VALUES ('t1', 'w1', '重启恢复验证', 'persist me', 'claude-code', 'ready', ?, ?)`,
    ).run(now, now);
    db.close();

    db = openDatabase(file); // 重开同一文件（模拟应用重启）
    try {
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get('w1') as Record<
        string,
        unknown
      >;
      expect(ws.path).toBe('/tmp/oc-alpha');
      const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
      expect(t.title).toBe('重启恢复验证');
      expect(t.status).toBe('ready');
    } finally {
      db.close();
    }
  });
});
