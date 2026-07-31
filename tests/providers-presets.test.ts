import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PRESETS,
  defaultEnvNames,
  getPreset,
  resolveEnvNames,
} from '../src/main/providers/presets';
import { MODELS_DEV_SNAPSHOT } from '../src/main/providers/modelsDevSnapshot';

/**
 * 预设目录数据完整性（ticket #21）：六家预设一键添加的正确性地基。
 * 纯数据模块断言——id 唯一、协议合法、端点 https、env 约定自洽、静态清单非空、
 * models.dev id 在快照内有对应分节。
 */
describe('providers/presets 数据完整性（#21）', () => {
  it('恰好六家预设，id 唯一', () => {
    expect(PROVIDER_PRESETS).toHaveLength(6);
    expect(new Set(PROVIDER_PRESETS.map((p) => p.id)).size).toBe(6);
  });

  it('六家为 Anthropic/OpenAI/DeepSeek/GLM/Kimi/通义', () => {
    expect(PROVIDER_PRESETS.map((p) => p.id).sort()).toEqual(
      ['anthropic', 'deepseek', 'glm', 'kimi', 'openai', 'qwen'].sort(),
    );
  });

  it('每家：协议合法、默认端点 https 且与默认协议一致、静态模型清单非空', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(['anthropic', 'openai']).toContain(p.protocol);
      expect(p.baseUrl.startsWith('https://')).toBe(true);
      // 默认 baseUrl 必须等于默认协议对应端点
      expect(p.endpoints[p.protocol]).toBe(p.baseUrl);
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.modelsDevId.length).toBeGreaterThan(0);
    }
  });

  it('国内四家双协议端点齐备（anthropic 兼容 + openai 兼容，免代理直连）', () => {
    for (const id of ['deepseek', 'glm', 'kimi', 'qwen']) {
      const p = getPreset(id);
      expect(p, id).not.toBeNull();
      expect(p!.endpoints.anthropic, `${id} anthropic 端点`).toMatch(/^https:\/\//);
      expect(p!.endpoints.openai, `${id} openai 端点`).toMatch(/^https:\/\//);
      // 国内四家默认 anthropic 兼容（claude driver 开箱即用）
      expect(p!.protocol, id).toBe('anthropic');
    }
  });

  it('env 约定自洽：官方 Anthropic 只注 ANTHROPIC_API_KEY；openai 协议用 OPENAI_*', () => {
    const anthropic = getPreset('anthropic')!;
    expect(anthropic.envNames).toEqual({
      keyEnvs: ['ANTHROPIC_API_KEY'],
      baseUrlEnv: 'ANTHROPIC_BASE_URL',
    });
    const openai = getPreset('openai')!;
    expect(openai.envNames).toEqual({
      keyEnvs: ['OPENAI_API_KEY'],
      baseUrlEnv: 'OPENAI_BASE_URL',
    });
    // 第三方 anthropic 兼容端点：AUTH_TOKEN（Bearer 约定）与 API_KEY（x-api-key 约定）双注
    for (const id of ['deepseek', 'glm', 'kimi', 'qwen']) {
      expect(getPreset(id)!.envNames).toEqual({
        keyEnvs: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
      });
    }
  });

  it('每家预设的静态模型在 models.dev 快照内都有元数据（设置页开箱可展示）', () => {
    for (const p of PROVIDER_PRESETS) {
      const section = MODELS_DEV_SNAPSHOT[p.modelsDevId];
      expect(section, `${p.id} → models.dev ${p.modelsDevId}`).toBeDefined();
      for (const m of p.models) {
        const meta = section[m];
        expect(meta, `${p.modelsDevId}/${m}`).toBeDefined();
        expect(meta.contextLength, `${p.modelsDevId}/${m} contextLength`).toBeGreaterThan(0);
      }
    }
  });

  it('getPreset 未命中返回 null', () => {
    expect(getPreset('nonexistent')).toBeNull();
  });
});

describe('providers/presets resolveEnvNames（#21）', () => {
  it('env_map_json 为 NULL 时回落预设默认', () => {
    expect(resolveEnvNames('anthropic', 'deepseek', null)).toEqual(defaultEnvNames('anthropic'));
    expect(resolveEnvNames('openai', 'openai', null)).toEqual(defaultEnvNames('openai'));
  });

  it('未知预设 + 未知协议回落协议默认（anthropic 兜底）', () => {
    expect(resolveEnvNames('weird', null, null)).toEqual(defaultEnvNames('anthropic'));
    expect(resolveEnvNames('openai', null, null)).toEqual(defaultEnvNames('openai'));
  });

  it('自定义覆盖生效（keyEnvs + baseUrlEnv）', () => {
    const env = resolveEnvNames(
      'anthropic',
      null,
      JSON.stringify({ keyEnvs: ['MY_KEY', 'MY_KEY_2'], baseUrlEnv: 'MY_BASE' }),
    );
    expect(env).toEqual({ keyEnvs: ['MY_KEY', 'MY_KEY_2'], baseUrlEnv: 'MY_BASE' });
  });

  it('非法 JSON / 空数组 / 非字符串逐项回落默认', () => {
    expect(resolveEnvNames('openai', null, 'not-json{{{')).toEqual(defaultEnvNames('openai'));
    expect(resolveEnvNames('openai', null, JSON.stringify({ keyEnvs: [] }))).toEqual(
      defaultEnvNames('openai'),
    );
    expect(
      resolveEnvNames('openai', null, JSON.stringify({ keyEnvs: [1, 2], baseUrlEnv: 42 })),
    ).toEqual(defaultEnvNames('openai'));
    // 部分覆盖：只给 keyEnvs，baseUrlEnv 回落
    expect(
      resolveEnvNames('openai', null, JSON.stringify({ keyEnvs: ['K'] })),
    ).toEqual({ keyEnvs: ['K'], baseUrlEnv: 'OPENAI_BASE_URL' });
  });
});
