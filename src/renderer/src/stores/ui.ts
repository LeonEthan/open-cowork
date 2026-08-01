import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { TERMINAL_GLOBAL_KEY } from '../../../shared/terminal';

/** 无任务选中时的终端会话 key（wire 契约单一来源在 shared/terminal.ts，此处 re-export 供 renderer 引用） */
export { TERMINAL_GLOBAL_KEY };

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
  /** 当前上下文（选中 taskId 或 TERMINAL_GLOBAL_KEY）存在存活 pty 会话（ticket #38） */
  terminalActive: boolean;
}

/**
 * 检查栏可见性派生（§1.2）：
 * 手动覆盖优先；自动规则 = 当前上下文终端活跃（存活 pty 会话）或选中任务已有变更。
 * 无选中任务 / 选中任务无变更且终端未活跃 → 不占位（不渲染）。
 */
export function resolveInspectorVisible(
  override: InspectorOverride,
  ctx: InspectorAutoCtx,
): boolean {
  if (override === 'open') return true;
  if (override === 'hidden') return false;
  return ctx.terminalActive || (ctx.hasTask && ctx.hasChanges);
}

/**
 * 终端活跃派生（ticket #38）：按上下文判定——选中任务看其 taskId 会话，
 * 无选中任务看 global 会话；其他上下文的存活会话不泄漏（取代 #34 的全局锁存）。
 */
export function terminalActiveFor(
  liveTerminals: Record<string, true>,
  taskId: string | null,
): boolean {
  return liveTerminals[taskId ?? TERMINAL_GLOBAL_KEY] === true;
}

interface UiState {
  /** 主题偏好：默认 system 跟随系统；手动选择后记忆（localStorage，DESIGN.md §6） */
  themeMode: ThemeMode;
  sidebarCollapsed: boolean;
  /** 检查栏手动覆盖偏好（ticket #34；取代原 inspectorCollapsed——折叠概念重构为上下文化） */
  inspectorOverride: InspectorOverride;
  /**
   * 存活 pty 会话集合（ticket #38；取代 #34 的 terminalActivated 全局锁存）：
   * key=taskId 或 TERMINAL_GLOBAL_KEY；由 main 侧 pty:list 快照播种 + pty:session 事件增量。
   * 瞬态不落盘——失效路径明确：shell 退出 / pty dispose / 应用重启。
   */
  liveTerminals: Record<string, true>;
  /** 变更 tab 新内容轻提示（栏隐藏期间变更增长时点亮开关上的状态点；瞬态） */
  changesBadge: boolean;
  /** 检查栏当前 tab id（来自扩展注册表） */
  activeInspectorTab: string | null;
  view: MainView;
  /** utility 直连活性（MessageChannel ping-pong） */
  utilityPong: boolean;
  /** ticket #35（additive）：侧栏 workspace 分组折叠态记忆（默认展开；true=折叠） */
  sidebarWsCollapsed: Record<string, boolean>;
  /** ticket #36（additive，瞬态）：侧栏「新建任务」功能行点击计数——首页 composer 据此聚焦输入框 */
  composerFocusNonce: number;
  /** ticket #36（additive，瞬态）：create 成功而 start 失败的跨视图提示（任务内 composer ready 态呈现，重试成功即清） */
  composerNotice: { taskId: string; message: string } | null;

  setThemeMode: (mode: ThemeMode) => void;
  toggleSidebar: () => void;
  /** 手动开关检查栏：按当前有效可见性写入相反的覆盖偏好（记忆，§1.2） */
  toggleInspector: (currentlyVisible: boolean) => void;
  /** ticket #38：pty 会话快照播种（app 启动/渲染层重载时经 pty:list 拉取） */
  setLiveTerminals: (keys: string[]) => void;
  /** ticket #38：pty:session 事件增量——alive=true 登记存活，false 移除 */
  setTerminalAlive: (key: string, alive: boolean) => void;
  setChangesBadge: (on: boolean) => void;
  setActiveInspectorTab: (id: string) => void;
  setView: (view: MainView) => void;
  setUtilityPong: (pong: boolean) => void;
  /** ticket #35（additive）：切换某 workspace 分组的展开/折叠 */
  toggleSidebarWorkspace: (id: string) => void;
  /** ticket #36（additive）：请求首页 composer 聚焦输入框（配合 setView('document') + 取消任务选中使用） */
  requestComposerFocus: () => void;
  /** ticket #36（additive）：写入/清除跨视图 composer 提示（null 清除） */
  setComposerNotice: (notice: { taskId: string; message: string } | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      themeMode: 'system',
      sidebarCollapsed: false,
      inspectorOverride: null,
      liveTerminals: {},
      changesBadge: false,
      activeInspectorTab: null,
      view: 'document',
      utilityPong: false,
      sidebarWsCollapsed: {},
      composerFocusNonce: 0,
      composerNotice: null,

      setThemeMode: (themeMode) => set({ themeMode }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleInspector: (currentlyVisible) =>
        set({ inspectorOverride: currentlyVisible ? 'hidden' : 'open' }),
      setLiveTerminals: (keys) =>
        set({ liveTerminals: Object.fromEntries(keys.map((k) => [k, true as const])) }),
      setTerminalAlive: (key, alive) =>
        set((s) => {
          const next = { ...s.liveTerminals };
          if (alive) next[key] = true;
          else delete next[key];
          return { liveTerminals: next };
        }),
      setChangesBadge: (changesBadge) => set({ changesBadge }),
      setActiveInspectorTab: (activeInspectorTab) => set({ activeInspectorTab }),
      setView: (view) => set({ view }),
      setUtilityPong: (utilityPong) => set({ utilityPong }),
      toggleSidebarWorkspace: (id) =>
        set((s) => ({
          sidebarWsCollapsed: { ...s.sidebarWsCollapsed, [id]: !s.sidebarWsCollapsed[id] },
        })),
      requestComposerFocus: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
      setComposerNotice: (composerNotice) => set({ composerNotice }),
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
