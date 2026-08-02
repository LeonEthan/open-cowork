import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/db/database';
import * as taskRepo from '../src/main/db/taskRepo';
import * as workspaceRepo from '../src/main/db/workspaceRepo';

/** task 仓储（ticket #18）：创建即 ready、状态迁移经状态机把关、重启可恢复的列完整性 */
describe('taskRepo', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-alpha');
    return { db, ws };
  }

  it('create：入库为 ready，标题从需求描述首行派生，选择快照落库', () => {
    const { db, ws } = setup();
    try {
      const t = taskRepo.create(db, {
        workspaceId: ws.id,
        prompt: '  修复登录页的\n闪烁问题（第二行不进标题）',
        agentType: 'codex',
        providerId: null,
        model: null,
      });
      expect(t.status).toBe('ready');
      expect(t.title).toBe('修复登录页的');
      expect(t.agent_type).toBe('codex');
      expect(t.provider_id).toBeNull();
      expect(t.model).toBeNull();
      expect(t.session_id).toBeNull(); // #19 才填
      expect(t.permission_mode).toBe('auto');

      // 显式标题优先；provider/model 快照保留（provider_id 有 FK，先建 provider 行）
      const now = Date.now();
      db.prepare(
        `INSERT INTO providers (id, name, kind, base_url, protocol, created_at, updated_at)
         VALUES ('prov-1', 'DeepSeek', 'preset', 'https://api.deepseek.com', 'openai-compatible', ?, ?)`,
      ).run(now, now);
      const t2 = taskRepo.create(db, {
        workspaceId: ws.id,
        prompt: 'x',
        title: '自定义标题',
        agentType: 'pi',
        providerId: 'prov-1',
        model: 'glm-4',
      });
      expect(t2.title).toBe('自定义标题');
      expect(t2.provider_id).toBe('prov-1');
      expect(t2.model).toBe('glm-4');
    } finally {
      db.close();
    }
  });

  it('create：标题截断 40 字；空 prompt / 不存在 workspace 抛错', () => {
    const { db, ws } = setup();
    try {
      const long = taskRepo.create(db, {
        workspaceId: ws.id,
        prompt: '一'.repeat(100),
        agentType: 'pi',
      });
      expect(long.title).toHaveLength(41); // 40 字 + 省略号
      expect(() =>
        taskRepo.create(db, { workspaceId: ws.id, prompt: '   ', agentType: 'pi' }),
      ).toThrow(/需求描述不能为空/);
      expect(() =>
        taskRepo.create(db, { workspaceId: 'ghost', prompt: 'x', agentType: 'pi' }),
      ).toThrow(/workspace 不存在/);
    } finally {
      db.close();
    }
  });

  it('list：新→旧排序，联表带 workspace_name 元信息', () => {
    const { db, ws } = setup();
    try {
      const a = taskRepo.create(db, { workspaceId: ws.id, prompt: '甲', agentType: 'pi' }, 1000);
      const b = taskRepo.create(db, { workspaceId: ws.id, prompt: '乙', agentType: 'pi' }, 2000);
      const items = taskRepo.list(db);
      expect(items.map((t) => t.id)).toEqual([b.id, a.id]);
      expect(items[0].workspace_name).toBe('oc-alpha');
    } finally {
      db.close();
    }
  });

  it('updateStatus：合法迁移更新 status 与 updated_at', () => {
    const { db, ws } = setup();
    try {
      const t = taskRepo.create(db, { workspaceId: ws.id, prompt: 'x', agentType: 'pi' }, 1000);
      const running = taskRepo.updateStatus(db, t.id, 'running', 1500);
      expect(running.status).toBe('running');
      expect(running.updated_at).toBe(1500);
      // 完整链路走一遍：running → awaiting_approval → awaiting_review → done
      taskRepo.updateStatus(db, t.id, 'awaiting_approval');
      taskRepo.updateStatus(db, t.id, 'awaiting_review');
      expect(taskRepo.updateStatus(db, t.id, 'done').status).toBe('done');
      // failed → ready 重试
      const t2 = taskRepo.create(db, { workspaceId: ws.id, prompt: 'y', agentType: 'pi' });
      taskRepo.updateStatus(db, t2.id, 'failed');
      expect(taskRepo.updateStatus(db, t2.id, 'ready').status).toBe('ready');
    } finally {
      db.close();
    }
  });

  it('updateStatus：非法迁移抛错且不落库；任务不存在抛错', () => {
    const { db, ws } = setup();
    try {
      const t = taskRepo.create(db, { workspaceId: ws.id, prompt: 'x', agentType: 'pi' });
      expect(() => taskRepo.updateStatus(db, t.id, 'done')).toThrow(/非法任务状态迁移/);
      expect(taskRepo.getById(db, t.id)?.status).toBe('ready'); // 未被污染

      taskRepo.updateStatus(db, t.id, 'cancelled');
      expect(() => taskRepo.updateStatus(db, t.id, 'running')).toThrow(); // 终态
      expect(() => taskRepo.updateStatus(db, 'ghost', 'running')).toThrow(/任务不存在/);
    } finally {
      db.close();
    }
  });

  // 二期 Pinned（DESIGN.md 附录 A）：置顶切换不涉状态机，任何状态下可切
  it('setPinned：创建默认 0；置顶/取消往返更新 pinned 与 updated_at；不存在抛错', () => {
    const { db, ws } = setup();
    try {
      const t = taskRepo.create(db, { workspaceId: ws.id, prompt: 'x', agentType: 'pi' }, 1000);
      expect(t.pinned).toBe(0); // 迁移 008 默认值

      const pinned = taskRepo.setPinned(db, t.id, true, 1500);
      expect(pinned.pinned).toBe(1);
      expect(pinned.updated_at).toBe(1500);
      expect(taskRepo.getById(db, t.id)?.pinned).toBe(1); // 落库
      // 列表项同列返回（侧栏置顶分组数据源）
      expect(taskRepo.list(db).find((i) => i.id === t.id)?.pinned).toBe(1);

      const unpinned = taskRepo.setPinned(db, t.id, false, 2000);
      expect(unpinned.pinned).toBe(0);
      expect(taskRepo.getById(db, t.id)?.pinned).toBe(0);

      // 不涉状态机：done 终态仍可置顶切换
      const t2 = taskRepo.create(db, { workspaceId: ws.id, prompt: 'y', agentType: 'pi' });
      taskRepo.updateStatus(db, t2.id, 'cancelled');
      expect(taskRepo.setPinned(db, t2.id, true).pinned).toBe(1);

      expect(() => taskRepo.setPinned(db, 'ghost', true)).toThrow(/任务不存在/);
    } finally {
      db.close();
    }
  });

  // Codex 对齐（additive）：重命名与删除不涉状态机，任何状态下可操作
  it('rename：trim 落库并刷新 updated_at；空白标题 / 不存在抛错', () => {
    const { db, ws } = setup();
    try {
      const t = taskRepo.create(db, { workspaceId: ws.id, prompt: 'x', agentType: 'pi' }, 1000);

      const renamed = taskRepo.rename(db, t.id, '  新标题  ', 1500);
      expect(renamed.title).toBe('新标题'); // trim 后落库
      expect(renamed.updated_at).toBe(1500);
      expect(taskRepo.getById(db, t.id)?.title).toBe('新标题'); // 落库
      expect(taskRepo.list(db).find((i) => i.id === t.id)?.title).toBe('新标题'); // 列表项同源

      expect(() => taskRepo.rename(db, t.id, '   ')).toThrow(/不能为空/);
      expect(() => taskRepo.rename(db, t.id, '')).toThrow(/不能为空/);
      expect(() => taskRepo.rename(db, 'ghost', 'y')).toThrow(/任务不存在/);
      expect(taskRepo.getById(db, t.id)?.title).toBe('新标题'); // 抛错不污染

      // 不涉状态机：终态任务仍可重命名
      taskRepo.updateStatus(db, t.id, 'cancelled');
      expect(taskRepo.rename(db, t.id, 'z').title).toBe('z');
    } finally {
      db.close();
    }
  });

  it('remove：删除任务行；schema 无 ON DELETE CASCADE，子行显式级联清理', () => {
    const { db, ws } = setup();
    try {
      const t = taskRepo.create(db, { workspaceId: ws.id, prompt: 'x', agentType: 'pi' });
      const keep = taskRepo.create(db, { workspaceId: ws.id, prompt: 'y', agentType: 'pi' });
      // 造齐六张子表行（turns/messages/tool_calls/approvals/file_changes/usage_records）
      db.prepare(
        "INSERT INTO turns (id, task_id, idx, started_at) VALUES ('turn1', ?, 0, 1000)",
      ).run(t.id);
      db.prepare(
        "INSERT INTO messages (id, task_id, turn_id, role, seq, created_at) VALUES ('msg1', ?, 'turn1', 'user', 0, 1000)",
      ).run(t.id);
      db.prepare(
        "INSERT INTO tool_calls (id, task_id, turn_id, message_id, name, started_at) VALUES ('tc1', ?, 'turn1', 'msg1', 'read', 1000)",
      ).run(t.id);
      db.prepare(
        "INSERT INTO approvals (id, task_id, tool_call_id, created_at) VALUES ('ap1', ?, 'tc1', 1000)",
      ).run(t.id);
      db.prepare(
        "INSERT INTO file_changes (id, task_id, path, change_type, created_at) VALUES ('fc1', ?, 'a.ts', 'modified', 1000)",
      ).run(t.id);
      db.prepare(
        "INSERT INTO usage_records (id, task_id, turn_id, recorded_at) VALUES ('ur1', ?, 'turn1', 1000)",
      ).run(t.id);

      taskRepo.remove(db, t.id);
      expect(taskRepo.getById(db, t.id)).toBeNull();
      // 六张子表子行全部清理
      for (const table of [
        'usage_records',
        'file_changes',
        'approvals',
        'tool_calls',
        'messages',
        'turns',
      ]) {
        // COUNT(*) 恒返回单行数字；better-sqlite3 get() 类型为 unknown，按已知形状断言
        const row = db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`)
          .get(t.id) as { n: number };
        expect(row.n).toBe(0);
      }
      // 同 workspace 的其他任务不受影响
      expect(taskRepo.getById(db, keep.id)).not.toBeNull();
      expect(taskRepo.list(db)).toHaveLength(1);

      // 幂等不成立：重复删除按不存在抛错
      expect(() => taskRepo.remove(db, t.id)).toThrow(/任务不存在/);
      expect(() => taskRepo.remove(db, 'ghost')).toThrow(/任务不存在/);
    } finally {
      db.close();
    }
  });
});
