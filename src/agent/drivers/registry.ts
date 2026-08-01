import type { AgentDriver } from '../events';

/**
 * Agent driver 注册表。
 *
 * ── 如何新增一个 agent driver ──
 * 1. 在本目录新建 <name>.driver.ts；
 * 2. 默认导出一个满足 AgentDriverDefinition 的对象（含 create() 运行时工厂）；
 * 3. 完成。无需编辑本文件——import.meta.glob('./*.driver.ts') 自动收集。
 *
 * 内置 driver：claude（ticket #19，drivers/claude.driver.ts）；
 * codex / opencode（#22）；pi（#23，降级审批——静态策略兜底）。
 * 审批链路一律 fail-closed（ARCHITECTURE §10）。
 */

/** 审批能力（ARCHITECTURE §2：pi 为降级接入，适配层静态策略兜底） */
export type ApprovalCapability = 'native' | 'degraded' | 'none';

export interface AgentDriverDefinition {
  /** 稳定标识：'claude-code' | 'codex' | 'opencode' | 'pi' | 'custom:<id>' | … */
  id: string;
  displayName: string;
  approval: ApprovalCapability;
  /** 运行时工厂：每个会话经 create() 取一个新 driver 实例（无跨会话状态） */
  create: () => AgentDriver;
}

const modules = import.meta.glob('./*.driver.ts', { eager: true }) as Record<
  string,
  { default?: AgentDriverDefinition }
>;

export function listDrivers(): AgentDriverDefinition[] {
  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, mod]) => {
      if (!mod.default?.id || typeof mod.default.create !== 'function') {
        console.warn(`[drivers] ${path} 缺少默认导出 AgentDriverDefinition（含 create），已跳过`);
        return [];
      }
      return [mod.default];
    });
}

/** 按 id 取 driver 定义（不存在返回 null，调用方负责提示「agent 未接入」） */
export function getDriverDefinition(id: string): AgentDriverDefinition | null {
  return listDrivers().find((d) => d.id === id) ?? null;
}
