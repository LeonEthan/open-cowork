import type { AlwaysAllowRule, PermissionRequestPayload } from '../../agent/events';
import { matchesAlwaysAllowRule } from '../../agent/events';
import { ruleMatchTarget } from '../../agent/commandTarget';
import type { PermissionMode } from '../db/entities';

/**
 * 审批策略引擎（ticket #20，测试接缝 2：纯函数，零副作用零 IO）。
 *
 * 输入：任务权限档位 + 已记忆规则集 + permission_request；
 * 输出：auto_allow / auto_deny / ask 三态裁决。
 *
 * 三档语义（ARCHITECTURE §6 / 票面权威定义）：
 * - readonly 只读：写类/命令类一律 auto_deny（读类工具放行，不查规则——「一律」无例外）；
 * - auto 自动（默认）：命中「总是允许」规则 → auto_allow；未命中 → ask（托盘逐条审批）；
 * - full 完全放权：一律 auto_allow（permission 请求不再打扰用户）。
 *
 * 规则匹配复用 events.ts 的 matchesAlwaysAllowRule（全适配层唯一权威匹配器）。
 * ticket #31：匹配文本为完整命令（ruleMatchTarget 从 input 提取）——request.target
 * 是首行+截断的展示投影，永不进匹配链；多行命令逐行全命中才放行，
 * 任一行未命中 → ask（非 deny）。工具分类保守化（fail-closed 精神）：
 * 白名单外的工具一律视为写/命令类。
 */

/** 裁决结果 */
export type PolicyVerdict =
  /** 自动放行；rulePattern 为命中的规则标签（`Bash: npm *`），档位直放（非规则命中）为 null */
  | { kind: 'auto_allow'; rulePattern: string | null }
  /** 自动拒绝（只读档拦写/命令类）；reason 回传 agent 并落 approvals.reason */
  | { kind: 'auto_deny'; reason: string }
  /** 未命中规则——交审批托盘逐条决议 */
  | { kind: 'ask' };

/**
 * 读类工具白名单（只读档放行）：本地只读，无写、无命令执行、无联网。
 * 注意联网读（WebFetch/WebSearch）不在内——PRD §4.2 把「联网」列入审批把关场景。
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

/** 是否读类工具（白名单制；未知工具一律 false——fail-closed 保守分类） */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

/** 策略裁决（纯函数；rules 按记忆先后排序，先记者优先命中） */
export function decidePermission(
  mode: PermissionMode,
  rules: readonly AlwaysAllowRule[],
  // ticket #31：input 携完整工具入参（匹配文本来源）；缺席的旧调用形状回退 target 匹配
  request: Pick<PermissionRequestPayload, 'toolName' | 'target'> & { input?: unknown },
): PolicyVerdict {
  if (mode === 'full') return { kind: 'auto_allow', rulePattern: null };
  if (mode === 'readonly') {
    if (isReadOnlyTool(request.toolName)) return { kind: 'auto_allow', rulePattern: null };
    return {
      kind: 'auto_deny',
      reason: `权限档位为只读：${request.toolName} 属写/命令类操作，已自动拒绝`,
    };
  }
  // auto：规则命中放行，未命中逐条审批
  // ticket #31：完整命令进匹配链——target 是首行+截断的展示投影，不作匹配依据；
  // 多行命令逐行全命中才算命中（任一行未命中 → ask，语义见 events.ts matchesAlwaysAllowRule）
  const matchTarget = ruleMatchTarget(request.toolName, request.input, request.target);
  const hit = rules.find((r) => matchesAlwaysAllowRule(r, request.toolName, matchTarget));
  if (hit) return { kind: 'auto_allow', rulePattern: `${hit.tool}: ${hit.targetPattern}` };
  return { kind: 'ask' };
}

/**
 * 「总是允许」规则派生（⌘2 记忆的工具 + 目标模式，prototype/approval-flow 定稿口径）：
 * - Bash：首词 + ` *`（`npm install -D eslint` → `Bash: npm *`）；
 * - WebFetch：URL 域名 + `/*`（`https://eslint.org/docs/x` → `WebFetch: eslint.org/*`）；
 * - 其余（Write/Edit 等）：目标原样精确匹配；
 * - 无目标：`*`（该工具的一切目标）。
 */
export function deriveAlwaysAllowRule(toolName: string, target: string | null): AlwaysAllowRule {
  const t = (target ?? '').trim();
  if (t.length === 0) return { tool: toolName, targetPattern: '*' };
  if (toolName === 'Bash') {
    const firstWord = t.split(/\s+/)[0] ?? '';
    return { tool: toolName, targetPattern: firstWord.length > 0 ? `${firstWord} *` : '*' };
  }
  if (toolName === 'WebFetch') {
    const host = /^https?:\/\/([^/\s]+)/.exec(t)?.[1];
    if (host) return { tool: toolName, targetPattern: `${host}/*` };
  }
  return { tool: toolName, targetPattern: t };
}
