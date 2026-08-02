import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { TERMINAL_GLOBAL_KEY } from '../../../shared/terminal';
import { useAppStore } from './appStore';

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
}

/**
 * 检查栏可见性派生（§1.2，2026-08 修订：终端迁出为底部抽屉，检查栏收窄为变更单栏）：
 * 手动覆盖优先；自动规则 = 选中任务已有变更。
 * 无选中任务 / 选中任务无变更 → 不占位（不渲染）。
 */
export function resolveInspectorVisible(
  override: InspectorOverride,
  ctx: InspectorAutoCtx,
): boolean {
  if (override === 'open') return true;
  if (override === 'hidden') return false;
  return ctx.hasTask && ctx.hasChanges;
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

/**
 * 终端抽屉手动覆盖偏好（§1.2 修订，附录 B）：
 * null = 上下文化自动；'open' / 'hidden' = 用户手动唤起/隐藏（持久化记忆，⌘T 切换）。
 */
export type TerminalDrawerOverride = 'open' | 'hidden' | null;

/**
 * 终端抽屉可见性派生（§1.2 修订）：手动覆盖优先；
 * 自动规则 = 当前上下文终端活跃（terminalActiveFor 派生，ticket #38 活性定义不变）。
 */
export function resolveTerminalDrawerVisible(
  override: TerminalDrawerOverride,
  terminalActive: boolean,
): boolean {
  if (override === 'open') return true;
  if (override === 'hidden') return false;
  return terminalActive;
}

/** Codex 对齐改造（附录 B）：前进/后退导航的历史条目（视图 + 选中任务） */
export interface NavEntry {
  view: MainView;
  taskId: string | null;
}

/** 导航应用期标记：goNavBack/goNavForward 应用条目时置位，App 侧记录器据此跳过入栈 */
let navApplying = false;
export function isNavApplying(): boolean {
  return navApplying;
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
  /** 终端抽屉手动覆盖偏好（§1.2 修订；持久化记忆，⌘T 切换） */
  terminalDrawerOverride: TerminalDrawerOverride;
  /** 终端抽屉高度（px，顶边拖拽调高记忆；持久化，默认 240） */
  terminalHeight: number;
  /** 终端抽屉当前激活 tab 的会话 key（瞬态；默认回落当前上下文 key，派生见 TerminalDrawer） */
  activeTerminalKey: string | null;
  view: MainView;
  /** utility 直连活性（MessageChannel ping-pong） */
  utilityPong: boolean;
  /** ticket #35（additive）：侧栏 workspace 分组折叠态记忆（默认展开；true=折叠） */
  sidebarWsCollapsed: Record<string, boolean>;
  /** ticket #36（additive，瞬态）：侧栏「新建任务」功能行点击计数——首页 composer 据此聚焦输入框 */
  composerFocusNonce: number;
  /** ticket #36（additive，瞬态）：create 成功而 start 失败的跨视图提示（任务内 composer ready 态呈现，重试成功即清） */
  composerNotice: { taskId: string; message: string } | null;
  /** Codex 对齐改造（附录 B，瞬态）：侧栏搜索过滤串（空串 = 不过滤） */
  sidebarQuery: string;
  /** Codex 对齐改造（附录 B，瞬态）：待办通知弹层开关 */
  noticeOpen: boolean;
  /** Codex 对齐改造（附录 B，瞬态）：前进/后退导航历史栈（容量 50） */
  navBack: NavEntry[];
  navForward: NavEntry[];

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
  /** 手动唤起/隐藏终端抽屉：按当前有效可见性写入相反的覆盖偏好（记忆，§1.2；仿 toggleInspector） */
  toggleTerminalDrawer: (currentlyVisible: boolean) => void;
  /** 拖拽把手实时写入抽屉高度（调用方负责钳制上下限） */
  setTerminalHeight: (height: number) => void;
  /** 切换/摘除抽屉激活 tab（null = 回落默认上下文 key） */
  setActiveTerminalKey: (key: string | null) => void;
  setView: (view: MainView) => void;
  setUtilityPong: (pong: boolean) => void;
  /** ticket #35（additive）：切换某 workspace 分组的展开/折叠 */
  toggleSidebarWorkspace: (id: string) => void;
  /** ticket #36（additive）：请求首页 composer 聚焦输入框（配合 setView('document') + 取消任务选中使用） */
  requestComposerFocus: () => void;
  /** ticket #36（additive）：写入/清除跨视图 composer 提示（null 清除） */
  setComposerNotice: (notice: { taskId: string; message: string } | null) => void;
  /** Codex 对齐改造（附录 B） */
  setSidebarQuery: (q: string) => void;
  setNoticeOpen: (open: boolean) => void;
  /** 导航记录器（App 订阅视图/任务选中变化时调用）：上一条目入后退栈，前进栈清空 */
  pushNav: (entry: NavEntry) => void;
  goNavBack: () => void;
  goNavForward: () => void;
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
      terminalDrawerOverride: null,
      terminalHeight: 240,
      activeTerminalKey: null,
      view: 'document',
      utilityPong: false,
      sidebarWsCollapsed: {},
      composerFocusNonce: 0,
      composerNotice: null,
      sidebarQuery: '',
      noticeOpen: false,
      navBack: [],
      navForward: [],

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
      toggleTerminalDrawer: (currentlyVisible) =>
        set({ terminalDrawerOverride: currentlyVisible ? 'hidden' : 'open' }),
      setTerminalHeight: (terminalHeight) => set({ terminalHeight }),
      setActiveTerminalKey: (activeTerminalKey) => set({ activeTerminalKey }),
      setView: (view) => set({ view }),
      setUtilityPong: (utilityPong) => set({ utilityPong }),
      toggleSidebarWorkspace: (id) =>
        set((s) => ({
          sidebarWsCollapsed: { ...s.sidebarWsCollapsed, [id]: !s.sidebarWsCollapsed[id] },
        })),
      requestComposerFocus: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
      setComposerNotice: (composerNotice) => set({ composerNotice }),
      setSidebarQuery: (sidebarQuery) => set({ sidebarQuery }),
      setNoticeOpen: (noticeOpen) => set({ noticeOpen }),
      pushNav: (entry) =>
        set((s) => ({ navBack: [...s.navBack, entry].slice(-50), navForward: [] })),
      goNavBack: () => {
        const s = useUiStore.getState();
        const entry = s.navBack[s.navBack.length - 1];
        if (!entry) return;
        const current: NavEntry = {
          view: s.view,
          taskId: useAppStore.getState().currentTaskId,
        };
        set((prev) => ({
          navBack: prev.navBack.slice(0, -1),
          navForward: [current, ...prev.navForward].slice(0, 50),
        }));
        navApplying = true;
        try {
          useAppStore.getState().setCurrentTaskId(entry.taskId);
          set({ view: entry.view });
        } finally {
          navApplying = false;
        }
      },
      goNavForward: () => {
        const s = useUiStore.getState();
        const entry = s.navForward[0];
        if (!entry) return;
        const current: NavEntry = {
          view: s.view,
          taskId: useAppStore.getState().currentTaskId,
        };
        set((prev) => ({
          navForward: prev.navForward.slice(1),
          navBack: [...prev.navBack, current].slice(-50),
        }));
        navApplying = true;
        try {
          useAppStore.getState().setCurrentTaskId(entry.taskId);
          set({ view: entry.view });
        } finally {
          navApplying = false;
        }
      },
    }),
    {
      name: 'open-cowork:ui',
      // 只持久化用户偏好；连接态/终端活性/提示点等瞬态不落盘
      partialize: (s) => ({
        themeMode: s.themeMode,
        sidebarCollapsed: s.sidebarCollapsed,
        inspectorOverride: s.inspectorOverride,
        activeInspectorTab: s.activeInspectorTab,
        // §1.2 修订：抽屉唤起偏好与调高记忆属用户偏好，随记忆落盘
        terminalDrawerOverride: s.terminalDrawerOverride,
        terminalHeight: s.terminalHeight,
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
