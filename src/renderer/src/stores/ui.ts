import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type MainView = 'document' | 'settings';

interface UiState {
  /** 主题偏好：默认 system 跟随系统；手动选择后记忆（localStorage，DESIGN.md §6） */
  themeMode: ThemeMode;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  /** 检查栏当前 tab id（来自扩展注册表） */
  activeInspectorTab: string | null;
  view: MainView;
  /** utility 直连活性（MessageChannel ping-pong） */
  utilityPong: boolean;
  /** ticket #35（additive）：侧栏 workspace 分组折叠态记忆（默认展开；true=折叠） */
  sidebarWsCollapsed: Record<string, boolean>;

  setThemeMode: (mode: ThemeMode) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
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
      inspectorCollapsed: false,
      activeInspectorTab: null,
      view: 'document',
      utilityPong: false,
      sidebarWsCollapsed: {},

      setThemeMode: (themeMode) => set({ themeMode }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleInspector: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),
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
      // 只持久化用户偏好；连接态等瞬态不落盘
      partialize: (s) => ({
        themeMode: s.themeMode,
        sidebarCollapsed: s.sidebarCollapsed,
        inspectorCollapsed: s.inspectorCollapsed,
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
