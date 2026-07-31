import * as providerRepo from '../db/providerRepo';
import type { Provider } from '../db/entities';
import { API_KEY_MASK, decryptApiKey, encryptApiKey, validateApiKey } from '../providers/credentials';
import type { ModelInfo } from '../providers/modelsFetch';
import {
  fetchModelsDevMeta,
  fetchProviderModels,
  mergeModelMeta,
  modelsDevIdOf,
  resolveModels,
  serializeModelsCache,
} from '../providers/modelsFetch';
import { snapshotMeta } from '../providers/modelsDevSnapshot';
import { PROVIDER_PRESETS, getPreset } from '../providers/presets';
import type { ProviderPreset } from '../providers/presets';
import { getEncryptor, nodeHttpGet } from '../providers/runtime';
import type { ServiceContext } from './index';

/**
 * providers 服务（ticket #21）：任意 provider 自由配置（PRD §4.6）。
 *
 * 红线把关：
 * - 密钥进库前必过 safeStorage 加密（getEncryptor 不可用即拒绝，绝不落明文）；
 * - 出 renderer 的 DTO 只给固定掩码——密文与明文都不出 main 进程；
 * - /models 与 models.dev 拉取在 main 内做（密钥不出进程），失败回落静态预设清单。
 */

/** 出 renderer 的 provider DTO（剥离 encrypted_api_key/env_map_json 等敏感列） */
export interface ProviderListItem {
  id: string;
  name: string;
  kind: 'preset' | 'custom';
  protocol: string;
  base_url: string;
  preset_id: string | null;
  has_key: boolean;
  /** 固定掩码（不解密、不泄露长度/前后缀） */
  key_masked: string;
  models_fetched_at: number | null;
  created_at: number;
}

function toDto(p: Provider): ProviderListItem {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    protocol: p.protocol,
    base_url: p.base_url,
    preset_id: p.preset_id,
    has_key: typeof p.encrypted_api_key === 'string' && p.encrypted_api_key.length > 0,
    key_masked: API_KEY_MASK,
    models_fetched_at: p.models_fetched_at,
    created_at: p.created_at,
  };
}

function requireProvider(ctx: ServiceContext, id: unknown): Provider {
  if (typeof id !== 'string' || id.length === 0) throw new Error('需要 provider id');
  const provider = providerRepo.getById(ctx.db, id);
  if (!provider) throw new Error(`provider 不存在: ${id}`);
  return provider;
}

