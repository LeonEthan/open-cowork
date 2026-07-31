/**
 * 任务启动时的 provider 注入组装（ticket #21，纯函数 seam）：
 * provider 行 + 解密后的密钥 → 子进程 env + 待落盘的 per-workspace 生成文件。
 *
 * 闭环：services/agent.ts agent:start → runtime.prepareProviderEnv（解密 + 落盘）→
 * utility StartCommand.env → DriverStartParams.env → claude driver spread 进子进程
 * （#19 注入点已就绪）。本模块只做纯组装，IO 全在 runtime.ts。
 */

import { agentKindFromType, generateAgentConfig } from './configGen';
import type { AgentConfigTarget } from './configGen';
import type { Provider } from '../db/entities';
import { getPreset, resolveEnvNames } from './presets';

/** 待落盘文件（relPath 相对 workspace-configs/<workspaceId>/，调用方写盘） */
export interface GeneratedConfigFile {
  relPath: string;
  content: string;
}

export interface ProviderInjection {
  /** 注入 agent 子进程的环境变量（与进程 env 合并，本表优先） */
  env: Record<string, string>;
  /** per-workspace 生成文件（claude 为空——env 已全覆盖） */
  files: GeneratedConfigFile[];
  /** 实际生效的密钥 env 名列表（排障/审计用，不含密钥值） */
  keyEnvs: string[];
  baseUrlEnv: string;
  /** 命中的生成配置目标（无则 null，如 claude / 未知 agent） */
  configTarget: AgentConfigTarget | null;
}

/** providerKey：生成文件内的 provider 命名（预设 id 或 'custom'；只留安全字符） */
export function providerKeyOf(provider: Pick<Provider, 'preset_id'>): string {
  const raw = provider.preset_id ?? 'custom';
  const safe = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return safe.length > 0 ? safe : 'custom';
}

/**
 * 组装注入（纯函数）。
 * @param provider providers 表行（只需快照列；不含密钥）
 * @param apiKey 解密后的密钥明文（调用方在 main 内解密，绝不入库/出进程）
 * @param agentType task.agent_type
 * @param model task.model 快照（写生成配置的默认模型；null 用清单首项）
 * @param modelIds 该 provider 当前模型清单（resolveModels 的 id 列表；可为空）
 */
export function buildProviderInjection(
  provider: Pick<Provider, 'preset_id' | 'env_map_json' | 'protocol' | 'base_url' | 'name'>,
  apiKey: string,
  agentType: string,
  model: string | null,
  modelIds: string[],
): ProviderInjection {
  const envNames = resolveEnvNames(provider.protocol, provider.preset_id, provider.env_map_json);

  const env: Record<string, string> = {};
  for (const name of envNames.keyEnvs) env[name] = apiKey;
  env[envNames.baseUrlEnv] = provider.base_url;

  const kind = agentKindFromType(agentType);
  const target = kind
    ? generateAgentConfig(kind, {
        providerKey: providerKeyOf(provider),
        displayName: provider.name,
        protocol: provider.protocol === 'openai' ? 'openai' : 'anthropic',
        baseUrl: provider.base_url,
        keyEnv: envNames.keyEnvs[0],
        models: modelIds,
        defaultModel: model,
      })
    : null;

  const files: GeneratedConfigFile[] = [];
  if (target) {
    files.push({ relPath: `${target.agent}/${target.fileName}`, content: target.content });
  }

  return { env, files, keyEnvs: envNames.keyEnvs, baseUrlEnv: envNames.baseUrlEnv, configTarget: target };
}

/**
 * 生成配置 env 的绝对值（runtime 落盘后回填）：
 * envTarget='dir' → <configRoot>/<agent>；envTarget='file' → <configRoot>/<agent>/<fileName>。
 */
export function configEnvValue(configRoot: string, target: AgentConfigTarget): string {
  return target.envTarget === 'dir'
    ? `${configRoot}/${target.agent}`
    : `${configRoot}/${target.agent}/${target.fileName}`;
}

/** provider 行当前应呈现的模型 id 清单（注入组装用）：缓存优先，回落预设静态清单 */
export function modelIdsForInjection(
  provider: Pick<Provider, 'preset_id' | 'models_json'>,
): string[] {
  if (provider.models_json) {
    try {
      const parsed = JSON.parse(provider.models_json) as { models?: { id?: unknown }[] };
      if (Array.isArray(parsed.models)) {
        const ids = parsed.models
          .map((m) => (m && typeof m.id === 'string' ? m.id : null))
          .filter((id): id is string => id !== null);
        if (ids.length > 0) return ids;
      }
    } catch {
      // 缓存损坏：回落预设
    }
  }
  if (provider.preset_id) {
    const preset = getPreset(provider.preset_id);
    if (preset) return [...preset.models];
  }
  return [];
}
