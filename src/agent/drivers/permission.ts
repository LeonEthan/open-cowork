import type {
  DriverStartParams,
  PermissionDecision,
  PermissionRequestPayload,
} from '../events';
import { matchesAlwaysAllowRule } from '../events';
import { ruleMatchTarget } from '../commandTarget';

/**
 * 审批决议公共路径（ticket #22，codex/opencode driver 共用；claude driver 的内联逻辑同源）。
 *
 * 顺序（fail-closed 红线，ARCHITECTURE §10）：
 * 1. 「总是允许」规则命中 → 直接 allow(always)（#20 注入规则集）；
 *    ticket #31：匹配用完整命令文本（ruleMatchTarget 从 input 提取）——request.target
 *    是首行+截断的展示投影，永不进匹配链；多行命令逐行全命中才放行；
 * 2. 未配置 permissionHandler → deny（绝不放行）；
 * 3. handler 异常/超时（默认 120s）→ deny。
 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

export async function resolvePermission(
  params: Pick<
    DriverStartParams,
    'permissionHandler' | 'alwaysAllowRules' | 'permissionTimeoutMs'
  >,
  request: PermissionRequestPayload,
): Promise<PermissionDecision> {
  const rules = params.alwaysAllowRules ?? [];
  const matchTarget = ruleMatchTarget(request.toolName, request.input, request.target);
  if (rules.some((r) => matchesAlwaysAllowRule(r, request.toolName, matchTarget))) {
    return { behavior: 'allow', always: true };
  }
  if (!params.permissionHandler) {
    return { behavior: 'deny', message: '未配置审批链路（fail-closed）' };
  }
  const timeoutMs = params.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  try {
    return await Promise.race([
      params.permissionHandler(request),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`审批超时（${timeoutMs}ms）`)), timeoutMs),
      ),
    ]);
  } catch (err) {
    return {
      behavior: 'deny',
      message: err instanceof Error ? err.message : '审批链路异常（fail-closed）',
    };
  }
}
