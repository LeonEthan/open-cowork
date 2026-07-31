import { contextBridge, ipcRenderer } from 'electron';
import type { CreateTaskInput, OpenCoworkApi, TaskStatus } from '../shared/api';

/**
 * preload：contextIsolation 下的最小桥。
 * MessageChannel 端口转发：main → preload（ipc 'agent-port'）→ window.postMessage（transfer ports），
 * renderer 在 'message' 事件里取 e.ports[0]（见 src/renderer/src/hooks/useAgentPort.ts）。
 */

// main 转交过来的端口立即转发给页面（transfer 语义，preload 不留引用）
ipcRenderer.on('agent-port', (event) => {
  window.postMessage({ type: 'agent-port', source: 'open-cowork-preload' }, '*', [...event.ports]);
});

const api: OpenCoworkApi = {
  requestAgentPort: () => {
    ipcRenderer.send('agent-port-request');
  },
  getDataDir: () => ipcRenderer.invoke('system:get-data-dir') as Promise<string>,
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
  },

  // ── ticket #18：workspace 与任务管理（本地状态） ──────────────
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    pickAndAdd: () => ipcRenderer.invoke('workspaces:pick-and-add'),
    addByPath: (dirPath: string) => ipcRenderer.invoke('workspaces:add-by-path', dirPath),
    remove: (id: string) => ipcRenderer.invoke('workspaces:remove', id),
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (input: CreateTaskInput) => ipcRenderer.invoke('tasks:create', input),
    updateStatus: (id: string, status: TaskStatus) =>
      ipcRenderer.invoke('tasks:update-status', id, status),
  },
  onTasksChanged: (cb: () => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('tasks:changed', listener);
    return () => {
      ipcRenderer.removeListener('tasks:changed', listener);
    };
  },

  // ── ticket #19：agent 会话控制与历史 ─────────────────────────
  agent: {
    start: (taskId: string) => ipcRenderer.invoke('agent:start', taskId),
    followup: (taskId: string, text: string) => ipcRenderer.invoke('agent:followup', taskId, text),
    cancel: (taskId: string) => ipcRenderer.invoke('agent:cancel', taskId),
    history: (taskId: string) => ipcRenderer.invoke('agent:history', taskId),
  },

  // ── ticket #28: 内置终端 tab ─────────────────────────────────────────
  ptyCreate: (key, cols, rows) =>
    ipcRenderer.invoke('pty:create', key, cols, rows) as Promise<{
      ok: boolean;
      cwd: string;
      created: boolean;
    }>,
  ptyWrite: (key, data) => {
    ipcRenderer.send('pty:write', key, data);
  },
  ptyResize: (key, cols, rows) => {
    ipcRenderer.send('pty:resize', key, cols, rows);
  },
  ptyDispose: (key) => {
    ipcRenderer.send('pty:dispose', key);
  },
  onPtyData: (key, cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { key: string; data: string }) => {
      if (payload?.key === key) cb(payload.data);
    };
    ipcRenderer.on('pty:data', listener);
    return () => {
      ipcRenderer.removeListener('pty:data', listener);
    };
  },
  onPtyExit: (key, cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { key: string; exitCode: number }) => {
      if (payload?.key === key) cb(payload.exitCode);
    };
    ipcRenderer.on('pty:exit', listener);
    return () => {
      ipcRenderer.removeListener('pty:exit', listener);
    };
  },
  // ── ticket #28 end ────────────────────────────────────────────────────

  // ── ticket #24：diff 复查与回滚 ───────────────────────────────────────
  changes: {
    list: (taskId: string) => ipcRenderer.invoke('changes:list', taskId),
    accept: (changeId: string) => ipcRenderer.invoke('changes:accept', changeId),
    rollback: (changeId: string) => ipcRenderer.invoke('changes:rollback', changeId),
    restore: (changeId: string) => ipcRenderer.invoke('changes:restore', changeId),
    acceptAll: (taskId: string) => ipcRenderer.invoke('changes:accept-all', taskId),
    rollbackAll: (taskId: string) => ipcRenderer.invoke('changes:rollback-all', taskId),
  },
  // ── ticket #24 end ────────────────────────────────────────────────────
};

contextBridge.exposeInMainWorld('openCowork', api);
