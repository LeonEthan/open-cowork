import { useAppStore } from '../stores/appStore';
import { resolveTerminalDrawerVisible, terminalActiveFor, useUiStore } from '../stores/ui';

/**
 * 终端抽屉上下文化可见性（DESIGN.md §1.2 修订，附录 B）：
 * 手动覆盖（持久化偏好，⌘T 切换）优先；自动规则 = 当前上下文终端活跃
 * （ticket #38 活性定义不变：选中 taskId 否则 global 存在存活 pty 会话，terminalActiveFor 派生）。
 */
export function useTerminalDrawerVisible(): boolean {
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const override = useUiStore((s) => s.terminalDrawerOverride);
  const liveTerminals = useUiStore((s) => s.liveTerminals);
  return resolveTerminalDrawerVisible(override, terminalActiveFor(liveTerminals, currentTaskId));
}

/** 当前有效可见性的非响应式读取（⌘T 全局快捷键 handler 用） */
export function peekTerminalDrawerVisible(): boolean {
  const ui = useUiStore.getState();
  const taskId = useAppStore.getState().currentTaskId;
  return resolveTerminalDrawerVisible(
    ui.terminalDrawerOverride,
    terminalActiveFor(ui.liveTerminals, taskId),
  );
}
