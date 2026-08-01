import { useEffect } from 'react';
import { useAgentsStore } from '../../stores/agents';

/**
 * AgentPicker（ticket #22）：任务创建表单的 agent 选择器。
 * 数据源 = main 探测结果（services/agentDetect.ts 经 stores/agents.ts）：
 * - 已安装且 driver 已接入 → 可选；
 * - 未安装 → 置灰，标注「未安装」；
 * - driver 未接入 → 一律置灰，标注「即将支持」（即使二进制存在）。
 *
 * ticket #23：pi driver 已接入（降级审批）——pi 项不再是「即将支持」，
 * 与其他三家同走「探测到即可选」逻辑（driverAvailable 翻转在 agentDetect.ts，本组件无需分支）。
 *
 * 样式复用 .task-form 的 field/select（§4 边框分层），不新增视觉元素。
 * data-testid="task-agent-select" 与占位 select 保持一致（e2e 兼容面）。
 */
export function AgentPicker(props: {
  value: string;
  onChange: (agentId: string) => void;
}): React.JSX.Element {
  const agents = useAgentsStore((s) => s.agents);
  const loaded = useAgentsStore((s) => s.loaded);
  const load = useAgentsStore((s) => s.load);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const selectable = (a: { installed: boolean; driverAvailable: boolean }): boolean =>
    a.installed && a.driverAvailable;

  // 探测完成后回填：当前值不可选（空/未安装/未接入）时选第一个可用 agent
  useEffect(() => {
    if (!loaded) return;
    const current = agents.find((a) => a.id === props.value);
    if (current && selectable(current)) return;
    const first = agents.find(selectable);
    if (first && first.id !== props.value) props.onChange(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, agents, props.value]);

  return (
    <label className="field">
      <span className="field-label">Agent</span>
      <select
        data-testid="task-agent-select"
        value={props.value}
        disabled={!loaded}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {!loaded && <option value="">探测中…</option>}
        {loaded &&
          agents.map((a) => (
            <option key={a.id} value={a.id} disabled={!selectable(a)} data-agent-id={a.id}>
              {a.displayName}
              {!a.driverAvailable ? '（即将支持）' : !a.installed ? '（未安装）' : ''}
            </option>
          ))}
      </select>
    </label>
  );
}
