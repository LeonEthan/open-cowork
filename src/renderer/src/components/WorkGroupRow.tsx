import { useEffect, useState } from 'react';
import { aggregateOf, fmtDurationMs } from '../lib/turnGroups';
import type { ConversationItem } from '../stores/conversation';

/**
 * 按轮工作摘要行（Codex 对齐改造，DESIGN.md 附录 B）：
 * 一轮的工具/思考/审批行折叠进 details——摘要行 = 状态点（仅活跃轮，§5 pulse）
 * + 「工作中 24m 15s」（活跃，秒级跳动）/「已工作 4m 44s」（完成）+ 尾注 diffstat；
 * 展开体内首行为聚合小字（编辑 N 文件 · 运行 M 命令 · 读取 K 文件），其下各行原序。
 * 默认全部展开（有意偏离 Codex 的完成轮默认折叠——复查信息密度优先，附录 B）；
 * 用户手动折叠不被重渲染重置（React 仅在 prop 变化时写 DOM，open 恒 true 不回踩）。
 */
export function WorkGroupRow(props: {
  active: boolean;
  /** 活跃轮计时起点（ms epoch）；null = 无计时锚点（只显「工作中」） */
  startedAt: number | null;
  /** 完成轮时长（ms）；null = 无时长数据 */
  durationMs: number | null;
  /** 任务级 diffstat（仅末轮/活跃轮尾注） */
  diffstat: { files: number; adds: number; dels: number } | null;
  work: ConversationItem[];
  children: React.ReactNode;
}): React.JSX.Element {
  const { active, startedAt, durationMs, diffstat } = props;
  const [now, setNow] = useState(() => Date.now());

  // 活跃轮秒级跳动（§5 未禁计时文本更新；非动画）
  useEffect(() => {
    if (!active || startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, startedAt]);

  const elapsed = active && startedAt !== null ? now - startedAt : durationMs;
  const statText =
    diffstat && diffstat.files > 0
      ? ` · ${diffstat.files} 个文件 +${diffstat.adds} −${diffstat.dels}`
      : '';
  const aggregate = aggregateOf(props.work);

  return (
    <details className="workgroup" data-testid="workgroup" data-active={active} open>
      <summary className="workgroup-summary" data-testid="workgroup-summary">
        {active && <span className="status-dot running" aria-hidden />}
        {active ? '工作中' : '已工作'}
        {elapsed !== null ? ` ${fmtDurationMs(elapsed)}` : ''}
        {statText && <span className="workgroup-stat">{statText}</span>}
      </summary>
      <div className="workgroup-body">
        {aggregate && <p className="workgroup-aggregate">{aggregate}</p>}
        {props.children}
      </div>
    </details>
  );
}
