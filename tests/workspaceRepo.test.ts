import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import * as workspaceRepo from '../src/main/db/workspaceRepo';
import * as taskRepo from '../src/main/db/taskRepo';

/** workspace 仓储（ticket #18）：增删查、path 幂等、级联删除 */
describe('workspaceRepo', () => {
  it('add/list/getById：添加本地目录并持久化', () => {
    const db = openDatabase(':memory:');
    try {
      const ws = workspaceRepo.add(db, '/tmp/oc-alpha', 1000);
      expect(ws.id).toBeTruthy();
      expect(ws.name).toBe('oc-alpha');
      expect(ws.path).toBe('/tmp/oc-alpha');

      const ws2 = workspaceRepo.add(db, '/tmp/oc-beta', 2000);
      const all = workspaceRepo.list(db);
      expect(all).toHaveLength(2);
      expect(all.map((w) => w.id)).toEqual([ws.id, ws2.id]); // created_at 升序

      expect(workspaceRepo.getById(db, ws.id)?.path).toBe('/tmp/oc-alpha');
      expect(workspaceRepo.getById(db, 'nope')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('path 唯一：重复添加幂等返回既有行并刷新 last_opened_at', () => {
    const db = openDatabase(':memory:');
    try {
      const first = workspaceRepo.add(db, '/tmp/oc-alpha', 1000);
      const again = workspaceRepo.add(db, '/tmp/oc-alpha', 2000);
      expect(again.id).toBe(first.id);
      expect(again.last_opened_at).toBe(2000);
      expect(workspaceRepo.list(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('name 取目录 basename；根路径回退为路径本身', () => {
    const db = openDatabase(':memory:');
    try {
      expect(workspaceRepo.add(db, '/a/b/my-proj').name).toBe('my-proj');
      expect(workspaceRepo.add(db, '/').name).toBe('/');
    } finally {
      db.close();
    }
  });

  it('remove：级联删除 workspace 下任务及任务子行（turns/messages 等），单事务', () => {
    const db = openDatabase(':memory:');
    try {
      const ws = workspaceRepo.add(db, '/tmp/oc-alpha');
      const other = workspaceRepo.add(db, '/tmp/oc-beta');
      const t = taskRepo.create(db, {
        workspaceId: ws.id,
        prompt: '做一些事',
        agentType: 'claude-code',
      });
      const now = Date.now();
      db.prepare(
        "INSERT INTO turns (id, task_id, idx, status, started_at) VALUES ('tu1', ?, 1, 'running', ?)",
      ).run(t.id, now);
      db.prepare(
        "INSERT INTO messages (id, task_id, role, content, seq, created_at) VALUES ('m1', ?, 'user', 'hi', 1, ?)",
      ).run(t.id, now);
      const tOther = taskRepo.create(db, {
        workspaceId: other.id,
        prompt: '别动我',
        agentType: 'pi',
      });

      workspaceRepo.remove(db, ws.id);

      expect(workspaceRepo.list(db).map((w) => w.id)).toEqual([other.id]);
      expect(taskRepo.getById(db, t.id)).toBeNull();
      expect(db.prepare('SELECT COUNT(*) c FROM turns WHERE task_id = ?').get(t.id)).toEqual({
        c: 0,
      });
      expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE task_id = ?').get(t.id)).toEqual({
        c: 0,
      });
      // 其他 workspace 的任务不受影响
      expect(taskRepo.getById(db, tOther.id)?.title).toBe('别动我');
    } finally {
      db.close();
    }
  });
});
