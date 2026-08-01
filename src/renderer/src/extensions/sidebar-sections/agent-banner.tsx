import { useEffect } from 'react';
import { useAgentEnvironmentStore } from '../../stores/agentEnvironment';
import { useUiStore } from '../../stores/ui';
import type { SidebarSectionDef } from '../registry';
import '../../styles/agents.css';

/**
 * 「Agent 环境」侧栏横幅（ticket #26，prototype/agent-onboarding 变体 B 融入式定稿）：
 * 有任一 agent 未安装/未认证时显示克制横幅（文案 + 「前往设置」锚点）；
 * 全部健康时不渲染（经 registry 空标题约定，连区块壳都不留）。
 *
 * 数据源 = stores/agentEnvironment.ts（main 探测合并视图：内置四家 + 自定义 ACP）。
 * 口径：!installed → 未安装；installed && authenticated===false → 未认证
 * （未认证是提醒态——#21 provider env 注入也能让 agent 工作，picker 不因此置灰）。
 */
function AgentBannerSection(): React.JSX.Element | null {
  const agents = useAgentEnvironmentStore((s) => s.agents);
  const loaded = useAgentEnvironmentStore((s) => s.loaded);
  const load = useAgentEnvironmentStore((s) => s.load);
  const setView = useUiStore((s) => s.setView);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  if (!loaded) return null;

  const missing = agents.filter((a) => !a.installed);
  const unauthenticated = agents.filter((a) => a.installed && a.authenticated === false);
  if (missing.length === 0 && unauthenticated.length === 0) return null;

  const nameList = (list: typeof agents): string => {
    const names = list.map((a) => a.displayName);
    if (names.length <= 2) return names.join('、');
    return `${names.slice(0, 2).join('、')} 等 ${names.length} 个`;
  };

  const headline =
    missing.length > 0
      ? `${nameList(missing)} 未安装`
      : `${nameList(unauthenticated)} 未认证`;
  const subline =
    missing.length > 0
      ? '部分 agent 不可用，创建任务时不可选。'
      : '未认证的 agent 可能无法启动（任务配置 provider 密钥后可忽略）。';

  return (
    <div className="agent-banner" data-testid="agent-banner" role="status">
      <b>{headline}</b>
      <br />
      {subline}
      <br />
      <button
        type="button"
        className="icon-btn agent-banner-action"
        data-testid="agent-banner-settings"
        onClick={() => setView('settings')}
      >
        前往设置 →
      </button>
    </div>
  );
}

const def: SidebarSectionDef = {
  id: 'agent-banner',
  title: '', // 无标题裸区块（registry #26 约定：健康时不留区块壳）
  order: 1, // 靠前（workspaces=5 / tasks=10 之前）
  component: AgentBannerSection,
};

export default def;
