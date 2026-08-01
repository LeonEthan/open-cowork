import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WARN_THRESHOLD,
  contextRatio,
  describeTaskUsage,
  describeTaskUsageTitle,
  describeTurnUsage,
  describeTurnUsageTitle,
  formatCost,
  formatTokens,
  shouldWarnContext,
  type UsageTotals,
} from '../src/shared/usageFormat';

/**
 * 展示口径与水位计算测试（ticket #27）——UI 文案唯一事实源锁定：
 * 轮次小字 / 任务 chip / tooltip 标注 / 水位边界（0/50/80/100%）。
 */

describe('formatTokens / formatCost', () => {
  it('token 紧凑格式', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(10_000)).toBe('10.0k');
    expect(formatTokens(999_499)).toBe('999.5k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('金额格式：≥0.01 两位，更小四位，null 不展示', () => {
    expect(formatCost(0.06)).toBe('$0.06');
    // 15.075 的二进制浮点真实值是 15.074999…——toFixed 得 '15.07'（展示口径锁定实际行为）
    expect(formatCost(15.075)).toBe('$15.07');
    expect(formatCost(12.3456)).toBe('$12.35');
    expect(formatCost(0.0012)).toBe('$0.0012');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(null)).toBeNull();
  });
});

describe('轮次小字（describeTurnUsage）', () => {
  const base = { cacheReadTokens: 0, cacheWriteTokens: 0 };

  it('models.dev 折算：token + 金额 + 口径标注', () => {
    expect(
      describeTurnUsage({
        ...base,
        inputTokens: 10_000,
        outputTokens: 2_000,
        costUsd: 0.06,
        pricingSource: 'models.dev',
        pending: false,
      }),
    ).toBe('10.0k in / 2.0k out · $0.06 · models.dev 价');
  });

  it('订阅制：标「仅供参考」不显金额', () => {
    expect(
      describeTurnUsage({
        ...base,
        inputTokens: 10_000,
        outputTokens: 2_000,
        costUsd: null,
        pricingSource: 'subscription',
        pending: false,
      }),
    ).toBe('10.0k in / 2.0k out · 订阅制·费用仅供参考');
  });

  it('无价目：只显 token', () => {
    expect(
      describeTurnUsage({
        ...base,
        inputTokens: 500,
        outputTokens: 120,
        costUsd: null,
        pricingSource: null,
        pending: false,
      }),
    ).toBe('500 in / 120 out');
  });

  it('pending（live 未落库）：只显 token（reconcile 后补口径）', () => {
    expect(
      describeTurnUsage({
        ...base,
        inputTokens: 10_000,
        outputTokens: 2_000,
        costUsd: null,
        pricingSource: null,
        pending: true,
      }),
    ).toBe('10.0k in / 2.0k out');
  });

  it('tooltip：缓存单列 + 折算说明', () => {
    const title = describeTurnUsageTitle({
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 800,
      cacheWriteTokens: 50,
      costUsd: 0.06,
      pricingSource: 'models.dev',
      pending: false,
    });
    expect(title).toContain('输入 10000 · 输出 2000');
    expect(title).toContain('缓存读 800 · 缓存写 50');
    expect(title).toContain('models.dev');
  });
});

describe('任务汇总 chip（describeTaskUsage）', () => {
  const totals = (partial: Partial<UsageTotals>): UsageTotals => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    hasPriced: false,
    hasSubscription: false,
    records: 1,
    ...partial,
  });

  it('models.dev 折算：总量 + 金额', () => {
    expect(
      describeTaskUsage(
        totals({ inputTokens: 10_000, outputTokens: 2_000, costUsd: 0.06, hasPriced: true }),
      ),
    ).toBe('12.0k tokens · $0.06');
  });

  it('订阅制：总量 + 仅供参考标注', () => {
    expect(
      describeTaskUsage(totals({ inputTokens: 10_000, outputTokens: 2_000, hasSubscription: true })),
    ).toBe('12.0k tokens · 订阅·仅供参考');
  });

  it('混合（部分折算 + 部分订阅）：金额与标注同现', () => {
    expect(
      describeTaskUsage(
        totals({
          inputTokens: 20_000,
          outputTokens: 4_000,
          costUsd: 0.12,
          hasPriced: true,
          hasSubscription: true,
        }),
      ),
    ).toBe('24.0k tokens · $0.12 · 订阅·仅供参考');
  });

  it('无价目：只有总量', () => {
    expect(describeTaskUsage(totals({ inputTokens: 800, outputTokens: 199 }))).toBe('999 tokens');
  });

  it('tooltip：口径句齐全', () => {
    const title = describeTaskUsageTitle(
      totals({ costUsd: 0.06, hasPriced: true, hasSubscription: true }),
    );
    expect(title).toContain('缓存不参与折算');
    expect(title).toContain('models.dev API 价');
    expect(title).toContain('仅供参考');
  });
});

describe('context 水位（边界：0/50/80/100%）', () => {
  const WIN = 200_000;

  it('占比计算与钳制', () => {
    expect(contextRatio(0, WIN)).toBe(0); // 0%
    expect(contextRatio(100_000, WIN)).toBe(0.5); // 50%
    expect(contextRatio(160_000, WIN)).toBe(0.8); // 80%
    expect(contextRatio(200_000, WIN)).toBe(1); // 100%
    expect(contextRatio(300_000, WIN)).toBe(1); // 超窗钳制到 1
  });

  it('警告阈值：严格 >80%（恰好 80% 不警告）', () => {
    expect(CONTEXT_WARN_THRESHOLD).toBe(0.8);
    expect(shouldWarnContext(0)).toBe(false);
    expect(shouldWarnContext(0.5)).toBe(false);
    expect(shouldWarnContext(0.8)).toBe(false); // 边界：票面口径是「>80%」
    expect(shouldWarnContext(0.800_001)).toBe(true);
    expect(shouldWarnContext(1)).toBe(true);
  });

  it('退化输入：未知窗口/负值 → 0 不警告', () => {
    expect(contextRatio(1000, 0)).toBe(0);
    expect(contextRatio(1000, Number.NaN)).toBe(0);
    expect(contextRatio(-5, WIN)).toBe(0);
    expect(shouldWarnContext(contextRatio(1000, 0))).toBe(false);
  });
});
