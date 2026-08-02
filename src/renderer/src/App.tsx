import { useEffect } from 'react';
import { DocumentFlow } from './components/DocumentFlow';
import { Inspector } from './components/Inspector';
import { Sidebar } from './components/Sidebar';
import { TerminalDrawer } from './components/TerminalDrawer';
import { useAgentPort } from './hooks/useAgentPort';
import { peekTerminalDrawerVisible } from './hooks/useTerminalDrawerVisible';
import { useTheme } from './hooks/useTheme';
import { useAppStore } from './stores/appStore';
import { useDataStore } from './stores/data';
import { isNavApplying, useUiStore, type NavEntry } from './stores/ui';

export function App(): React.JSX.Element {
  useTheme();
  useAgentPort();
  const view = useUiStore((s) => s.view);

  // ticket #18：启动时从 main 侧 SQLite 拉取 workspace/任务快照（重启恢复）
  const refreshAll = useDataStore((s) => s.refreshAll);
  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // ticket #38：pty 会话活性播种 + 订阅（终端抽屉「上下文活跃」派生数据源，§1.2 修订）
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

  // Codex 对齐改造（附录 B）：前进/后退导航记录器——订阅视图与任务选中变化，
  // 变化非导航应用（goNavBack/goNavForward）所致时将上一条目入后退栈
  useEffect(() => {
    let prev: NavEntry = {
      view: useUiStore.getState().view,
      taskId: useAppStore.getState().currentTaskId,
    };
    const check = (): void => {
      const cur: NavEntry = {
        view: useUiStore.getState().view,
        taskId: useAppStore.getState().currentTaskId,
      };
      if (cur.view === prev.view && cur.taskId === prev.taskId) return;
      // 先推进 prev 再入栈：pushNav 的 set 会同步重入本回调，prev 不先更新
      // 会看到陈旧值反复入栈直至爆栈（probe 实测 Maximum call stack size exceeded）
      const p = prev;
      prev = cur;
      if (!isNavApplying()) useUiStore.getState().pushNav(p);
    };
    const unUi = useUiStore.subscribe(check);
    const unApp = useAppStore.subscribe(check);
    return () => {
      unUi();
      unApp();
    };
  }, []);

  // 全局快捷键 ⌘T：手动唤起/隐藏终端抽屉并记忆偏好（§1.2 修订）。
  // 不受输入焦点守卫：⌘T 无文本编辑语义，且 xterm 隐藏 textarea 常驻焦点——
  // 旧守卫会让键盘被困在终端里关不掉抽屉（附录 B 视觉复核第三轮审计）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 't') return;
      e.preventDefault();
      useUiStore.getState().toggleTerminalDrawer(peekTerminalDrawerVisible());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      {/* ticket #33（§1.1）：hiddenInset 红绿灯嵌入侧栏顶部——预留安全留白 + 窗口拖拽区 */}
      <div className="traffic-light-safe" aria-hidden="true" />
      <div className="main">
        <Sidebar />
        {/* §1.2 修订（附录 B）：中央列 = 上（文档流 + 检查栏横排）+ 下（终端抽屉横贯底部）；
            附录 B 审计 P2：设置视图不渲染抽屉（终端跟随会话上下文；会话保活不受卸载影响） */}
        <div className="center-col">
          <div className="center-row">
            <DocumentFlow />
            <Inspector />
          </div>
          {view !== 'settings' && <TerminalDrawer />}
        </div>
      </div>
    </div>
  );
}
