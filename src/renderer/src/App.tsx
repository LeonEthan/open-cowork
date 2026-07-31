import { useEffect } from 'react';
import { DocumentFlow } from './components/DocumentFlow';
import { Inspector } from './components/Inspector';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { useAgentPort } from './hooks/useAgentPort';
import { useTheme } from './hooks/useTheme';
import { useDataStore } from './stores/data';

export function App(): React.JSX.Element {
  useTheme();
  useAgentPort();

  // ticket #18：启动时从 main 侧 SQLite 拉取 workspace/任务快照（重启恢复）
  const refreshAll = useDataStore((s) => s.refreshAll);
  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // ticket #19：main 侧任务行变更（状态机迁移/session_id/fail_reason）广播 → 重拉快照
  useEffect(() => {
    const api = window.openCowork;
    if (!api) return;
    return api.onTasksChanged(() => {
      void refreshAll();
    });
  }, [refreshAll]);

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <Sidebar />
        <DocumentFlow />
        <Inspector />
      </div>
    </div>
  );
}
