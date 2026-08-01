import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type MainView = 'document' | 'settings';

/**
 * 检查栏手动覆盖偏好（ticket #34，DESIGN.md §1.2 上下文化）：
 * null = 上下文化自动；'open' / 'hidden' = 用户手动展开/隐藏（持久化记忆）。
 */
export type InspectorOverride = 'open' | 'hidden' | null;

/** 自动规则的输入（由派生方从各 store 汇集） */
export interface InspectorAutoCtx {
  hasTask: boolean;
  hasChanges: boolean;
  terminalActivated: boolean;
}

/**
 * 检查栏可见性派生（§1.2）：
 * 手动覆盖优先；自动规则 = 终端活跃（点开过终端 tab）或选中任务已有变更。
 * 无选中任务 / 选中任务无变更且终端未活跃 → 不占位（不渲染）。
 */
export function resolveInspectorVisible(
  override: InspectorOverride,
  ctx: InspectorAutoCtx,
): boolean {
  if (override === 'open') return true;
  if (override === 'hidden') return false;
  return ctx.terminalActivated || (ctx.hasTask && ctx.hasChanges);
}

interface UiState {
  /** 主题偏好：默认 system 跟随系统；手动选择后记忆（localStorage，DESIGN.md §6） */
  themeMode: ThemeMode;
  sidebarCollapsed: boolean;
  /** 检查栏手动覆盖偏好（ticket #34；取代原 inspectorCollapsed——折叠概念重构为上下文化） */
  inspectorOverride: InspectorOverride;
  /** 终端 tab 被点开过（本 session 内视为「终端活跃」，自动规则因子；瞬态不落盘） */
  terminalActivated: boolean;
  /** 变更 tab 新内容轻提示（栏隐藏期间变更增长时点亮开关上的状态点；瞬态） */
  changesBadge: boolean;
  /** 检查栏当前 tab id（来自扩展注册表） */
  activeInspectorTab: string | null;
  view: MainView;
  /** utility 直连活性（MessageChannel ping-pong） */
  utilityPong: boolean;
  /** ticket #35（additive）：侧栏 workspace 分组折叠态记忆（默认展开；true=折叠） */
  sidebarWsCollapsed: Record<string, boolean>;

  setThemeMode: (mode: ThemeMode) => void;
  toggleSidebar: () => void;
  /** 手动开关检查栏：按当前有效可见性写入相反的覆盖偏好（记忆，§1.2） */
  toggleInspector: (currentlyVisible: boolean) => void;
  markTerminalActivated: () => void;
  setChangesBadge: (on: boolean) => void;
  setActiveInspectorTab: (id: string) => void;
  setView: (view: MainView) => void;
  setUtilityPong: (pong: boolean) => void;
  /** ticket #35（additive）：切换某 workspace 分组的展开/折叠 */
  toggleSidebarWorkspace: (id: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      themeMode: 'system',
      sidebarCollapsed: false,
      inspectorOverride: null,
      terminalActivated: false,
      changesBadge: false,
      activeInspectorTab: null,
      view: 'document',
      utilityPong: false,
      sidebarWsCollapsed: {},

      setThemeMode: (themeMode) => set({ themeMode }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleInspector: (currentlyVisible) =>
        set({ inspectorOverride: currentlyVisible ? 'hidden' : 'open' }),
      markTerminalActivated: () => set({ terminalActivated: true }),
      setChangesBadge: (changesBadge) => set({ changesBadge }),
      setActiveInspectorTab: (activeInspectorTab) => set({ activeInspectorTab }),
      setView: (view) => set({ view }),
      setUtilityPong: (utilityPong) => set({ utilityPong }),
      toggleSidebarWorkspace: (id) =>
        set((s) => ({
          sidebarWsCollapsed: { ...s.sidebarWsCollapsed, [id]: !s.sidebarWsCollapsed[id] },
        })),
    }),
    {
      name: 'open-cowork:ui',
      // 只持久化用户偏好；连接态/终端活性/提示点等瞬态不落盘
      partialize: (s) => ({
        themeMode: s.themeMode,
        sidebarCollapsed: s.sidebarCollapsed,
        inspectorOverride: s.inspectorOverride,
        activeInspectorTab: s.activeInspectorTab,
        // ticket #35：workspace 分组折叠态属用户偏好，随记忆落盘
        sidebarWsCollapsed: s.sidebarWsCollapsed,
      }),
    },
  ),
);

/** 解析后的实际主题（system 时跟随 prefers-color-scheme） */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}
