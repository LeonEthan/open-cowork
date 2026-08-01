import { describe, expect, it } from 'vitest';
import { createAgentEventDispatcher } from '../src/main/agentEvents';
import * as conversationRepo from '../src/main/db/conversationRepo';
import { openDatabase } from '../src/main/db/database';
import type { Database } from '../src/main/db/database';
import * as providerRepo from '../src/main/db/providerRepo';
import * as taskRepo from '../src/main/db/taskRepo';
import * as workspaceRepo from '../src/main/db/workspaceRepo';
import type { Task } from '../src/main/db/entities';
import { resolveContextWindow } from '../src/main/usage/pricing';
import type { AgentEvent } from '../src/agent/events';

/**
 * 用量落库与聚合（ticket #27，内存库端到端）：
 * - 事件分派 usage → cost_usd / pricing_source / provider_id 落库时一次锁定；
 * - 订阅制（无 provider）→ pricing_source='subscription' + cost NULL；
 * - usageTotalsByTask 聚合口径（多条记录、混合来源）；
 * - resolveContextWindow：models.dev 元数据优先，per-agent 默认兜底；
 * - listHistory 携带 usageRecords（文档流灰字基线）。
 */

function setup(taskInput: Partial<Parameters<typeof taskRepo.create>[1]> = {}): {
  db: Database;
  task: Task;
  dispatch: (taskId: string, e: AgentEvent) => void;
} {
  const db = openDatabase(':memory:');
  const ws = workspaceRepo.add(db, '/tmp/oc-usage-test');
  const task = taskRepo.create(db, {
    workspaceId: ws.id,
    prompt: '实现需求',
    agentType: 'claude-code',
    ...taskInput,
  });
  taskRepo.updateStatus(db, task.id, 'running');
  conversationRepo.createTurn(db, task.id);
  const dispatch = createAgentEventDispatcher({ db, broadcastTasksChanged: () => {} });
  return { db, task: taskRepo.getById(db, task.id)!, dispatch };
}

function emitUsage(
  dispatch: (t: string, e: AgentEvent) => void,
  taskId: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; model?: string },
): void {
  dispatch(taskId, {
    type: 'usage',
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, model: null, ...usage },
  });
}

