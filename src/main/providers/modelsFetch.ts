/**
 * 模型清单与 models.dev 元数据（ticket #21，PRD §4.6 / ARCHITECTURE §3）。
 *
 * - /models 拉取：OpenAI 兼容（GET {baseUrl}/models → {data:[{id}]}）与
 *   Anthropic 兼容（同形 {data:[{id,display_name?}]}）两协议解析归一；
 * - models.dev 元数据：运行时拉取 https://models.dev/api.json 提取该 provider 的
 *   模型上下文长度/价格，失败回退内置快照（modelsDevSnapshot.ts）；
 * - resolveModels：provider 行的呈现清单——models_json 缓存 → 预设静态清单+快照元数据。
 *
 * HTTP 走可注入接口（vitest stub 响应，不起网络）；纯 Node 无 Electron 依赖。
 */

import type { Provider } from '../db/entities';
import { getPreset } from './presets';
import type { ModelMeta } from './modelsDevSnapshot';
import { snapshotMeta } from './modelsDevSnapshot';

/** 清单条目（id + 元数据；元数据可空——无记录时 UI 呈「—」） */
export interface ModelInfo extends ModelMeta {
  id: string;
}

// ── HTTP 接缝 ─────────────────────────────────────────────────────────────

export interface HttpGetResult {
  status: number;
  body: string;
}

/** 可注入 GET（runtime 用 node https 实现；vitest 用 stub） */
export type HttpGet = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<HttpGetResult>;

const DEFAULT_TIMEOUT_MS = 10_000;

// ── /models 解析 ──────────────────────────────────────────────────────────

/**
 * 解析 /models 响应体为模型 id 清单（协议归一：两家的 /models 都是 {data:[{id,…}]} 形）。
 * 非法响应抛错（调用方回落静态清单）。
 */
export function parseModelsBody(body: string): string[] {
  const doc = JSON.parse(body) as { data?: unknown };
  if (!doc || !Array.isArray(doc.data)) throw new Error('/models 响应缺少 data 数组');
  const ids = doc.data
    .map((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string'
      ? (m as { id: string }).id
      : null))
    .filter((id): id is string => id !== null && id.length > 0);
  if (ids.length === 0) throw new Error('/models 响应无有效模型条目');
  return [...new Set(ids)];
}

/** /models 请求头：协议决定鉴权形态（anthropic=x-api-key+version；openai=Bearer） */
export function modelsRequestHeaders(protocol: string, apiKey: string): Record<string, string> {
  return protocol === 'openai'
    ? { authorization: `Bearer ${apiKey}` }
    : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
}

/** 拉取 /models（注入 httpGet；非 2xx/解析失败抛错） */
export async function fetchProviderModels(
  deps: { httpGet: HttpGet },
  args: { protocol: string; baseUrl: string; apiKey: string },
): Promise<string[]> {
  const url = `${args.baseUrl.replace(/\/+$/, '')}/models`;
  const res = await deps.httpGet(url, modelsRequestHeaders(args.protocol, args.apiKey), DEFAULT_TIMEOUT_MS);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`/models 拉取失败（HTTP ${res.status}）`);
  }
  return parseModelsBody(res.body);
}

// ── models.dev 元数据 ─────────────────────────────────────────────────────

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';

/**
 * 解析 models.dev api.json，提取某 provider 的 { modelId → 元数据 }。
 * 形状：{ <providerId>: { models: { <modelId>: { cost:{input,output}, limit:{context} } } } }。
 */
export function parseModelsDevBody(body: string, modelsDevId: string): Record<string, ModelMeta> {
  const doc = JSON.parse(body) as Record<string, { models?: Record<string, {
    cost?: { input?: unknown; output?: unknown };
    limit?: { context?: unknown };
  }> }>;
  const entry = doc?.[modelsDevId];
  if (!entry || typeof entry !== 'object' || !entry.models) return {};
  const out: Record<string, ModelMeta> = {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const [id, m] of Object.entries(entry.models)) {
    out[id] = {
      contextLength: num(m?.limit?.context),
      inputPrice: num(m?.cost?.input),
      outputPrice: num(m?.cost?.output),
    };
  }
  return out;
}

/** 运行时拉取 models.dev（失败抛错——调用方回退快照） */
export async function fetchModelsDevMeta(
  deps: { httpGet: HttpGet },
  modelsDevId: string,
): Promise<Record<string, ModelMeta>> {
  const res = await deps.httpGet(MODELS_DEV_API_URL, {}, DEFAULT_TIMEOUT_MS);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`models.dev 拉取失败（HTTP ${res.status}）`);
  }
  return parseModelsDevBody(res.body, modelsDevId);
}

// ── 清单归并与行级解析 ────────────────────────────────────────────────────

/** id 清单 × 元数据表归并（无记录给全 null 元数据） */
export function mergeModelMeta(ids: string[], meta: Record<string, ModelMeta>): ModelInfo[] {
  return ids.map((id) => ({ id, ...(meta[id] ?? { contextLength: null, inputPrice: null, outputPrice: null }) }));
}

/** provider 行的 models.dev id（预设有约定；自定义无——返回 null 走全 null 元数据） */
export function modelsDevIdOf(provider: Pick<Provider, 'preset_id'>): string | null {
  return provider.preset_id ? (getPreset(provider.preset_id)?.modelsDevId ?? null) : null;
}

/** models_json 缓存文档形状（providers:setModels / providers:models 共用） */
export interface ModelsCacheDoc {
  version: 1;
  fetchedAt: number;
  models: ModelInfo[];
}

export function serializeModelsCache(models: ModelInfo[], fetchedAt: number): string {
  const doc: ModelsCacheDoc = { version: 1, fetchedAt, models };
  return JSON.stringify(doc);
}

/** 解析 models_json 缓存（损坏/缺字段返回 null——调用方回落） */
export function parseModelsCache(modelsJson: string | null): ModelInfo[] | null {
  if (!modelsJson) return null;
  try {
    const doc = JSON.parse(modelsJson) as Partial<ModelsCacheDoc>;
    if (!Array.isArray(doc.models) || doc.models.length === 0) return null;
    const models: ModelInfo[] = [];
    for (const m of doc.models) {
      if (!m || typeof m.id !== 'string' || m.id.length === 0) return null;
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      models.push({
        id: m.id,
        contextLength: num(m.contextLength),
        inputPrice: num(m.inputPrice),
        outputPrice: num(m.outputPrice),
      });
    }
    return models;
  } catch {
    return null;
  }
}

/**
 * provider 行的呈现清单（同步、无网络）：
 * 1. models_json 缓存（/models 拉取 + models.dev 归并过的）；
 * 2. 预设静态清单 × 内置快照元数据；
 * 3. 自定义 provider 无缓存 → 空清单（设置页「刷新模型」拉取后才有）。
 */
export function resolveModels(provider: Pick<Provider, 'preset_id' | 'models_json'>): ModelInfo[] {
  const cached = parseModelsCache(provider.models_json);
  if (cached) return cached;
  if (provider.preset_id) {
    const preset = getPreset(provider.preset_id);
    if (preset) {
      return preset.models.map((id) => ({ id, ...snapshotMeta(preset.modelsDevId, id) }));
    }
  }
  return [];
}
