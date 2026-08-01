/**
 * 命令/目标文本归一器（ticket #31）：「总是允许」规则匹配与 UI 展示的文本来源收口。
 *
 * 背景（#31 安全语义缺陷，Phase G 终审确认）：规则匹配链曾复用**展示投影**
 * （Bash 首行 + 120 字符截断）——多行命令只匹配首行即放行全文，
 * 授权对象与实际执行内容定性不一致（违反 PRD §4.2 授权语义 / ARCHITECTURE §6）。
 * 绕过剧本：规则 `Bash: npm install`（无通配精确）对 "npm install\nrm -rf ~"
 * 命中首行 target 而放行整段。
 *
 * 本模块把两个用途拆成两条纯函数，杜绝再次混用：
 * - extractFullCommand：按工具取**完整**命令文本（不投影、不截断）——规则匹配唯一入口；
 * - displayTarget：首行 + 截断投影——**仅** UI 展示（极简工具行 / 托盘目标），永不进匹配链。
 *
 * claude/codex/opencode 三家 driver 的投影逻辑统一收口于此（#31 前各自实现，口径漂移：
 * claude 首行+截断、opencode 首行+截断、codex 复用 claude）。pi 的 tool_call 展示投影
 * 不进任何运行时规则链（静态策略为工具粒度，见 pi.driver.ts），acp 的目标归纳来源
 * 形状不同（locations/title），均不在本收口范围。
 */

/** 非空字符串取值（键缺失/非串/空串一律 null） */
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * 按工具取完整命令/目标文本（规则匹配用：无首行投影、无长度截断）。
 *
 * 工具名大小写不敏感：规则匹配层已归一为 claude 风格（'Bash'），driver 展示层
 * 可能持各家原生名（'bash'）——同一口径处理。
 * 键名兼容各家 wire 差异：file_path（claude）/ filePath（opencode）/ path（pi 系）/
 * grantRoot（codex fileChange 审批）。
 * 未知工具 → null（调用方按 fail-closed 方向回退，见 ruleMatchTarget）。
 */
export function extractFullCommand(toolName: string, input: unknown): string | null {
  const obj = (input ?? {}) as Record<string, unknown>;
  switch (toolName.toLowerCase()) {
    case 'bash':
      return str(obj.command);
    case 'edit':
    case 'write':
    case 'read':
    case 'notebookedit':
    case 'notebookread':
      return (
        str(obj.file_path) ?? str(obj.filePath) ?? str(obj.path) ?? str(obj.grantRoot)
      );
    case 'glob':
    case 'grep':
    case 'find':
      return str(obj.pattern);
    case 'ls':
      return str(obj.path);
    case 'webfetch':
      return str(obj.url);
    case 'websearch':
      return str(obj.query);
    case 'task':
    case 'agent':
      return str(obj.description) ?? str(obj.prompt);
    default:
      return null;
  }
}

/**
 * 展示投影（**仅** UI：极简工具行 / 审批托盘目标）：首行 + 120 字符截断。
 * 永不进规则匹配链——匹配一律走 extractFullCommand / ruleMatchTarget。
 */
export function displayTarget(text: string | null): string | null {
  if (!text) return null;
  const firstLine = text.split('\n')[0] ?? '';
  if (firstLine.length === 0) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

/**
 * 展示用目标归纳（driver 极简行 / 托盘）：完整提取 + 展示投影；
 * fallback（如 claude blockedPath）在无法归纳时使用，同样经投影。
 */
export function deriveDisplayTarget(
  toolName: string,
  input: unknown,
  fallback?: string | null,
): string | null {
  return displayTarget(extractFullCommand(toolName, input) ?? fallback ?? null);
}

/**
 * 规则匹配用目标文本：完整命令优先；input 缺规范键时回退 driver 归纳的 target
 * （该回退只发生在 driver 无法提供更完整文本的场景——如 ACP 把路径放在 locations
 * 而非 rawInput；多行全命中语义照样作用于回退文本，fail-closed 方向不变）。
 */
export function ruleMatchTarget(
  toolName: string,
  input: unknown,
  fallbackTarget: string | null,
): string | null {
  return extractFullCommand(toolName, input) ?? fallbackTarget;
}