describe('usage 分派落库（折算口径一次锁定）', () => {
  it('有 provider + models.dev 价目：cost_usd / pricing_source / provider_id 落库', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-usage-test');
    const prov = providerRepo.create(db, {
      name: 'Anthropic',
      kind: 'preset',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      presetId: 'anthropic',
      encryptedApiKey: 'Y2lwaGVy',
    });
    const task = taskRepo.create(db, {
      workspaceId: ws.id,
      prompt: '需求',
      agentType: 'claude-code',
      providerId: prov.id,
      model: 'claude-sonnet-4-5',
    });
    taskRepo.updateStatus(db, task.id, 'running');
    conversationRepo.createTurn(db, task.id);
    const dispatch = createAgentEventDispatcher({ db, broadcastTasksChanged: () => {} });

    emitUsage(dispatch, task.id, { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 800 });

    const rows = conversationRepo.listUsageByTask(db, task.id);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.provider_id).toBe(prov.id);
    expect(r.model).toBe('claude-sonnet-4-5'); // task.model 快照兜底
    expect(r.pricing_source).toBe('models.dev');
    // (10000×3 + 2000×15)/1e6 = 0.06；缓存 800 不折算
    expect(r.cost_usd).toBeCloseTo(0.06, 10);
    db.close();
  });

  it('usage.model 实报优先于 task.model 快照', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-usage-test');
    const prov = providerRepo.create(db, {
      name: 'Anthropic',
      kind: 'preset',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      presetId: 'anthropic',
      encryptedApiKey: 'Y2lwaGVy',
    });
    const task = taskRepo.create(db, {
      workspaceId: ws.id,
      prompt: '需求',
      agentType: 'claude-code',
      providerId: prov.id,
      model: 'claude-sonnet-4-5',
    });
    taskRepo.updateStatus(db, task.id, 'running');
    conversationRepo.createTurn(db, task.id);
    const dispatch = createAgentEventDispatcher({ db, broadcastTasksChanged: () => {} });

    // agent 实报 haiku（$1/$5）：100k in + 10k out = 0.1 + 0.05 = $0.15
    emitUsage(dispatch, task.id, {
      inputTokens: 100_000,
      outputTokens: 10_000,
      model: 'claude-haiku-4-5',
    });
    const r = conversationRepo.listUsageByTask(db, task.id)[0];
    expect(r.model).toBe('claude-haiku-4-5');
    expect(r.cost_usd).toBeCloseTo(0.15, 10);
    db.close();
  });

  it('无 provider（订阅途径）：pricing_source=subscription，cost NULL', () => {
    const { db, task, dispatch } = setup();
    emitUsage(dispatch, task.id, { inputTokens: 10_000, outputTokens: 2_000, model: 'claude-sonnet-4-5' });
    const r = conversationRepo.listUsageByTask(db, task.id)[0];
    expect(r.provider_id).toBeNull();
    expect(r.pricing_source).toBe('subscription');
    expect(r.cost_usd).toBeNull();
    db.close();
  });

  it('有 provider 但模型无价目：cost NULL + source NULL（只显 token）', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-usage-test');
    const prov = providerRepo.create(db, {
      name: 'Anthropic',
      kind: 'preset',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      presetId: 'anthropic',
      encryptedApiKey: 'Y2lwaGVy',
    });
    const task = taskRepo.create(db, {
      workspaceId: ws.id,
      prompt: '需求',
      agentType: 'claude-code',
      providerId: prov.id,
      model: 'claude-future-9',
    });
    taskRepo.updateStatus(db, task.id, 'running');
    conversationRepo.createTurn(db, task.id);
    const dispatch = createAgentEventDispatcher({ db, broadcastTasksChanged: () => {} });

    emitUsage(dispatch, task.id, { inputTokens: 10_000, outputTokens: 2_000 });
    const r = conversationRepo.listUsageByTask(db, task.id)[0];
    expect(r.provider_id).toBe(prov.id);
    expect(r.cost_usd).toBeNull();
    expect(r.pricing_source).toBeNull();
    db.close();
  });

  it('usage 归属当前 running turn；listHistory 携带 usageRecords', () => {
    const { db, task, dispatch } = setup();
    emitUsage(dispatch, task.id, { inputTokens: 10, outputTokens: 20 });
    dispatch(task.id, { type: 'turn_end', status: 'completed' });
    const history = conversationRepo.listHistory(db, task.id);
    expect(history.usageRecords).toHaveLength(1);
    expect(history.usageRecords[0].turn_id).toBe(history.turns[0].id);
    db.close();
  });
});

