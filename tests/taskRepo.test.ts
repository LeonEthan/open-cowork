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
});
