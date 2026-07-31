import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './migrate';

/** better-sqlite3 连接实例类型（供 main 服务与测试复用） */
export type Database = BetterSqlite3.Database;

/**
 * 打开全局单一 SQLite（better-sqlite3 + WAL + 外键约束），并执行未应用的迁移。
 * 本模块不依赖 Electron——纯 Node，vitest 可直接用 ':memory:' 跑。
 */
export function openDatabase(file: string): Database {
  const db = new BetterSqlite3(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