describe('usageTotalsByTask 聚合口径', () => {
  it('多任务多记录：token 求和、cost 只加非 NULL、来源标志正确', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-usage-test');
    const prov = providerRepo.create(db, {
      name: 'Anthropic',
      kind: 'preset',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      presetId: 'anthropic',
      encryptedApiKey: 'Y2lwaGVy',
    });
    const t1 = taskRepo.create(db, {
      workspaceId: ws.id,
      prompt: 'A',
      agentType: 'claude-code',
      providerId: prov.id,
      model: 'claude-sonnet-4-5',
    });
    const t2 = taskRepo.create(db, { workspaceId: ws.id, prompt: 'B', agentType: 'claude-code' });
    const ins = (
      taskId: string,
      input: Omit<Parameters<typeof conversationRepo.insertUsageRecord>[1], 'taskId' | 'turnId'>,
    ) => conversationRepo.insertUsageRecord(db, { taskId, turnId: null, ...input });

    // t1：两条 models.dev 折算（各 $0.06）+ 一条无价目
    ins(t1.id, {
      model: 'claude-sonnet-4-5', inputTokens: 10_000, outputTokens: 2_000,
      cacheReadTokens: 100, cacheWriteTokens: 0,
      providerId: prov.id, costUsd: 0.06, pricingSource: 'models.dev',
    });
    ins(t1.id, {
      model: 'claude-sonnet-4-5', inputTokens: 10_000, outputTokens: 2_000,
      cacheReadTokens: 0, cacheWriteTokens: 20,
      providerId: prov.id, costUsd: 0.06, pricingSource: 'models.dev',
    });
    ins(t1.id, {
      model: 'ghost', inputTokens: 5, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      providerId: prov.id, costUsd: null, pricingSource: null,
    });
    // t2：一条订阅制
    ins(t2.id, {
      model: 'claude-sonnet-4-5', inputTokens: 1_000, outputTokens: 500,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      providerId: null, costUsd: null, pricingSource: 'subscription',
    });

    const totals = conversationRepo.usageTotalsByTask(db);
    expect(totals).toHaveLength(2);
    const a = totals.find((r) => r.task_id === t1.id)!;
    expect(a.input_tokens).toBe(20_005);
    expect(a.output_tokens).toBe(4_005);
    expect(a.cache_read_tokens).toBe(100);
    expect(a.cache_write_tokens).toBe(20);
    expect(a.cost_usd).toBeCloseTo(0.12, 10);
    expect(a.priced_records).toBe(2);
    expect(a.subscription_records).toBe(0);
    expect(a.records).toBe(3);

    const b = totals.find((r) => r.task_id === t2.id)!;
    expect(b.cost_usd).toBeNull();
    expect(b.priced_records).toBe(0);
    expect(b.subscription_records).toBe(1);
    db.close();
  });
});

describe('resolveContextWindow（水位环分母）', () => {
  it('models.dev 元数据优先（provider + 已知模型）', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-usage-test');
    const prov = providerRepo.create(db, {
      name: 'Anthropic',
      kind: 'preset',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      presetId: 'anthropic',
      encryptedApiKey: 'Y2lwaGVy',
    });
    const task = taskRepo.create(db, {
      workspaceId: ws.id,
      prompt: '需求',
      agentType: 'claude-code',
      providerId: prov.id,
      model: 'claude-opus-4-1',
    });
    const info = resolveContextWindow(db, taskRepo.getById(db, task.id)!);
    expect(info.contextWindow).toBe(200_000);
    expect(info.source).toBe('models.dev');
    expect(info.model).toBe('claude-opus-4-1');
    db.close();
  });

  it('最新一条 usage 实报模型优先于 task 快照', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-usage-test');
    const prov = providerRepo.create(db, {
      name: 'OpenAI',
      kind: 'preset',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      presetId: 'openai',
      encryptedApiKey: 'Y2lwaGVy',
    });
    const task = taskRepo.create(db, {
      workspaceId: ws.id,
      prompt: '需求',
      agentType: 'codex',
      providerId: prov.id,
      model: 'gpt-5-mini',
    });
    conversationRepo.insertUsageRecord(db, {
      taskId: task.id, turnId: null, model: 'gpt-4.1',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const info = resolveContextWindow(db, taskRepo.getById(db, task.id)!);
    expect(info.model).toBe('gpt-4.1'); // gpt-4.1 = 1_047_576；task 快照 gpt-5-mini = 400k
    expect(info.contextWindow).toBe(1_047_576);
    expect(info.source).toBe('models.dev');
    db.close();
  });

  it('无元数据回落 per-agent 保守默认（codex 400k / 未知 agent 128k）', () => {
    const db = openDatabase(':memory:');
    const ws = workspaceRepo.add(db, '/tmp/oc-usage-test');
    const codexTask = taskRepo.create(db, {
      workspaceId: ws.id,
      prompt: '需求',
      agentType: 'codex',
    });
    expect(resolveContextWindow(db, codexTask).contextWindow).toBe(400_000);
    expect(resolveContextWindow(db, codexTask).source).toBe('default');

    const customTask = taskRepo.create(db, {
      workspaceId: ws.id,
      prompt: '需求',
      agentType: 'custom:xyz',
    });
    expect(resolveContextWindow(db, customTask).contextWindow).toBe(128_000);
    db.close();
  });
});
