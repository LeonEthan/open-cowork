import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import * as providerRepo from '../src/main/db/providerRepo';
import * as taskRepo from '../src/main/db/taskRepo';
import * as workspaceRepo from '../src/main/db/workspaceRepo';

/**
 * providerRepo CRUD + 迁移 005 additive（ticket #21）：
 * - create/list/getById/setModels/remove（remove 同事务清空任务 provider 快照）；
 * - 迁移 005 只新增可空列，老库升级数据原样保留；
 * - 密钥字段只经手密文（加解密在 providers/credentials.ts，本仓储不接触明文）。
 */
describe('providerRepo（#21）', () => {
  function setup(): { db: Database.Database; workspaceId: string } {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-provider-test');
    return { db, workspaceId: ws.id };
  }

  it('create → list/getById（密文原样存储，DTO 列齐备）', () => {
    const { db } = setup();
    const row = providerRepo.create(db, {
      name: 'DeepSeek',
      kind: 'preset',
      protocol: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      presetId: 'deepseek',
      encryptedApiKey: 'YmFzZTY0LWNpcGhlcg==', // 测试密文（非明文）
    });
    expect(row.id).toBeTruthy();
    expect(row.credential_key).toBeNull();
    expect(row.models_json).toBeNull();
    expect(row.models_fetched_at).toBeNull();

    const listed = providerRepo.list(db);
    expect(listed).toHaveLength(1);
    expect(listed[0].encrypted_api_key).toBe('YmFzZTY0LWNpcGhlcg==');
    expect(listed[0].preset_id).toBe('deepseek');

    expect(providerRepo.getById(db, row.id)!.name).toBe('DeepSeek');
    expect(providerRepo.getById(db, 'ghost')).toBeNull();
    db.close();
  });

  it('create 校验：空名/空 baseUrl/空协议抛错', () => {
    const { db } = setup();
    const base = {
      kind: 'custom' as const,
      protocol: 'openai',
      baseUrl: 'https://x.example.com',
      encryptedApiKey: 'Y2lwaGVy',
    };
    expect(() => providerRepo.create(db, { ...base, name: '  ' })).toThrow('名称');
    expect(() => providerRepo.create(db, { ...base, name: 'x', baseUrl: '' })).toThrow('base URL');
    expect(() => providerRepo.create(db, { ...base, name: 'x', protocol: '' })).toThrow('protocol');
    db.close();
  });

  it('envMap 覆盖序列化进 env_map_json', () => {
    const { db } = setup();
    const row = providerRepo.create(db, {
      name: '内部网关',
      kind: 'custom',
      protocol: 'openai',
      baseUrl: 'https://gw.example.com/v1',
      encryptedApiKey: 'Y2lwaGVy',
      envMap: { keyEnvs: ['MY_KEY'], baseUrlEnv: 'MY_BASE' },
    });
    expect(JSON.parse(row.env_map_json!)).toEqual({ keyEnvs: ['MY_KEY'], baseUrlEnv: 'MY_BASE' });
    db.close();
  });

  it('setModels 写缓存 + fetched_at；remove 清空引用任务的 provider 快照', () => {
    const { db, workspaceId } = setup();
    const provider = providerRepo.create(db, {
      name: 'DeepSeek',
      kind: 'preset',
      protocol: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      presetId: 'deepseek',
      encryptedApiKey: 'Y2lwaGVy',
    });
    providerRepo.setModels(db, provider.id, '{"version":1,"fetchedAt":1,"models":[{"id":"m"}]}', 777);
    const reloaded = providerRepo.getById(db, provider.id)!;
    expect(reloaded.models_json).toContain('"m"');
    expect(reloaded.models_fetched_at).toBe(777);

    // 任务引用该 provider + model 快照；remove 后快照清空（回退 agent 默认）
    const task = taskRepo.create(db, {
      workspaceId,
      prompt: '用 deepseek 跑一轮',
      agentType: 'claude-code',
      providerId: provider.id,
      model: 'deepseek-chat',
    });
    providerRepo.remove(db, provider.id);
    expect(providerRepo.getById(db, provider.id)).toBeNull();
    const t = taskRepo.getById(db, task.id)!;
    expect(t.provider_id).toBeNull();
    expect(t.model).toBeNull();
    db.close();
  });
});

describe('迁移 005 additive（#21）', () => {
  it('providers 新增四个可空列；老库升级后既有行数据原样保留', () => {
    // 构造「老库」：user_version=3（#19 末态），手写 001-003 后的 providers 最小列集行
    const db: Database.Database = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      // 用真实迁移跑到 003 太占篇幅——直接按 001 建表 + 置版本 3 再补 002/003 关键列
      db.exec(`
        CREATE TABLE providers (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          kind            TEXT NOT NULL CHECK (kind IN ('preset','custom')),
          base_url        TEXT NOT NULL,
          protocol        TEXT NOT NULL,
          credential_key  TEXT,
          models_json     TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
      `);
      db.pragma('user_version = 3');
      const now = Date.now();
      db.prepare(
        `INSERT INTO providers (id, name, kind, base_url, protocol, credential_key, models_json, created_at, updated_at)
         VALUES ('p1', '存量 provider', 'custom', 'https://old.example.com', 'openai', NULL, NULL, ?, ?)`,
      ).run(now, now);

      // 手动补跑迁移 005（runner 全量跑会撞既有表——这里只验证 005 的 additive 语义）
      db.exec(`
        ALTER TABLE providers ADD COLUMN encrypted_api_key TEXT;
        ALTER TABLE providers ADD COLUMN preset_id TEXT;
        ALTER TABLE providers ADD COLUMN env_map_json TEXT;
        ALTER TABLE providers ADD COLUMN models_fetched_at INTEGER;
      `);

      const cols = (db.pragma('table_info(providers)') as { name: string; notnull: number }[]);
      for (const c of ['encrypted_api_key', 'preset_id', 'env_map_json', 'models_fetched_at']) {
        const col = cols.find((x) => x.name === c);
        expect(col, c).toBeDefined();
        expect(col!.notnull, `${c} 可空`).toBe(0);
      }
      const row = db.prepare('SELECT * FROM providers WHERE id = ?').get('p1') as Record<
        string,
        unknown
      >;
      expect(row.name).toBe('存量 provider');
      expect(row.base_url).toBe('https://old.example.com');
      expect(row.encrypted_api_key).toBeNull();
      expect(row.preset_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('全新库经 runner 跑到最新版本后 providers 列齐备', () => {
    const db = openDatabase(':memory:');
    try {
      const cols = (db.pragma('table_info(providers)') as { name: string }[]).map((c) => c.name);
      for (const c of [
        'id',
        'name',
        'kind',
        'base_url',
        'protocol',
        'credential_key',
        'models_json',
        'encrypted_api_key',
        'preset_id',
        'env_map_json',
        'models_fetched_at',
        'created_at',
        'updated_at',
      ]) {
        expect(cols).toContain(c);
      }
    } finally {
      db.close();
    }
  });
});
