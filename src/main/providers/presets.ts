/**
 * 内置 provider 预设目录（ticket #21，PRD §4.6 / ARCHITECTURE §3）——纯数据模块，零运行时依赖。
 *
 * 六家预设：Anthropic / OpenAI / DeepSeek / GLM（智谱）/ Kimi（月之暗面）/ 通义（阿里百炼）。
 * 国内四家均有双协议端点（Anthropic 兼容 + OpenAI 兼容）；默认协议选 **anthropic 兼容**
 * ——MVP 唯一在线 driver 是 claude（#19），anthropic 线协议开箱即用且全部免代理直连；
 * OpenAI 兼容端点保留在 endpoints.openai（codex/opencode driver #22 接入时使用）。
 *
 * env 约定（密钥经环境变量注入 agent 子进程，不写任何全局配置文件）：
 * - anthropic 协议：baseUrlEnv = ANTHROPIC_BASE_URL；keyEnvs 同时注入
 *   ANTHROPIC_AUTH_TOKEN（第三方兼容端点的标准 Bearer 约定）与 ANTHROPIC_API_KEY
 *   （x-api-key 约定）——官方 Anthropic 预设例外，只注入 ANTHROPIC_API_KEY。
 * - openai 协议：OPENAI_API_KEY + OPENAI_BASE_URL。
 */

/** 线协议：anthropic（Messages API 兼容）/ openai（OpenAI 兼容端点） */
export type ProviderProtocol = 'anthropic' | 'openai';

/** env 角色映射：keyEnvs 全部接收密钥值，baseUrlEnv 接收 base URL */
export interface EnvNameMap {
  keyEnvs: string[];
  baseUrlEnv: string;
}

export interface ProviderPreset {
  /** 稳定标识（providers.preset_id 引用） */
  id: string;
  /** 显示名 */
  name: string;
  /** 默认线协议（国内四家 = anthropic 兼容，免代理直连） */
  protocol: ProviderProtocol;
  /** 默认端点（与 protocol 对应） */
  baseUrl: string;
  /** 双协议端点（有则给出；自定义/切换协议时用） */
  endpoints: { anthropic?: string; openai?: string };
  /** 默认 env 角色映射（providers.env_map_json 为 NULL 时使用） */
  envNames: EnvNameMap;
  /** 静态兜底模型清单（/models 拉取失败或未拉取时的 UI 呈现） */
  models: string[];
  /** models.dev 的 provider id（元数据：上下文长度、价格） */
  modelsDevId: string;
}

/** 协议默认 env 映射（自定义 provider 未覆盖时使用） */
export function defaultEnvNames(protocol: ProviderProtocol): EnvNameMap {
  return protocol === 'anthropic'
    ? { keyEnvs: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'], baseUrlEnv: 'ANTHROPIC_BASE_URL' }
    : { keyEnvs: ['OPENAI_API_KEY'], baseUrlEnv: 'OPENAI_BASE_URL' };
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    endpoints: { anthropic: 'https://api.anthropic.com' },
    // 官方端点：x-api-key 约定（不注入 AUTH_TOKEN，避免与订阅 OAuth 混淆）
    envNames: { keyEnvs: ['ANTHROPIC_API_KEY'], baseUrlEnv: 'ANTHROPIC_BASE_URL' },
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
    modelsDevId: 'anthropic',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    endpoints: { openai: 'https://api.openai.com/v1' },
    envNames: { keyEnvs: ['OPENAI_API_KEY'], baseUrlEnv: 'OPENAI_BASE_URL' },
    models: ['gpt-5', 'gpt-5-codex', 'gpt-5-mini', 'gpt-4.1'],
    modelsDevId: 'openai',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    endpoints: {
      anthropic: 'https://api.deepseek.com/anthropic',
      openai: 'https://api.deepseek.com/v1',
    },
    envNames: defaultEnvNames('anthropic'),
    models: ['deepseek-chat', 'deepseek-reasoner'],
    modelsDevId: 'deepseek',
  },
  {
    id: 'glm',
    name: 'GLM（智谱）',
    protocol: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    endpoints: {
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
      openai: 'https://open.bigmodel.cn/api/paas/v4',
    },
    envNames: defaultEnvNames('anthropic'),
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'],
    modelsDevId: 'zai',
  },
  {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    protocol: 'anthropic',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    endpoints: {
      anthropic: 'https://api.moonshot.cn/anthropic',
      openai: 'https://api.moonshot.cn/v1',
    },
    envNames: defaultEnvNames('anthropic'),
    models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview'],
    modelsDevId: 'moonshotai',
  },
  {
    id: 'qwen',
    name: '通义（阿里百炼）',
    protocol: 'anthropic',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    endpoints: {
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    envNames: defaultEnvNames('anthropic'),
    models: ['qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-max'],
    modelsDevId: 'alibaba',
  },
];

export function getPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * 解析某 provider 行实际生效的 env 映射：
 * env_map_json（自定义覆盖）→ 预设默认 → 协议默认。防御性归一（非法 JSON/空数组回落默认）。
 */
export function resolveEnvNames(
  protocol: string,
  presetId: string | null,
  envMapJson: string | null,
): EnvNameMap {
  const proto: ProviderProtocol = protocol === 'openai' ? 'openai' : 'anthropic';
  const fallback = (presetId ? getPreset(presetId)?.envNames : null) ?? defaultEnvNames(proto);
  if (!envMapJson) return fallback;
  try {
    const parsed = JSON.parse(envMapJson) as { keyEnvs?: unknown; baseUrlEnv?: unknown };
    const keyEnvs =
      Array.isArray(parsed.keyEnvs) &&
      parsed.keyEnvs.length > 0 &&
      parsed.keyEnvs.every((k) => typeof k === 'string' && k.length > 0)
        ? (parsed.keyEnvs as string[])
        : fallback.keyEnvs;
    const baseUrlEnv =
      typeof parsed.baseUrlEnv === 'string' && parsed.baseUrlEnv.length > 0
        ? parsed.baseUrlEnv
        : fallback.baseUrlEnv;
    return { keyEnvs, baseUrlEnv };
  } catch {
    return fallback;
  }
}
