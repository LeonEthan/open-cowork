import type { InspectorTabDef } from '../registry';

/**
 * 内置「变更」占位 tab（检查栏扩展示例）。
 * 后续「diff 复查与回滚」票据（PRD §4.3）会用真实实现替换本文件。
 */
function ChangesPlaceholder(): React.JSX.Element {
  return <div className="empty-state">暂无变更。任务完成后，文件改动与 diff 将列在这里。</div>;
}

const def: InspectorTabDef = {
  id: 'changes',
  title: '变更',
  order: 10,
  component: ChangesPlaceholder,
};

export default def;
