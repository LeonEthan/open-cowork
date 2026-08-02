/**
 * 用量展示与折算口径（ticket #27）——main / renderer 共用的纯函数模块。
 *
 * 红线：本文件零运行时依赖（不 import 任何 node / electron / db 模块），
 * renderer 打包与 vitest 都可直接用；展示口径由此文件唯一锁定（vitest 表驱动）。
 *
 * 口径约定（与 entities.ts UsageRecord 注释一致）：
 * - cost_usd 按 models.dev API 价折算（input/output token 单价，USD / 1M tokens）；
 * - 缓存 token（cache_read/cache_write）不参与折算——models.dev 快照无缓存价目，
 *   缓存量只在 tooltip 单列；
 * - 订阅制（task 未挂 provider，走 agent 自带登录态如 Claude/ChatGPT 订阅 OAuth）
 *   不折算金额：cost_usd = NULL、pricing_source = 'subscription'，展示标「仅供参考」；
 * - 有 provider 但 models.dev 无该模型价目：cost_usd = NULL、pricing_source = NULL，
 *   展示只给 token 数。
 */

/** 折算来源（与 usage_records.pricing_source 同形；null = 无价目未折算） */
export type PricingSource = 'models.dev' | 'subscription' | null;

// ── token / 金额格式化 ─────────────────────────────────────────────────────

/** token 紧凑格式化：999 → "999"；10_000 → "10.0k"；1_500_000 → "1.5M" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 美元金额格式化：0 → $0.00；≥0.01 两位（$0.06）；更小四位（$0.0012）；null → null（不展示） */
export function formatCost(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd === 0) return '$0.00';
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

// ── 轮次小字（文档流每轮末尾一行灰字） ──────────────────────────────────────

/** 一轮用量的展示输入（live 事件 pending=true；落库记录 pending=false） */
export interface TurnUsageLine {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  pricingSource: PricingSource;
  /** true = 实时事件尚未落库折算（只显 token，reconcile 后补金额/口径） */
  pending: boolean;
}

/** 轮次小字正文（口径标注齐全：折算价来源 / 订阅制「仅供参考」） */
export function describeTurnUsage(u: TurnUsageLine): string {
  const base = `${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out`;
  if (u.pending) return base;
  if (u.pricingSource === 'subscription') return `${base} · 订阅制·费用仅供参考`;
  const cost = formatCost(u.costUsd);
  if (cost !== null) return `${base} · ${cost} · models.dev 价`;
  return base; // 无价目：只显 token
}

/** 轮次小字 tooltip（缓存 token 单列的完整口径） */
export function describeTurnUsageTitle(u: TurnUsageLine): string {
  const parts = [
    `输入 ${u.inputTokens} · 输出 ${u.outputTokens}`,
    `缓存读 ${u.cacheReadTokens} · 缓存写 ${u.cacheWriteTokens}（缓存不参与折算）`,
  ];
  if (u.pricingSource === 'subscription') parts.push('订阅制用量，费用仅供参考');
  else if (u.costUsd !== null) parts.push('金额按 models.dev API 价折算');
  else parts.push('无 models.dev 价目，未折算金额');
  return parts.join('\n');
}

// ── 任务级汇总 chip（侧栏任务项） ──────────────────────────────────────────

/** 任务聚合（main SQL 产出；costUsd = 各记录非 NULL cost 之和） */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 已折算记录的 cost_usd 之和；一条都没有为 null */
  costUsd: number | null;
  /** 存在 models.dev 折算记录 */
  hasPriced: boolean;
  /** 存在订阅制记录（金额口径「仅供参考」） */
  hasSubscription: boolean;
  /** 记录条数（0 = 从未有用量，UI 不显 chip） */
  records: number;
}

/** 汇总 chip 正文（灰阶小字；口径全在 tooltip，正文保持紧凑） */
export function describeTaskUsage(t: UsageTotals): string {
  let text = `${formatTokens(t.inputTokens + t.outputTokens)} tokens`;
  if (t.hasPriced) {
    const cost = formatCost(t.costUsd);
    if (cost !== null) text += ` · ${cost}`;
  }
  if (t.hasSubscription) text += ' · 订阅·仅供参考';
  return text;
}

/** 汇总 chip 短正文（侧栏 title 行右端用，Codex「2h ago」位）：仅 token 量（省单位
 *  省横向空间，240px 侧栏里 tokens 一词值 ~50px）+ 折算金额；订阅标注归 tooltip */
export function describeTaskUsageShort(t: UsageTotals): string {
  let text = formatTokens(t.inputTokens + t.outputTokens);
  if (t.hasPriced) {
    const cost = formatCost(t.costUsd);
    if (cost !== null) text += ` · ${cost}`;
  }
  return text;
}

/** 汇总 chip tooltip（完整口径：缓存量 + 折算说明） */
export function describeTaskUsageTitle(t: UsageTotals): string {
  const parts = [
    `输入 ${t.inputTokens} · 输出 ${t.outputTokens}`,
    `缓存读 ${t.cacheReadTokens} · 缓存写 ${t.cacheWriteTokens}（缓存不参与折算）`,
  ];
  if (t.hasPriced) parts.push('金额按 models.dev API 价折算');
  if (t.hasSubscription) parts.push('含订阅制用量，费用仅供参考');
  if (!t.hasPriced && !t.hasSubscription) parts.push('无 models.dev 价目，未折算金额');
  return parts.join('\n');
}

// ── context 水位（输入区水位环） ────────────────────────────────────────────

/** 水位占比（0..1；window<=0 视为未知 → 0，不误导） */
export function contextRatio(usedTokens: number, contextWindow: number): number {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.min(1, usedTokens / contextWindow);
}

/** 警告阈值：>80% 出现警告与压缩建议（恰好 80% 不警告，票面口径） */
export const CONTEXT_WARN_THRESHOLD = 0.8;

export function shouldWarnContext(ratio: number): boolean {
  return ratio > CONTEXT_WARN_THRESHOLD;
}
