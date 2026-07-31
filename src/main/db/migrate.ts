import type Database from 'better-sqlite3';

export interface Migration {
  name: string;
  sql: string;
}

/**
 * 迁移 runner：按文件名顺序执行 src/main/db/migrations/ 下的迁移，
 * PRAGMA user_version 记录已执行到的版本（编号 = 文件名数字前缀）。
 * 每个迁移独立事务；已执行的跳过。
 *
 * 新增迁移只需在 migrations/ 目录新建 NNN_name.ts（见 001_initial.ts 头注释），
 * import.meta.glob 自动收集，无需编辑本文件。
 */
const modules = import.meta.glob('./migrations/*.ts', { eager: true }) as Record<
  string,
  { default: Migration }
>;

const migrations: { version: number; migration: Migration }[] = Object.entries(modules)
  .map(([path, mod]) => {
    const file = path.split('/').pop() ?? '';
    const version = Number.parseInt(file.split('_')[0] ?? '', 10);
    if (!Number.isFinite(version)) throw new Error(`迁移文件名缺少数字前缀: ${path}`);
    if (!mod.default?.sql) throw new Error(`迁移缺少默认导出 { name, sql }: ${path}`);
    return { version, migration: mod.default };
  })
  .sort((a, b) => a.version - b.version);

export function runMigrations(db: Database.Database): number {
  const row = db.pragma('user_version', { simple: true }) as number;
  let current = row;
  for (const { version, migration } of migrations) {
    if (version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${version}`);
    })();
    current = version;
  }
  return current;
}

/** 测试与排障用：列出全部已知迁移版本 */
export function knownMigrationVersions(): number[] {
  return migrations.map((m) => m.version);
}
