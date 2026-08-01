import type { TaskStatus } from '../../../shared/api';

/**
 * 任务六态的呈现映射（ticket #18，DESIGN.md §1/§2/§5）：
 * - 状态点颜色只许用语义 token（见 app.css .status-dot.* 变体）；
 * - 仅 running 用 pulse 动效（§5 允许的三类动效之一），其余状态一律静态。
 */

export const STATUS_LABELS: Record<TaskStatus, string> = {
  ready: '就绪',
  running: '运行中',
  awaiting_approval: '待审批',
  awaiting_review: '待复查',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 状态点 CSS 类（.status-dot + 变体类） */
export function statusDotClass(status: TaskStatus): string {
  return `status-dot ${status}`;
}

/** 内置 agent 占位目录（静态数据，#19 接 agent catalog 后注水替换） */
export const AGENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'opencode' },
  { value: 'pi', label: 'pi' },
];

// ── ticket #26（additive）：自定义 agent 显示名快照 ─────────────────────
// task.agent_type = 'custom:<dbId>'——显示名存 main 侧 DB，本模块是纯函数库无法
// 异步查询；stores/agentEnvironment.ts 在每次探测同步后注入最新快照。
let customAgentNames: ReadonlyMap<string, string> = new Map();

export function setCustomAgentNameSnapshot(names: ReadonlyMap<string, string>): void {
  customAgentNames = names;
}

export function agentLabel(agentType: string): string {
  if (agentType.startsWith('custom:')) {
    return customAgentNames.get(agentType) ?? '自定义 agent';
  }
  return AGENT_OPTIONS.find((a) => a.value === agentType)?.label ?? agentType;
}
