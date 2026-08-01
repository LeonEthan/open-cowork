import { describe, expect, it } from 'vitest';
import type { Provider } from '../src/main/db/entities';
import {
  DEFAULT_CONTEXT_WINDOW,
  FALLBACK_CONTEXT_WINDOW,
  lookupModelMeta,
  priceUsage,
} from '../src/main/usage/pricing';
import { MODELS_DEV_SNAPSHOT } from '../src/main/providers/modelsDevSnapshot';
import { serializeModelsCache } from '../src/main/providers/modelsFetch';

/**
 * 用量折算表驱动测试（ticket #27）——口径锁定：
 * - 有 models.dev 价目：cost = (in × inPrice + out × outPrice) / 1e6，缓存 token 不折算；
 * - 无价目（未知模型 / 自定义 provider）：cost NULL + source NULL（只显 token）；
 * - 订阅制（无 provider）：cost NULL + source='subscription'（标「仅供参考」）；
 * - models_json 缓存优先于内置快照（远端拉取后的口径）。
 */

/** 构造 provider 行（只需本模块读到的字段） */
function provider(partial: Partial<Provider> & { preset_id: string | null }): Provider {
  return {
    id: 'prov-1',
    name: 'P',
    kind: 'preset',
    base_url: 'https://x.example.com',
    protocol: 'anthropic',
    credential_key: null,
    models_json: null,
    encrypted_api_key: 'Y2lwaGVy',
    env_map_json: null,
    models_fetched_at: null,
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

describe('priceUsage 折算口径（表驱动）', () => {
  const anthropic = provider({ preset_id: 'anthropic' });

  const cases: Array<{
    name: string;
    provider: Provider | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    want: { costUsd: number | null; pricingSource: 'models.dev' | 'subscription' | null };
  }> = [
    {
      name: '有价目：claude-sonnet-4-5（$3/$15）10k in + 2k out = $0.06',
      provider: anthropic,
      model: 'claude-sonnet-4-5',
      inputTokens: 10_000,
      outputTokens: 2_000,
      want: { costUsd: 0.06, pricingSource: 'models.dev' },
    },
    {
      name: '有价目：claude-opus-4-1（$15/$75）1M in + 1k out = $15.075',
      provider: anthropic,
      model: 'claude-opus-4-1',
      inputTokens: 1_000_000,
      outputTokens: 1_000,
      want: { costUsd: 15.075, pricingSource: 'models.dev' },
    },
    {
      name: '有价目但零用量 → $0（仍标 models.dev）',
      provider: anthropic,
      model: 'claude-haiku-4-5',
      inputTokens: 0,
      outputTokens: 0,
      want: { costUsd: 0, pricingSource: 'models.dev' },
    },
    {
      name: '无价目：预设 provider 的未知模型 → 不折算',
      provider: anthropic,
      model: 'claude-future-9',
      inputTokens: 10_000,
      outputTokens: 2_000,
      want: { costUsd: null, pricingSource: null },
    },
    {
      name: '无价目：自定义 provider（无 models.dev id）→ 不折算',
      provider: provider({ preset_id: null, kind: 'custom' }),
      model: 'my-model',
      inputTokens: 10_000,
      outputTokens: 2_000,
      want: { costUsd: null, pricingSource: null },
    },
    {
      name: 'model 缺失（agent 未报）→ 不折算',
      provider: anthropic,
      model: null,
      inputTokens: 10_000,
      outputTokens: 2_000,
      want: { costUsd: null, pricingSource: null },
    },
    {
      name: '订阅制：无 provider（agent 自带 OAuth 登录）→ source=subscription',
      provider: null,
      model: 'claude-sonnet-4-5',
      inputTokens: 10_000,
      outputTokens: 2_000,
      want: { costUsd: null, pricingSource: 'subscription' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const got = priceUsage({
        provider: c.provider,
        model: c.model,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
      });
      expect(got.pricingSource).toBe(c.want.pricingSource);
      if (c.want.costUsd === null) expect(got.costUsd).toBeNull();
      else expect(got.costUsd).toBeCloseTo(c.want.costUsd, 10);
      expect(got.providerId).toBe(c.provider ? c.provider.id : null);
    });
  }

  it('缓存 token 不参与折算（快照无缓存价目）', () => {
    // priceUsage 只收 input/output——口径上缓存不进折算；此处锁定入参面
    const withCache = priceUsage({
      provider: anthropic,
      model: 'claude-sonnet-4-5',
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    expect(withCache.costUsd).toBeCloseTo(0.06, 10);
  });

  it('models_json 缓存优先于内置快照（远端调价后以缓存为准）', () => {
    const cached = provider({
      preset_id: 'anthropic',
      models_json: serializeModelsCache(
        [{ id: 'claude-sonnet-4-5', contextLength: 200_000, inputPrice: 30, outputPrice: 150 }],
        123,
      ),
      models_fetched_at: 123,
    });
    const got = priceUsage({
      provider: cached,
      model: 'claude-sonnet-4-5',
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    // (1000×30 + 1000×150)/1e6 = 0.18 —— 若用了快照（$3/$15）会是 0.018
    expect(got.costUsd).toBeCloseTo(0.18, 10);
    expect(got.pricingSource).toBe('models.dev');
  });
});

describe('lookupModelMeta', () => {
  it('预设快照命中（含上下文长度与价格）', () => {
    const meta = lookupModelMeta(provider({ preset_id: 'deepseek' }), 'deepseek-chat');
    expect(meta?.contextLength).toBe(128_000);
    expect(meta?.inputPrice).toBe(0.28);
  });

  it('未命中返回 null', () => {
    expect(lookupModelMeta(provider({ preset_id: 'anthropic' }), 'ghost-model')).toBeNull();
    expect(lookupModelMeta(provider({ preset_id: null, kind: 'custom' }), 'x')).toBeNull();
  });

  it('快照数据形状：六家预设默认模型均有上下文与双价目', () => {
    for (const [devId, models] of Object.entries(MODELS_DEV_SNAPSHOT)) {
      for (const [id, meta] of Object.entries(models)) {
        expect(meta.contextLength, `${devId}/${id} contextLength`).toBeGreaterThan(0);
        expect(meta.inputPrice, `${devId}/${id} inputPrice`).not.toBeNull();
        expect(meta.outputPrice, `${devId}/${id} outputPrice`).not.toBeNull();
      }
    }
  });
});

describe('水位环分母默认值（per-agent 保守）', () => {
  it('四家 driver + fallback 齐备', () => {
    expect(DEFAULT_CONTEXT_WINDOW['claude-code']).toBe(200_000);
    expect(DEFAULT_CONTEXT_WINDOW['codex']).toBe(400_000);
    expect(DEFAULT_CONTEXT_WINDOW['opencode']).toBe(200_000);
    expect(DEFAULT_CONTEXT_WINDOW['pi']).toBe(128_000);
    expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000);
  });
});
