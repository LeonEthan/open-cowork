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
 * codex / opencode（#22）、pi（#23，降级审批）后续按同一接口补。
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

// ── ticket #26（additive）：自定义 ACP agent 动态实例 ─────────────────────
// 内置四家经上方 glob 收集；自定义 ACP agent 的注册 spec 存 main 侧 SQLite
// （custom_agents 表，utility 无 DB 访问）——main 在 start 指令里随附 spec，
// 经本函数实例化 acp driver（src/agent/drivers/acp.driver.ts）。

import { createAcpDriver } from './acp.driver';

export interface CustomAgentSpec {
  /** custom_agents.id（driver 定义 id 拼为 'custom:<id>'，与 task.agent_type 对应） */
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function createCustomDriverDefinition(spec: CustomAgentSpec): AgentDriverDefinition {
  const driverId = `custom:${spec.id}`;
  return {
    id: driverId,
    displayName: spec.name,
    approval: 'native', // ACP session/request_permission 原生审批（#20 中继链）
    create: () =>
      createAcpDriver({
        id: driverId,
        displayName: spec.name,
        command: spec.command,
        args: spec.args,
        ...(spec.env ? { env: spec.env } : {}),
      }),
  };
}
// ── ticket #26 end ──────────────────────────────────────────────────────────
