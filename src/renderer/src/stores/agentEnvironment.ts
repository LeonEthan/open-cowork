import { create } from 'zustand';
import type {
  AgentEnvironmentInfo,
  CustomAgentInfo,
  RegisterCustomAgentInput,
} from '../../../shared/api';
import { setCustomAgentNameSnapshot } from '../lib/taskStatus';
import { useAgentsStore } from './agents';

/**
 * agent 环境治理 store（ticket #26，独立域）：侧栏横幅与设置页 Agent 卡片的数据源。
 * 真源在 main（services/agentDetect.ts + services/customAgents.ts）；本 store 只是快照 + 动作。
 *
 * 与 #22 picker store（stores/agents.ts）的一致性：任何会改变探测结果的动作
 * （refresh / 路径修复 / 自定义增删重测）都把最新合并列表同步进 picker store——
 *  picker 置灰与横幅/卡片永远同口径。
 * 纯浏览器环境（无 preload 桥）下静默降级为空列表。
 */

interface AgentEnvironmentState {
  agents: AgentEnvironmentInfo[];
  customAgents: CustomAgentInfo[];
  loaded: boolean;
  /** 全局重测进行中（防连点；卡片「重新检测」按钮态） */
  reprobing: boolean;
  lastError: string | null;
  /** 探测日志（agents:probe-log 拉取；key = agentId / custom:<dbId>） */
  probeLogs: Record<string, string[]> | null;

  load: () => Promise<void>;
  reprobeAll: () => Promise<void>;
  setOverridePath: (agentId: string, path: string) => Promise<boolean>;
  clearOverride: (agentId: string) => Promise<void>;
  loadProbeLogs: () => Promise<void>;
  createCustom: (input: RegisterCustomAgentInput) => Promise<boolean>;
  removeCustom: (id: string) => Promise<void>;
  reprobeCustom: (id: string) => Promise<void>;
}

function errMessage(e: unknown): string {
  // Electron IPC 包装的错误形如 "Error invoking remote method 'x': Error: <原始消息>"
  const msg = e instanceof Error ? e.message : String(e);
  const idx = msg.lastIndexOf('Error: ');
  return idx >= 0 ? msg.slice(idx + 'Error: '.length) : msg;
}

/** 探测结果三处同步：本 store + #22 picker store + agentLabel 自定义名快照 */
function syncAgents(set: (p: Partial<AgentEnvironmentState>) => void, agents: AgentEnvironmentInfo[]): void {
  set({ agents, loaded: true });
  useAgentsStore.setState({ agents, loaded: true });
  setCustomAgentNameSnapshot(
    new Map(agents.filter((a) => a.source === 'custom').map((a) => [a.id, a.displayName])),
  );
}

export const useAgentEnvironmentStore = create<AgentEnvironmentState>()((set, get) => ({
  agents: [],
  customAgents: [],
  loaded: false,
  reprobing: false,
  lastError: null,
  probeLogs: null,

  load: async () => {
    const api = window.openCowork;
    if (!api) return;
    const [agents, customAgents] = await Promise.all([
      api.agentEnvironment.list(),
      api.customAgents.list(),
    ]);
    syncAgents(set, agents);
    set({ customAgents });
  },

  reprobeAll: async () => {
    const api = window.openCowork;
    if (!api || get().reprobing) return;
    set({ reprobing: true });
    try {
      const [agents, customAgents] = await Promise.all([
        api.agentEnvironment.refresh(),
        api.customAgents.list(),
      ]);
      syncAgents(set, agents);
      set({ customAgents, lastError: null });
    } catch (e) {
      set({ lastError: errMessage(e) });
    } finally {
      set({ reprobing: false });
    }
  },

  setOverridePath: async (agentId, path) => {
    const api = window.openCowork;
    if (!api) return false;
    try {
      const agents = await api.agentEnvironment.setOverridePath(agentId, path);
      syncAgents(set, agents);
      set({ lastError: null });
      return true;
    } catch (e) {
      set({ lastError: errMessage(e) });
      return false;
    }
  },

  clearOverride: async (agentId) => {
    const api = window.openCowork;
    if (!api) return;
    try {
      const agents = await api.agentEnvironment.clearOverride(agentId);
      syncAgents(set, agents);
      set({ lastError: null });
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
  },

  loadProbeLogs: async () => {
    const api = window.openCowork;
    if (!api) return;
    const probeLogs = await api.agentEnvironment.probeLog();
    set({ probeLogs });
  },

  createCustom: async (input) => {
    const api = window.openCowork;
    if (!api) return false;
    try {
      const customAgents = await api.customAgents.create(input);
      set({ customAgents, lastError: null });
      // 合并列表重拉（新注册的自定义 agent 进 picker/横幅口径）
      const agents = await api.agentEnvironment.list();
      syncAgents(set, agents);
      return true;
    } catch (e) {
      set({ lastError: errMessage(e) });
      return false;
    }
  },

  removeCustom: async (id) => {
    const api = window.openCowork;
    if (!api) return;
    try {
      await api.customAgents.remove(id);
      set({ lastError: null });
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
    const [customAgents, agents] = await Promise.all([
      api.customAgents.list(),
      api.agentEnvironment.list(),
    ]);
    set({ customAgents });
    syncAgents(set, agents);
  },

  reprobeCustom: async (id) => {
    const api = window.openCowork;
    if (!api) return;
    try {
      const customAgents = await api.customAgents.reprobe(id);
      set({ customAgents, lastError: null });
      const agents = await api.agentEnvironment.list();
      syncAgents(set, agents);
    } catch (e) {
      set({ lastError: errMessage(e) });
    }
  },
}));
