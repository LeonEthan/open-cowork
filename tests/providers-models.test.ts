import { describe, expect, it } from 'vitest';
import {
  fetchModelsDevMeta,
  fetchProviderModels,
  mergeModelMeta,
  modelsDevIdOf,
  modelsRequestHeaders,
  parseModelsBody,
  parseModelsCache,
  parseModelsDevBody,
  resolveModels,
  serializeModelsCache,
} from '../src/main/providers/modelsFetch';
import type { HttpGet } from '../src/main/providers/modelsFetch';

/**
 * 模型清单与 models.dev 元数据（ticket #21）：
 * /models 解析（两协议归一）、请求头约定、models.dev 快照/运行时归并、
 * models_json 缓存往返、resolveModels 三级回落。HTTP 全部 stub 注入，不起网络。
 */

function stubHttp(routes: Record<string, { status: number; body: string }>): {
  httpGet: HttpGet;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    httpGet: async (url, headers) => {
      calls.push({ url, headers });
      const hit = routes[url];
      if (!hit) throw new Error(`未 stub 的 URL: ${url}`);
      return hit;
    },
  };
}

describe('providers/modelsFetch /models 解析（#21）', () => {
  it('OpenAI 兼容形状 {data:[{id}]}', () => {
    const ids = parseModelsBody(
      JSON.stringify({ object: 'list', data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] }),
    );
    expect(ids).toEqual(['gpt-5', 'gpt-5-mini']);
  });

  it('Anthropic 兼容形状 {data:[{id,display_name}]}（同形归一）', () => {
    const ids = parseModelsBody(
      JSON.stringify({
        data: [
          { type: 'model', id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' },
          { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
        ],
        has_more: false,
      }),
    );
    expect(ids).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);
  });

  it('去重 + 跳过无 id 条目；全无效/缺 data 抛错', () => {
    expect(
      parseModelsBody(JSON.stringify({ data: [{ id: 'a' }, { name: 'no-id' }, { id: 'a' }] })),
    ).toEqual(['a']);
    expect(() => parseModelsBody('{"nope":1}')).toThrow('data');
    expect(() => parseModelsBody('{"data":[]}')).toThrow('无有效模型');
    expect(() => parseModelsBody('not json')).toThrow();
  });

  it('请求头：anthropic=x-api-key+version；openai=Bearer', () => {
    expect(modelsRequestHeaders('anthropic', 'k')).toEqual({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
    expect(modelsRequestHeaders('openai', 'k')).toEqual({ authorization: 'Bearer k' });
  });

  it('fetchProviderModels：URL 拼尾斜杠归一 + 鉴权头 + 非 2xx 抛错', async () => {
    const { httpGet, calls } = stubHttp({
      'https://api.deepseek.com/anthropic/models': {
        status: 200,
        body: JSON.stringify({ data: [{ id: 'deepseek-chat' }] }),
      },
    });
    const ids = await fetchProviderModels(
      { httpGet },
      { protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic/', apiKey: 'sk-x' },
    );
    expect(ids).toEqual(['deepseek-chat']);
    expect(calls[0].headers['x-api-key']).toBe('sk-x');

    const failing = stubHttp({
      'https://api.deepseek.com/anthropic/models': { status: 401, body: '{}' },
    });
    await expect(
      fetchProviderModels(
        { httpGet: failing.httpGet },
        { protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'bad' },
      ),
    ).rejects.toThrow('HTTP 401');
  });
});

describe('providers/modelsFetch models.dev（#21）', () => {
  const apiJson = JSON.stringify({
    deepseek: {
      id: 'deepseek',
      models: {
        'deepseek-chat': {
          cost: { input: 0.28, output: 0.42 },
          limit: { context: 128_000, output: 8_192 },
        },
        'deepseek-reasoner': {
          cost: { input: 0.55, output: 2.19 },
          limit: { context: 128_000, output: 65_536 },
        },
      },
    },
  });

  it('parseModelsDevBody 提取上下文长度与价格', () => {
    const meta = parseModelsDevBody(apiJson, 'deepseek');
    expect(meta['deepseek-chat']).toEqual({
      contextLength: 128_000,
      inputPrice: 0.28,
      outputPrice: 0.42,
    });
    expect(meta['deepseek-reasoner'].outputPrice).toBe(2.19);
  });

  it('未知 provider / 缺字段 → 空表或全 null 元数据', () => {
    expect(parseModelsDevBody(apiJson, 'nonexistent')).toEqual({});
    const partial = parseModelsDevBody(
      JSON.stringify({ x: { models: { 'm-1': {} } } }),
      'x',
    );
    expect(partial['m-1']).toEqual({ contextLength: null, inputPrice: null, outputPrice: null });
  });

  it('fetchModelsDevMeta 命中 models.dev api.json；非 2xx 抛错（调用方回退快照）', async () => {
    const { httpGet } = stubHttp({ 'https://models.dev/api.json': { status: 200, body: apiJson } });
    const meta = await fetchModelsDevMeta({ httpGet }, 'deepseek');
    expect(Object.keys(meta)).toHaveLength(2);

    const failing = stubHttp({ 'https://models.dev/api.json': { status: 503, body: '' } });
    await expect(fetchModelsDevMeta({ httpGet: failing.httpGet }, 'deepseek')).rejects.toThrow(
      'HTTP 503',
    );
  });

  it('mergeModelMeta：无记录模型给全 null 元数据', () => {
    const merged = mergeModelMeta(['a', 'b'], {
      a: { contextLength: 100, inputPrice: 1, outputPrice: 2 },
    });
    expect(merged).toEqual([
      { id: 'a', contextLength: 100, inputPrice: 1, outputPrice: 2 },
      { id: 'b', contextLength: null, inputPrice: null, outputPrice: null },
    ]);
  });
});

describe('providers/modelsFetch resolveModels 三级回落（#21）', () => {
  it('models_json 缓存优先（含元数据往返）', () => {
    const cache = serializeModelsCache(
      [{ id: 'm-x', contextLength: 999, inputPrice: 0.1, outputPrice: 0.2 }],
      123,
    );
    const models = resolveModels({ preset_id: 'deepseek', models_json: cache });
    expect(models).toEqual([{ id: 'm-x', contextLength: 999, inputPrice: 0.1, outputPrice: 0.2 }]);
    // 往返再解析（setModels → providers:models 路径）
    expect(parseModelsCache(cache)).toEqual(models);
  });

  it('缓存损坏回落预设静态清单 + 内置快照元数据', () => {
    const models = resolveModels({ preset_id: 'deepseek', models_json: '{broken' });
    expect(models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(models[0].contextLength).toBe(128_000); // 快照兜底
    expect(models[0].inputPrice).toBe(0.28);
  });

  it('自定义 provider 无缓存 → 空清单（刷新后才有）', () => {
    expect(resolveModels({ preset_id: null, models_json: null })).toEqual([]);
  });

  it('modelsDevIdOf：预设映射；自定义为 null', () => {
    expect(modelsDevIdOf({ preset_id: 'glm' })).toBe('zai');
    expect(modelsDevIdOf({ preset_id: null })).toBeNull();
    expect(modelsDevIdOf({ preset_id: 'ghost' })).toBeNull();
  });

  it('parseModelsCache：坏 JSON / 空清单 / 缺 id 均回落 null', () => {
    expect(parseModelsCache(null)).toBeNull();
    expect(parseModelsCache('oops')).toBeNull();
    expect(parseModelsCache(JSON.stringify({ models: [] }))).toBeNull();
    expect(parseModelsCache(JSON.stringify({ models: [{ name: 'no-id' }] }))).toBeNull();
  });
});
