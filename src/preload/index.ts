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
};

contextBridge.exposeInMainWorld('openCowork', api);
