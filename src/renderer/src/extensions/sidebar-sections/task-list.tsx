import type { SidebarSectionDef } from '../registry';

/**
 * 内置「任务」侧栏区块（任务侧栏扩展示例）。
 * 后续任务票据会替换为真实列表（状态点 + 标题 + 元信息，DESIGN.md §1）。
 */
function TaskListSection(): React.JSX.Element {
  return <div className="empty-state">暂无任务</div>;
}

const def: SidebarSectionDef = {
  id: 'tasks',
  title: '任务',
  order: 10,
  component: TaskListSection,
};

export default def;
