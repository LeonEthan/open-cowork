import { contextRatio, formatTokens, shouldWarnContext } from '../../../shared/usageFormat';
import { useUsageStore } from '../stores/usage';

/**
 * context 水位环（ticket #27，DESIGN.md §4 输入区内嵌元素）：
 * 占用 = 最新一轮 usage 的 inputTokens(+cacheRead) ÷ 该 task model 的 context_length
 * （models.dev 元数据优先，缺则 per-agent 保守默认——main usage/pricing.ts）。
 *
 * 描边只取 token 变量（--border 底环 / --ink-3 正常 / --warning >80%），零硬编码色值；
 * >80% 环变警告色 + 旁侧出现「建议压缩上下文」（仅建议，不做自动压缩）。
 * 动效纪律（§5）：无过渡动画——占用按轮次离散更新，不需要过渡。
 */

const R = 7; // 环半径（18px 视窗内）
const CIRCUMFERENCE = 2 * Math.PI * R;

export function ContextRing({ taskId }: { taskId: string }): React.JSX.Element | null {
  const info = useUsageStore((s) => s.context[taskId]);
  const liveUsed = useUsageStore((s) => s.liveUsed[taskId]);

  if (!info) return null; // 分母未拉到（任务未选中过/桥未就绪）——不渲染占位
  const used = liveUsed ?? info.usedTokens;
  const ratio = contextRatio(used, info.contextWindow);
  const warn = shouldWarnContext(ratio);
  const pct = Math.round(ratio * 100);
  const title = `context 占用 ${formatTokens(used)} / ${formatTokens(info.contextWindow)}（${pct}%）${
    info.source === 'default' ? '\n窗口为保守默认值（无 models.dev 元数据）' : '\n窗口来自 models.dev 元数据'
  }`;

  return (
    <span
      className={`context-ring ${warn ? 'warn' : ''}`}
      data-testid="context-ring"
      data-warn={warn ? 'true' : 'false'}
      title={title}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle className="context-ring-track" cx="9" cy="9" r={R} fill="none" strokeWidth="2" />
        <circle
          className="context-ring-value"
          cx="9"
          cy="9"
          r={R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(ratio * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      {warn && (
        <span className="context-ring-hint" data-testid="context-ring-warning">
          建议压缩上下文
        </span>
      )}
    </span>
  );
}
