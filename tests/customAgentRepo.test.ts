import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import * as customAgentRepo from '../src/main/db/customAgentRepo';

/**
 * CustomAgent 仓库（ticket #26）：注册 CRUD + 迁移 008（last_probe_json，additive）+
 * 注册入参校验 + 探测快照回写。
 */
describe('customAgentRepo（迁移 008 + CRUD）', () => {
  const tmpDirs: string[] = [];
  afterAll(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  const freshDb = async (): Promise<ReturnType<typeof openDatabase>> => {
    const dir = await mkdtemp(join(tmpdir(), 'open-cowork-ca-'));
    tmpDirs.push(dir);
    return openDatabase(join(dir, 'open-cowork.db'));
  };

  it('迁移 008：custom_agents 含 last_probe_json 可空列', async () => {
    const db = await freshDb();
    try {
      const cols = (db.pragma('table_info(custom_agents)') as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('last_probe_json');
      // 既有列保持（迁移 001 本体不动）
      for (const c of ['id', 'name', 'command', 'args_json', 'protocol', 'env_json', 'created_at']) {
        expect(cols).toContain(c);
      }
    } finally {
      db.close();
    }
  });

  it('create/list/getById/remove 全链路；args/env JSON 往返', async () => {
    const db = await freshDb();
    try {
      const row = customAgentRepo.create(db, {
        name: 'my-acp',
        command: '/opt/fake/my-acp',
        args: ['serve', '--port', '9'],
        env: { FOO: 'bar' },
      });
      expect(row.protocol).toBe('acp');
      expect(row.last_probe_json).toBeNull();

      const got = customAgentRepo.getById(db, row.id);
      expect(got?.name).toBe('my-acp');
      expect(customAgentRepo.parseArgs(got!)).toEqual(['serve', '--port', '9']);
      expect(customAgentRepo.parseEnv(got!)).toEqual({ FOO: 'bar' });

      const list = customAgentRepo.list(db);
      expect(list).toHaveLength(1);
      expect(list[0]!.command).toBe('/opt/fake/my-acp');

      expect(customAgentRepo.remove(db, row.id)).toBe(true);
      expect(customAgentRepo.getById(db, row.id)).toBeNull();
      expect(customAgentRepo.remove(db, row.id)).toBe(false); // 幂等：重复删除
    } finally {
      db.close();
    }
  });

  it('updateLastProbe 回写快照并可解析', async () => {
    const db = await freshDb();
    try {
      const row = customAgentRepo.create(db, { name: 'a', command: '/x/a', args: [] });
      const snapshot = { ok: true, resolvedPath: '/x/a', version: 'v1', error: null, at: 7 };
      customAgentRepo.updateLastProbe(db, row.id, JSON.stringify(snapshot));
      const got = customAgentRepo.getById(db, row.id);
      expect(JSON.parse(got!.last_probe_json!)).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('注册校验：空名/空命令/坏 args/坏 env 名一律拒绝', async () => {
    const db = await freshDb();
    try {
      expect(() => customAgentRepo.create(db, { name: '  ', command: '/x', args: [] })).toThrow(
        '名称',
      );
      expect(() => customAgentRepo.create(db, { name: 'a', command: ' ', args: [] })).toThrow(
        '命令',
      );
      expect(() =>
        customAgentRepo.create(db, { name: 'a', command: '/x', args: [1 as unknown as string] }),
      ).toThrow('参数');
      expect(() =>
        customAgentRepo.create(db, { name: 'a', command: '/x', args: [], env: { '1BAD': 'v' } }),
      ).toThrow('环境变量名');
      // 合法边界：无 env 空对象 → env_json NULL
      const row = customAgentRepo.create(db, { name: 'a', command: '/x', args: [], env: {} });
      expect(row.env_json).toBeNull();
    } finally {
      db.close();
    }
  });
});
