import { create } from 'zustand';
import type {
  AddCustomProviderInput,
  AddPresetProviderInput,
  ProviderListItem,
  ProviderModelInfo,
  ProviderPresetInfo,
} from '../../../shared/api';

/**
 * provider 与凭证的本地数据 store（ticket #21）。
 * 数据真源在 main 进程 SQLite——本 store 只是桥 API 拉取的快照 + 变更动作；
 * 密钥永不进 renderer（DTO 只有固定掩码），模型清单按 provider 缓存。
 * 纯浏览器环境（无 preload 桥）下所有动作静默降级为空操作。
 */

interface ProvidersState {
  providers: ProviderListItem[];
  presets: ProviderPresetInfo[];
  /** per-provider 模型清单（models IPC 拉取后缓存；picker/设置页共用） */
  modelsByProvider: Record<string, ProviderModelInfo[]>;
  loaded: boolean;
  lastError: string | null;

  refresh: () => Promise<void>;
  /** 拉取（或重拉）某 provider 的模型清单进缓存 */
  loadModels: (providerId: string) => Promise<void>;
  addPreset: (input: AddPresetProviderInput) => Promise<ProviderListItem | null>;
  addCustom: (input: AddCustomProviderInput) => Promise<ProviderListItem | null>;
  remove: (id: string) => Promise<void>;
  /** /models 远端刷新（失败记 lastError，本地清单保留兜底） */
  refreshModels: (id: string) => Promise<void>;
}

function errMessage(e: unknown): string {
  // Electron IPC 包装的错误形如 "Error invoking remote method 'x': Error: <原始消息>"
  const msg = e instanceof Error ? e.message : String(e);
  const idx = msg.lastIndexOf('Error: ');
  return idx >= 0 ? msg.slice(idx + 'Error: '.length) : msg;
}

export const useProvidersStore = create<ProvidersState>()((set, get) => ({
  providers: [],
  presets: [],
  modelsByProvider: {},
  loaded: false,
  lastError: null,

  refresh: async () => {
    const api = window.openCowork;
    if (!api) return;
    const [providers, presets] = await Promise.all([api.providers.list(), api.providers.presets()]);
    set({ providers, presets, loaded: true });
  },

  loadModels: async (providerId) => {
    const api = window.openCowork;
    if (!api) return;
    try {
      const models = await api.providers.models(providerId);
      set((s) => ({ modelsByProvider: { ...s.modelsByProvider, [providerId]: models } }));
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
  },

  addPreset: async (input) => {
    const api = window.openCowork;
    if (!api) return null;
    try {
      const row = await api.providers.addPreset(input);
      set({ lastError: null });
      await get().refresh();
      return row;
    } catch (e) {
      set({ lastError: errMessage(e) });
      return null;
    }
  },

  addCustom: async (input) => {
    const api = window.openCowork;
    if (!api) return null;
    try {
      const row = await api.providers.addCustom(input);
      set({ lastError: null });
      await get().refresh();
      return row;
    } catch (e) {
      set({ lastError: errMessage(e) });
      return null;
    }
  },

  remove: async (id) => {
    const api = window.openCowork;
    if (!api) return;
    try {
      await api.providers.remove(id);
      set({ lastError: null });
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
    await get().refresh();
  },

  refreshModels: async (id) => {
    const api = window.openCowork;
    if (!api) return;
    try {
      const models = await api.providers.refreshModels(id);
      set((s) => ({
        lastError: null,
        modelsByProvider: { ...s.modelsByProvider, [id]: models },
      }));
      await get().refresh(); // models_fetched_at 更新
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
  },
}));