export default function register(ctx: ServiceContext): void {
  /** 内置六家预设目录（静态数据，设置页「一键添加」用） */
  ctx.ipcMain.handle('providers:presets', (): ProviderPreset[] => [...PROVIDER_PRESETS]);

  ctx.ipcMain.handle('providers:list', (): ProviderListItem[] =>
    providerRepo.list(ctx.db).map(toDto),
  );

  /** 预设一键添加：presetId + 密钥（+ 可选协议覆盖——国内四家双协议端点） */
  ctx.ipcMain.handle('providers:add-preset', (_event, input: unknown): ProviderListItem => {
    const raw = input as {
      presetId?: unknown;
      apiKey?: unknown;
      name?: unknown;
      protocol?: unknown;
    } | null;
    if (!raw || typeof raw.presetId !== 'string') throw new Error('providers:add-preset 需要 presetId');
    const preset = getPreset(raw.presetId);
    if (!preset) throw new Error(`未知预设: ${raw.presetId}`);
    if (typeof raw.apiKey !== 'string') throw new Error('providers:add-preset 需要 apiKey');

    // 协议覆盖：预设默认 anthropic 兼容；选 openai 需预设具备对应端点
    const protocol = typeof raw.protocol === 'string' ? raw.protocol : preset.protocol;
    if (protocol !== 'anthropic' && protocol !== 'openai') {
      throw new Error(`非法协议: ${protocol}`);
    }
    const baseUrl = preset.endpoints[protocol];
    if (!baseUrl) throw new Error(`预设「${preset.name}」无 ${protocol} 协议端点`);

    const row = providerRepo.create(ctx.db, {
      name: typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name : preset.name,
      kind: 'preset',
      protocol,
      baseUrl,
      presetId: preset.id,
      encryptedApiKey: encryptApiKey(getEncryptor(), raw.apiKey),
    });
    return toDto(row);
  });

  /** 自定义 provider：base URL + 协议 + 密钥（+ 可选 env 名映射覆盖） */
  ctx.ipcMain.handle('providers:add-custom', (_event, input: unknown): ProviderListItem => {
    const raw = input as {
      name?: unknown;
      protocol?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
      keyEnv?: unknown;
      baseUrlEnv?: unknown;
    } | null;
    if (!raw || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      throw new Error('providers:add-custom 需要 name');
    }
    if (typeof raw.baseUrl !== 'string' || raw.baseUrl.trim().length === 0) {
      throw new Error('providers:add-custom 需要 baseUrl');
    }
    if (raw.protocol !== 'anthropic' && raw.protocol !== 'openai') {
      throw new Error('providers:add-custom 需要 protocol（anthropic / openai）');
    }
    if (typeof raw.apiKey !== 'string') throw new Error('providers:add-custom 需要 apiKey');

    const envMap =
      typeof raw.keyEnv === 'string' && raw.keyEnv.trim().length > 0
        ? {
            keyEnvs: [raw.keyEnv.trim()],
            ...(typeof raw.baseUrlEnv === 'string' && raw.baseUrlEnv.trim().length > 0
              ? { baseUrlEnv: raw.baseUrlEnv.trim() }
              : {}),
          }
        : null;

    const row = providerRepo.create(ctx.db, {
      name: raw.name,
      kind: 'custom',
      protocol: raw.protocol,
      baseUrl: raw.baseUrl,
      presetId: null,
      encryptedApiKey: encryptApiKey(getEncryptor(), raw.apiKey),
      envMap,
    });
    return toDto(row);
  });

  /** 移除 provider（引用它的任务 provider_id/model 快照同事务清空，见 providerRepo.remove） */
  ctx.ipcMain.handle('providers:remove', (_event, id: unknown): { ok: true } => {
    const provider = requireProvider(ctx, id);
    providerRepo.remove(ctx.db, provider.id);
    return { ok: true };
  });

  /** 模型清单（同步解析：缓存 → 预设静态兜底；无网络） */
  ctx.ipcMain.handle('providers:models', (_event, id: unknown): ModelInfo[] => {
    const provider = requireProvider(ctx, id);
    return resolveModels(provider);
  });

  /**
   * 刷新模型清单：/models 拉取（密钥仅在此解密，不出 main）× models.dev 元数据归并后缓存。
   * 远端失败抛错——UI 保留既有清单（预设静态兜底不断档）。
   */
  ctx.ipcMain.handle('providers:refresh-models', async (_event, id: unknown): Promise<ModelInfo[]> => {
    const provider = requireProvider(ctx, id);
    if (!provider.encrypted_api_key) throw new Error(`provider「${provider.name}」缺少密钥`);
    const apiKey = decryptApiKey(getEncryptor(), provider.encrypted_api_key);

    const ids = await fetchProviderModels(
      { httpGet: nodeHttpGet },
      { protocol: provider.protocol, baseUrl: provider.base_url, apiKey },
    );

    // models.dev 元数据：运行时拉取优先，失败回退内置快照（两边都无记录则全 null）
    const devId = modelsDevIdOf(provider);
    let meta: Record<string, { contextLength: number | null; inputPrice: number | null; outputPrice: number | null }> = {};
    if (devId) {
      try {
        meta = await fetchModelsDevMeta({ httpGet: nodeHttpGet }, devId);
      } catch (err) {
        console.warn(`[providers] models.dev 拉取失败，回退快照: ${err instanceof Error ? err.message : err}`);
        meta = Object.fromEntries(ids.map((mid) => [mid, snapshotMeta(devId, mid)]));
      }
    }
    const models = mergeModelMeta(ids, meta);
    const fetchedAt = Date.now();
    providerRepo.setModels(ctx.db, provider.id, serializeModelsCache(models, fetchedAt), fetchedAt);
    return models;
  });

  /** 测试接缝：校验输入密钥格式（不存储）——设置页即时反馈用 */
  ctx.ipcMain.handle('providers:validate-key', (_event, apiKey: unknown): { ok: true } => {
    if (typeof apiKey !== 'string') throw new Error('需要 apiKey');
    validateApiKey(apiKey);
    return { ok: true };
  });
}
