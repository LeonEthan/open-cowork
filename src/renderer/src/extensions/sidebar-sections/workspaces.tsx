import { useDataStore } from '../../stores/data';
import type { SidebarSectionDef } from '../registry';

/**
 * 「Workspace」侧栏区块（ticket #18）：本地目录 workspace 的列表与增删。
 * 添加走原生目录选择 dialog（main 侧 workspaces 服务）；移除会级联删除其下任务。
 * 视觉克制（§1/§7）：仅文字与边框按钮，无装饰。
 */
function WorkspacesSection(): React.JSX.Element {
  const workspaces = useDataStore((s) => s.workspaces);
  const addWorkspaceViaDialog = useDataStore((s) => s.addWorkspaceViaDialog);
  const removeWorkspace = useDataStore((s) => s.removeWorkspace);

  return (
    <div className="ws-section">
      {workspaces.length === 0 ? (
        <div className="empty-state">尚未添加 workspace</div>
      ) : (
        <ul className="ws-list">
          {workspaces.map((w) => (
            <li key={w.id} className="ws-item" data-testid="workspace-item">
              <span className="ws-text">
                <span className="ws-name">{w.name}</span>
                <span className="ws-path" title={w.path}>
                  {w.path}
                </span>
              </span>
              <button
                type="button"
                className="icon-btn ws-remove"
                data-testid="workspace-remove"
                title={`移除 workspace「${w.name}」（其下任务一并删除）`}
                onClick={() => void removeWorkspace(w.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="icon-btn"
        data-testid="add-workspace"
        onClick={() => void addWorkspaceViaDialog()}
      >
        添加 Workspace…
      </button>
    </div>
  );
}

const def: SidebarSectionDef = {
  id: 'workspaces',
  title: 'Workspace',
  order: 5,
  component: WorkspacesSection,
};

export default def;
