import { useEffect } from 'react';
import { DocumentFlow } from './components/DocumentFlow';
import { Inspector } from './components/Inspector';
import { Sidebar } from './components/Sidebar';
import { useAgentPort } from './hooks/useAgentPort';
import { useTheme } from './hooks/useTheme';
import { useDataStore } from './stores/data';
import { useUiStore } from './stores/ui';

export function App(): React.JSX.Element {
  useTheme();
  useAgentPort();

  // ticket #18：启动时从 main 侧 SQLite 拉取 workspace/任务快照（重启恢复）
  const refreshAll = useDataStore((s) => s.refreshAll);
  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // ticket #38：pty 会话活性播种 + 订阅（检查栏「终端活跃」数据源，§1.2）
  const setLiveTerminals = useUiStore((s) => s.setLiveTerminals);
  const setTerminalAlive = useUiStore((s) => s.setTerminalAlive);
  useEffect(() => {
    const api = window.openCowork;
    if (!api) return;
    void api.ptyList().then((keys) => setLiveTerminals(keys));
    return api.onPtySession(({ key, alive }) => setTerminalAlive(key, alive));
  }, [setLiveTerminals, setTerminalAlive]);

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
      {/* ticket #33（§1.1）：hiddenInset 红绿灯嵌入侧栏顶部——预留安全留白 + 窗口拖拽区 */}
      <div className="traffic-light-safe" aria-hidden="true" />
      <div className="main">
        <Sidebar />
        <DocumentFlow />
        <Inspector />
      </div>
    </div>
  );
}
