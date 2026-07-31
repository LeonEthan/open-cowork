import { describe, expect, it } from 'vitest';
import { buildProviderInjection, configEnvValue, providerKeyOf } from '../src/main/providers/agentEnv';
import { agentKindFromType, generateAgentConfig } from '../src/main/providers/configGen';

/**
 * per-workspace 隔离原生配置生成（ticket #21 seam 2 纯函数）：
 * 逐家逐字节断言生成内容 + env 映射表；密钥本体绝不出现在任何生成文件
 * （codex env_key / pi apiKey=env 名 / opencode {env:X} 都只引用变量名）。
 */

const deepseekRow = {
  preset_id: 'deepseek',
  env_map_json: null,
  protocol: 'anthropic',
  base_url: 'https://api.deepseek.com/anthropic',
  name: 'DeepSeek',
};

describe('providers/configGen（#21 逐家逐字节）', () => {
  const input = {
    providerKey: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai' as const,
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
  };

  it('codex → config.toml（CODEX_HOME 指目录）', () => {
    const target = generateAgentConfig('codex', input);
    expect(target).not.toBeNull();
    expect(target!.fileName).toBe('config.toml');
    expect(target!.envName).toBe('CODEX_HOME');
    expect(target!.envTarget).toBe('dir');
    expect(target!.content).toBe(
      [
        '# open-cowork 生成（ticket #21）：per-workspace 隔离配置，请勿手改；密钥经 env 注入，不落盘',
        'model_provider = "deepseek"',
        'model = "deepseek-chat"',
        '',
        '[model_providers.deepseek]',
        'name = "DeepSeek"',
        'base_url = "https://api.deepseek.com/v1"',
        'env_key = "OPENAI_API_KEY"',
        'wire_api = "chat"',
        '',
      ].join('\n'),
    );
  });

  it('pi → models.json（PI_CODING_AGENT_DIR 指目录；apiKey 是 env 名而非密钥）', () => {
    const target = generateAgentConfig('pi', { ...input, protocol: 'anthropic' });
    expect(target).not.toBeNull();
    expect(target!.fileName).toBe('models.json');
    expect(target!.envName).toBe('PI_CODING_AGENT_DIR');
    expect(target!.envTarget).toBe('dir');
    expect(target!.content).toBe(
      `${JSON.stringify(
        {
          _comment:
            'open-cowork 生成（ticket #21）：per-workspace 隔离配置，请勿手改；密钥经 env 注入，不落盘',
          providers: {
            deepseek: {
              baseUrl: 'https://api.deepseek.com/v1',
              apiKey: 'OPENAI_API_KEY',
              api: 'anthropic-messages',
              models: [
                {
                  id: 'deepseek-chat',
                  name: 'deepseek-chat',
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
                {
                  id: 'deepseek-reasoner',
                  name: 'deepseek-reasoner',
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  it('opencode → opencode.json（OPENCODE_CONFIG 指文件本体；{env:X} 插值）', () => {
    const target = generateAgentConfig('opencode', input);
    expect(target).not.toBeNull();
    expect(target!.fileName).toBe('opencode.json');
    expect(target!.envName).toBe('OPENCODE_CONFIG');
    expect(target!.envTarget).toBe('file');
    expect(target!.content).toBe(
      `${JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          _comment:
            'open-cowork 生成（ticket #21）：per-workspace 隔离配置，请勿手改；密钥经 env 注入，不落盘',
          provider: {
            deepseek: {
              npm: '@ai-sdk/openai-compatible',
              name: 'DeepSeek',
              options: {
                baseURL: 'https://api.deepseek.com/v1',
                apiKey: '{env:OPENAI_API_KEY}',
              },
              models: {
                'deepseek-chat': { name: 'deepseek-chat' },
                'deepseek-reasoner': { name: 'deepseek-reasoner' },
              },
            },
          },
          model: 'deepseek/deepseek-chat',
        },
        null,
        2,
      )}\n`,
    );
  });

  it('opencode anthropic 协议 → @ai-sdk/anthropic', () => {
    const target = generateAgentConfig('opencode', { ...input, protocol: 'anthropic' });
    expect(target!.content).toContain('"npm": "@ai-sdk/anthropic"');
  });

  it('claude → null（env 注入已全覆盖，不写任何 settings 文件）', () => {
    expect(generateAgentConfig('claude', input)).toBeNull();
  });

  it('agentKindFromType 映射（custom:<id> 与未知不生成）', () => {
    expect(agentKindFromType('claude-code')).toBe('claude');
    expect(agentKindFromType('codex')).toBe('codex');
    expect(agentKindFromType('opencode')).toBe('opencode');
    expect(agentKindFromType('pi')).toBe('pi');
    expect(agentKindFromType('custom:abc')).toBeNull();
    expect(agentKindFromType('whatever')).toBeNull();
  });

  it('configEnvValue：dir → <root>/<agent>；file → <root>/<agent>/<file>', () => {
    const codex = generateAgentConfig('codex', input)!;
    expect(configEnvValue('/data/workspace-configs/w1', codex)).toBe(
      '/data/workspace-configs/w1/codex',
    );
    const oc = generateAgentConfig('opencode', input)!;
    expect(configEnvValue('/data/workspace-configs/w1', oc)).toBe(
      '/data/workspace-configs/w1/opencode/opencode.json',
    );
  });
});

describe('providers/agentEnv buildProviderInjection（#21 env 组装）', () => {
  it('claude-code + deepseek：ANTHROPIC_AUTH_TOKEN/API_KEY 双注 + BASE_URL；无生成文件', () => {
    const inj = buildProviderInjection(deepseekRow, 'sk-secret', 'claude-code', 'deepseek-chat', [
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    expect(inj.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'sk-secret',
      ANTHROPIC_API_KEY: 'sk-secret',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    });
    expect(inj.files).toEqual([]);
    expect(inj.configTarget).toBeNull();
    expect(inj.keyEnvs).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(inj.baseUrlEnv).toBe('ANTHROPIC_BASE_URL');
  });

  it('官方 anthropic 预设：只注 ANTHROPIC_API_KEY', () => {
    const inj = buildProviderInjection(
      { ...deepseekRow, preset_id: 'anthropic', base_url: 'https://api.anthropic.com', name: 'Anthropic' },
      'sk-ant',
      'claude-code',
      null,
      [],
    );
    expect(inj.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
  });

  it('openai 协议自定义 provider：OPENAI_API_KEY + OPENAI_BASE_URL', () => {
    const inj = buildProviderInjection(
      {
        preset_id: null,
        env_map_json: null,
        protocol: 'openai',
        base_url: 'https://gw.example.com/v1',
        name: '内部网关',
      },
      'gw-key',
      'claude-code',
      null,
      [],
    );
    expect(inj.env).toEqual({
      OPENAI_API_KEY: 'gw-key',
      OPENAI_BASE_URL: 'https://gw.example.com/v1',
    });
  });

  it('env_map_json 覆盖生效（自定义 env 名）', () => {
    const inj = buildProviderInjection(
      {
        preset_id: null,
        env_map_json: JSON.stringify({ keyEnvs: ['MY_LLM_KEY'], baseUrlEnv: 'MY_LLM_BASE' }),
        protocol: 'anthropic',
        base_url: 'https://x.example.com',
        name: 'X',
      },
      'k',
      'claude-code',
      null,
      [],
    );
    expect(inj.env).toEqual({ MY_LLM_KEY: 'k', MY_LLM_BASE: 'https://x.example.com' });
  });

  it('codex：生成文件 relPath 落位 + model 快照写入 config', () => {
    const inj = buildProviderInjection(deepseekRow, 'sk-codex-test-key', 'codex', 'deepseek-reasoner', [
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    expect(inj.configTarget!.envName).toBe('CODEX_HOME');
    expect(inj.files).toHaveLength(1);
    expect(inj.files[0].relPath).toBe('codex/config.toml');
    expect(inj.files[0].content).toContain('model = "deepseek-reasoner"');
    // 密钥本体绝不进生成文件
    expect(inj.files[0].content).not.toContain('sk-codex-test-key');
  });

  it('pi/opencode 生成文件内只有 env 名引用，无密钥本体', () => {
    for (const agent of ['pi', 'opencode'] as const) {
      const inj = buildProviderInjection(deepseekRow, 'sk-super-secret', agent, null, ['deepseek-chat']);
      const body = inj.files.map((f) => f.content).join('\n');
      expect(body).not.toContain('sk-super-secret');
      expect(body).toContain('ANTHROPIC_AUTH_TOKEN'); // env 名引用
    }
  });

  it('providerKeyOf：预设 id 直用；自定义 fallback custom；非法字符清洗', () => {
    expect(providerKeyOf({ preset_id: 'deepseek' })).toBe('deepseek');
    expect(providerKeyOf({ preset_id: null })).toBe('custom');
    expect(providerKeyOf({ preset_id: 'My Provider!' })).toBe('my-provider-');
  });
});
