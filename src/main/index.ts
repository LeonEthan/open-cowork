import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, utilityProcess } from 'electron';
import { DB_FILE_NAME, DATA_SUBDIRS, resolveDataDir } from '../shared/paths';
import { createAgentEventDispatcher, recoverInterruptedTasks } from './agentEvents';
import { captureTaskChanges } from './changes/capture';
import { openDatabase } from './db/database';
import type { AgentEvent } from '../agent/events';
import { registerServices } from './services';

/**
 * main 进程入口：窗口管理 · 全局单一 SQLite · utility process（agent 适配层宿主）生命周期。
 * 业务 IPC 全部走 src/main/services/ 的自动注册扩展点，不在此堆积。
 *
 * utility 治理（ticket #19）：
 * - fork 后立即发 {type:'init', dataDir}（JSONL 旁路与二级清扫都依赖它）；
 * - utility → main 的归一事件经 createAgentEventDispatcher 落库 + 状态机迁移；
 * - utility 崩溃：活跃任务（running/awaiting_approval）标 failed（原因可查）；
 *   应用重启时 recoverInterruptedTasks 做同样的两级收尾（ARCHITECTURE §7 可恢复）；
 * - before-quit：先发 shutdown（utility 逐级 kill 子进程），再杀 utility 本体。
 */

let mainWindow: BrowserWindow | null = null;
let agentProcess: Electron.UtilityProcess | null = null;
let db: ReturnType<typeof openDatabase> | null = null;

const dataDir = resolveDataDir();
// OPEN_COWORK_DATA_DIR 的语义是「本实例全部应用数据隔离于此」：
// 除 SQLite/事件/worktrees 外，Electron userData（localStorage、缓存）也一并迁入，
// 否则 e2e/并行实例会经系统默认 userData 互相串扰（如主题与折叠状态泄漏到下一次启动）。
if (process.env.OPEN_COWORK_DATA_DIR) {
  app.setPath('userData', join(dataDir, 'userdata'));
}

function broadcastTasksChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tasks:changed');
  }
}

const dispatchAgentEvent = createAgentEventDispatcher({
  get db() {
    if (!db) throw new Error('db 未就绪');
    return db;
  },
  broadcastTasksChanged,
  // ticket #24：turn_end(completed) → 捕获工作区变更落库（awaiting_review 迁移前）
  onTurnEndCompleted: (taskId) => {
    if (!db) return;
    captureTaskChanges(db, taskId, dataDir);
  },
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // 与 DESIGN.md §2 token 同源的值（main 进程拿不到 CSS 变量，仅为避免深色主题启动闪白）
    backgroundColor: '#363B40',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function forkAgentProcess(): void {
  // utility process：agent 适配层宿主（ARCHITECTURE §1），与 main 同生命周期
  agentProcess = utilityProcess.fork(join(__dirname, './agent.js'), [], {
    serviceName: 'agent-adapter',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // init 握手：dataDir（JSONL 旁路目录 + 二级清扫状态文件位置）
  agentProcess.postMessage({ type: 'init', dataDir });
  agentProcess.on(
    'message',
    (msg: { type?: string; taskId?: string; event?: AgentEvent } | null) => {
      if (msg?.type === 'agent-event' && typeof msg.taskId === 'string' && msg.event) {
        dispatchAgentEvent(msg.taskId, msg.event);
      }
    },
  );
  agentProcess.on('exit', (code) => {
    console.error(`[main] agent utility 退出 (code=${code})`);
    agentProcess = null;
    // utility 崩溃：进行中的会话随进程消失，活跃任务标 failed（UI 呈现原因 + 可重试）
    if (db) {
      recoverInterruptedTasks(db, `agent 适配层进程退出 (code=${code ?? 'unknown'})`);
      broadcastTasksChanged();
    }
  });
}

void app.whenReady().then(() => {
  for (const sub of DATA_SUBDIRS) mkdirSync(join(dataDir, sub), { recursive: true });
  db = openDatabase(join(dataDir, DB_FILE_NAME));
  // 上次运行残留的「进行中」任务：进程已死，会话不可能继续——标 failed（两级清理的持久化侧）
  recoverInterruptedTasks(db, '应用异常退出，会话已终止');

  registerServices({
    ipcMain,
    db,
    dataDir,
    getMainWindow: () => mainWindow,
    getAgentProcess: () => agentProcess,
  });

  forkAgentProcess();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 先让 utility 逐级 kill agent 子进程，再杀 utility 本体（进程注册表第一级）
  try {
    agentProcess?.postMessage({ type: 'shutdown' });
  } catch {
    // 进程已退：忽略
  }
  agentProcess?.kill();
  agentProcess = null;
  db?.close();
  db = null;
});
