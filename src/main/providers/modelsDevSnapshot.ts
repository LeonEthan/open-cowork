/**
 * models.dev 元数据静态快照（ticket #21）：上下文长度与价格（USD / 1M tokens）。
 *
 * 定位：离线/拉取失败时的兜底——运行时拉取（modelsFetch.fetchModelsDevMeta）成功后
 * 以远端为准并缓存进 providers.models_json；本快照随版本内置，仅保证六家预设的
 * 默认模型「开箱即有元数据展示」（PRD §4.6：上下文长度、价格）。
 *
 * 数值为快照时刻的 models.dev 读数（可能随官方调价漂移——展示语义，折算属 #27）。
 * 结构：MODELS_DEV_SNAPSHOT[modelsDevId][modelId] = { contextLength, inputPrice, outputPrice }。
 */

export interface ModelMeta {
  /** 上下文窗口（tokens） */
  contextLength: number | null;
  /** 输入价（USD / 1M tokens） */
  inputPrice: number | null;
  /** 输出价（USD / 1M tokens） */
  outputPrice: number | null;
}

export const MODELS_DEV_SNAPSHOT: Record<string, Record<string, ModelMeta>> = {
  anthropic: {
    'claude-opus-4-5': { contextLength: 200_000, inputPrice: 5, outputPrice: 25 },
    'claude-sonnet-4-5': { contextLength: 200_000, inputPrice: 3, outputPrice: 15 },
    'claude-haiku-4-5': { contextLength: 200_000, inputPrice: 1, outputPrice: 5 },
    'claude-opus-4-1': { contextLength: 200_000, inputPrice: 15, outputPrice: 75 },
  },
  openai: {
    'gpt-5': { contextLength: 400_000, inputPrice: 1.25, outputPrice: 10 },
    'gpt-5-codex': { contextLength: 400_000, inputPrice: 1.25, outputPrice: 10 },
    'gpt-5-mini': { contextLength: 400_000, inputPrice: 0.25, outputPrice: 2 },
    'gpt-4.1': { contextLength: 1_047_576, inputPrice: 2, outputPrice: 8 },
  },
  deepseek: {
    'deepseek-chat': { contextLength: 128_000, inputPrice: 0.28, outputPrice: 0.42 },
    'deepseek-reasoner': { contextLength: 128_000, inputPrice: 0.55, outputPrice: 2.19 },
  },
  zai: {
    'glm-4.6': { contextLength: 200_000, inputPrice: 0.6, outputPrice: 2.2 },
    'glm-4.5': { contextLength: 131_072, inputPrice: 0.6, outputPrice: 2.2 },
    'glm-4.5-air': { contextLength: 131_072, inputPrice: 0.2, outputPrice: 1.1 },
  },
  moonshotai: {
    'kimi-k2-0905-preview': { contextLength: 262_144, inputPrice: 0.6, outputPrice: 2.5 },
    'kimi-k2-turbo-preview': { contextLength: 262_144, inputPrice: 1.15, outputPrice: 8 },
  },
  alibaba: {
    'qwen3-coder-plus': { contextLength: 1_000_000, inputPrice: 1, outputPrice: 5 },
    'qwen3-coder-flash': { contextLength: 1_000_000, inputPrice: 0.3, outputPrice: 1.5 },
    'qwen3-max': { contextLength: 262_144, inputPrice: 1.2, outputPrice: 6 },
  },
};

const EMPTY_META: ModelMeta = { contextLength: null, inputPrice: null, outputPrice: null };

/** 查快照（无记录返回全 null 元数据——UI 呈「—」） */
export function snapshotMeta(modelsDevId: string | null, modelId: string): ModelMeta {
  if (!modelsDevId) return EMPTY_META;
  return MODELS_DEV_SNAPSHOT[modelsDevId]?.[modelId] ?? EMPTY_META;
}
