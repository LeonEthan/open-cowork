import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, utilityProcess } from 'electron';
import { DB_FILE_NAME, DATA_SUBDIRS, resolveDataDir } from '../shared/paths';
import { openDatabase } from './db/database';
import { registerServices } from './services';

/**
 * main 进程入口：窗口管理 · 全局单一 SQLite · utility process（agent 适配层宿主）生命周期。
 * 业务 IPC 全部走 src/main/services/ 的自动注册扩展点，不在此堆积。
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
  agentProcess.on('exit', (code) => {
    console.error(`[main] agent utility 退出 (code=${code})`);
    agentProcess = null;
  });
}

void app.whenReady().then(() => {
  for (const sub of DATA_SUBDIRS) mkdirSync(join(dataDir, sub), { recursive: true });
  db = openDatabase(join(dataDir, DB_FILE_NAME));

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
  agentProcess?.kill();
  agentProcess = null;
  db?.close();
  db = null;
});
