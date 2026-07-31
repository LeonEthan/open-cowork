/**
 * Agent driver 注册表（ticket #17 只建空注册表与类型，不放真 driver）。
 *
 * ── 如何新增一个 agent driver ──
 * 1. 在本目录新建 <name>.driver.ts；
 * 2. 默认导出一个满足 AgentDriverDefinition 的对象；
 * 3. 完成。无需编辑本文件——import.meta.glob('./ *.driver.ts') 自动收集。
 *
 * 四家内置 driver（claude-code / codex / opencode / pi）与自定义 ACP agent
 * 由后续「Agent 接入」票据实现；审批链路一律 fail-closed（ARCHITECTURE §10）。
 */

/** 审批能力（ARCHITECTURE §2：pi 为降级接入，适配层静态策略兜底） */
export type ApprovalCapability = 'native' | 'degraded' | 'none';

export interface AgentDriverDefinition {
  /** 稳定标识：'claude-code' | 'codex' | 'opencode' | 'pi' | 'custom:<id>' | … */
  id: string;
  displayName: string;
  approval: ApprovalCapability;
  /**
   * 后续票据补充：spawn/session/事件归一（ACP 语义）等接口。
   * 真实事件流统一经 UsageEvent / 审批事件归一后回传。
   */
}

const modules = import.meta.glob('./*.driver.ts', { eager: true }) as Record<
  string,
  { default?: AgentDriverDefinition }
>;

export function listDrivers(): AgentDriverDefinition[] {
  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, mod]) => {
      if (!mod.default?.id) {
        console.warn(`[drivers] ${path} 缺少默认导出 AgentDriverDefinition，已跳过`);
        return [];
      }
      return [mod.default];
    });
}
