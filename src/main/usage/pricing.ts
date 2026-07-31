/**
 * 用量折算与 context 窗口解析（ticket #27，main 侧）。
 *
 * - priceUsage：UsageEvent + task 快照 → cost_usd / pricing_source（落库时一次折算，
 *   口径锁死在记录里——调价不影响历史；展示口径见 src/shared/usageFormat.ts）。
 * - resolveContextWindow：水位环分母——models.dev 元数据（provider 缓存/快照）→
 *   per-agent 保守默认（注释给出取值依据）。
 *
 * 订阅制判定：task.provider_id 为 NULL = agent 自带登录态（Claude Pro/Max、
 * ChatGPT 订阅等 OAuth 途径）——无法按 API 价折算，标 'subscription' 仅供参考。
 * 纯 Node 无 Electron 依赖，vitest 可直接跑。
 */

import type { Database } from '../db/database';
import type { Provider, Task, UsageRecord } from '../db/entities';
import * as providerRepo from '../db/providerRepo';
import type { ModelMeta } from '../providers/modelsDevSnapshot';
import { resolveModels } from '../providers/modelsFetch';
import type { PricingSource } from '../../shared/usageFormat';

/**
 * per-agent 保守默认 context 窗口（无 models.dev 元数据时的水位环分母）。
 * 取值偏保守（宁早警勿漏警）；有元数据时一律以元数据为准：
 * - claude-code：claude 全系快照 200k；
 * - codex：gpt-5 系快照 400k；
 * - opencode：后端模型不定，取主流编码模型下限 200k；
 * - pi / 自定义 ACP：降级接入，取更保守的 128k。
 */
export const DEFAULT_CONTEXT_WINDOW: Record<string, number> = {
  'claude-code': 200_000,
  codex: 400_000,
  opencode: 200_000,
  pi: 128_000,
};
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** provider 行内查某模型的 models.dev 元数据（缓存 → 预设快照兜底；无记录 null） */
export function lookupModelMeta(provider: Provider, modelId: string): ModelMeta | null {
  const models = resolveModels(provider);
  const hit = models.find((m) => m.id === modelId);
  return hit ?? null;
}

export interface UsagePricing {
  /** 记录落库的 provider_id 快照（无 provider = 订阅途径 → null） */
  providerId: string | null;
  costUsd: number | null;
  pricingSource: PricingSource;
}

/**
 * 单条 UsageEvent 的折算（纯函数）：
 * - 无 provider → 订阅制：cost NULL + pricing_source='subscription'；
 * - 有 provider 且 models.dev 价目齐（input+output 单价）→ 折算，source='models.dev'；
 *   口径：cost = (inputTokens × inputPrice + outputTokens × outputPrice) / 1e6，
 *   缓存 token 不折算（快照无缓存价目——见 usageFormat.ts 口径注释）；
 * - 有 provider 但无价目 → 两者皆 NULL（只显 token）。
 */
export function priceUsage(args: {
  provider: Provider | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}): UsagePricing {
  const { provider, model } = args;
  if (!provider) {
    return { providerId: null, costUsd: null, pricingSource: 'subscription' };
  }
  const meta = model ? lookupModelMeta(provider, model) : null;
  if (meta && meta.inputPrice !== null && meta.outputPrice !== null) {
    const costUsd = (args.inputTokens * meta.inputPrice + args.outputTokens * meta.outputPrice) / 1e6;
    return { providerId: provider.id, costUsd, pricingSource: 'models.dev' };
  }
  return { providerId: provider.id, costUsd: null, pricingSource: null };
}

/**
 * 事件分派的折算入口（agentEvents.ts 'usage' 用）：
 * model 取 agent 实报（usage.model）优先、task.model 快照兜底；
 * provider 行可能已被移除（tasks.provider_id 会被级联清空，故 getById 不命中即订阅口径）。
 */
export function priceTaskUsage(
  db: Database,
  task: Task,
  usage: { model?: string | null; inputTokens: number; outputTokens: number },
): UsagePricing & { model: string | null } {
  const model = usage.model ?? task.model ?? null;
  const provider = task.provider_id ? providerRepo.getById(db, task.provider_id) : null;
  const pricing = priceUsage({
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  return { ...pricing, model };
}

export interface ContextWindowInfo {
  /** 水位环分母（tokens） */
  contextWindow: number;
  /** 分母来源：models.dev 元数据 / per-agent 保守默认 */
  source: 'models.dev' | 'default';
  /** 实际采用的模型 id（usage 实报 → task 快照；皆无为 null） */
  model: string | null;
}

/**
 * 水位环分母解析：usage_records 最新一条的 model → task.model → per-agent 默认；
 * 有 provider 时先查 models.dev 元数据（缓存 → 预设快照）。
 */
export function resolveContextWindow(
  db: Database,
  task: Task,
): ContextWindowInfo {
  const latest = db
    .prepare('SELECT model FROM usage_records WHERE task_id = ? ORDER BY recorded_at DESC LIMIT 1')
    .get(task.id) as Pick<UsageRecord, 'model'> | undefined;
  const model = latest?.model ?? task.model ?? null;
  if (model && task.provider_id) {
    const provider = providerRepo.getById(db, task.provider_id);
    if (provider) {
      const meta = lookupModelMeta(provider, model);
      if (meta?.contextLength) {
        return { contextWindow: meta.contextLength, source: 'models.dev', model };
      }
    }
  }
  const def = DEFAULT_CONTEXT_WINDOW[task.agent_type] ?? FALLBACK_CONTEXT_WINDOW;
  return { contextWindow: def, source: 'default', model };
}
