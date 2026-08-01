import { useAppStore } from '../stores/appStore';
import { useChangesStore } from '../stores/changes';
import { resolveInspectorVisible, terminalActiveFor, useUiStore } from '../stores/ui';

/**
 * 检查栏上下文化可见性（ticket #34，DESIGN.md §1.2）：
 * 手动覆盖（持久化偏好）优先；自动规则 = 当前上下文终端活跃或选中任务已有变更。
 * ticket #38：终端活跃 = 当前上下文（taskId 或 global）存在存活 pty 会话（terminalActiveFor 派生）。
 */
export function useInspectorVisible(): boolean {
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const hasChanges = useChangesStore((s) =>
    currentTaskId ? (s.byTask[currentTaskId]?.length ?? 0) > 0 : false,
  );
  const override = useUiStore((s) => s.inspectorOverride);
  const liveTerminals = useUiStore((s) => s.liveTerminals);
  return resolveInspectorVisible(override, {
    hasTask: currentTaskId !== null,
    hasChanges,
    terminalActive: terminalActiveFor(liveTerminals, currentTaskId),
  });
}

/** 当前有效可见性的非响应式读取（全局快捷键 handler 用） */
export function peekInspectorVisible(): boolean {
  const ui = useUiStore.getState();
  const taskId = useAppStore.getState().currentTaskId;
  const hasChanges = taskId
    ? (useChangesStore.getState().byTask[taskId]?.length ?? 0) > 0
    : false;
  return resolveInspectorVisible(ui.inspectorOverride, {
    hasTask: taskId !== null,
    hasChanges,
    terminalActive: terminalActiveFor(ui.liveTerminals, taskId),
  });
}
