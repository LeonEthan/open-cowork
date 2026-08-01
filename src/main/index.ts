import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, utilityProcess } from 'electron';
import { DB_FILE_NAME, DATA_SUBDIRS, resolveDataDir } from '../shared/paths';
import { createAgentEventDispatcher, recoverInterruptedTasks } from './agentEvents';
import { AGENT_SHUTDOWN_GRACE_MS, raceShutdownAck } from './agentShutdown';
import { createApprovalService } from './approval/service';
import { captureTaskChanges } from './changes/capture';
import { openDatabase } from './db/database';
import type { AgentEvent, PermissionRequestPayload } from '../agent/events';
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
 * - before-quit：先发 shutdown、留宽限期让 utility 逐级 kill 子进程
 *   （ticket #30：等 shutdown-complete 回报或宽限超时取先到者），再杀 utility 本体。
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

/**
 * ticket #20：审批回路中枢（策略引擎 + pending 注册表）。
 * utility 的 permissionHandler 经 permission-ask 询问 → 策略裁决 →
 * 自动档/只读档立即回 driver，或登记 pending 等托盘 IPC（agent:permission-respond）。
 * 终止路径（turn_end/session_ended）经下方消息分派触发 cancelForTask 清账（fail-closed）。
 */
const approvalService = createApprovalService({
  get db() {
    if (!db) throw new Error('db 未就绪');
    return db;
  },
  postToAgent: (msg) => {
    if (!agentProcess) throw new Error('agent 适配层未就绪');
    agentProcess.postMessage(msg);
  },
  broadcastTasksChanged,
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // ticket #33（DESIGN.md §1.1 窗口 chrome 归零）：原生标题栏隐藏，
    // 红绿灯嵌入侧栏顶部安全区（renderer 侧 .traffic-light-safe 预留拖拽/留白）
    titleBarStyle: 'hiddenInset',
    // 与 DESIGN.md §2 token 同源的值（main 进程拿不到 CSS 变量，仅为避免深色主题启动闪白）
    backgroundColor: '#363B40',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      // sandbox 恢复默认开启（audit phase-g）：preload 仅用 contextBridge/ipcRenderer
      // 与 process polyfill 属性，满足沙箱要求；renderer 进程不应整体放弃 Chromium 沙箱。
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
    (
      msg:
        | { type?: string; taskId?: string; event?: AgentEvent; request?: PermissionRequestPayload }
        | null,
    ) => {
      if (msg?.type === 'agent-event' && typeof msg.taskId === 'string' && msg.event) {
        dispatchAgentEvent(msg.taskId, msg.event);
        // ticket #20：轮次/会话终结打断 pending（agent 不再等）——视为取消（fail-closed 清账；
        // 状态迁移由 dispatcher 完成：awaiting_approval → awaiting_review/failed/cancelled 照常）
        if (msg.event.type === 'turn_end' || msg.event.type === 'session_ended') {
          approvalService.cancelForTask(msg.taskId, '轮次结束，待审批请求已取消');
        }
        return;
      }
      // ticket #20：utility permissionHandler 的审批询问（策略引擎裁决）
      if (msg?.type === 'permission-ask' && typeof msg.taskId === 'string' && msg.request) {
        approvalService.handleAsk(msg.taskId, msg.request);
      }
    },
  );
  agentProcess.on('exit', (code) => {
    console.error(`[main] agent utility 退出 (code=${code})`);
    agentProcess = null;
    // utility 崩溃：进行中的会话随进程消失，活跃任务标 failed（UI 呈现原因 + 可重试）
    if (db) {
      // ticket #20：pending 审批清账（fail-closed）先于任务标 failed
      approvalService.cancelAll(`agent 适配层进程退出 (code=${code ?? 'unknown'})`);
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
    approval: approvalService,
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

// ticket #30：before-quit 两阶段——首次触发 preventDefault 进入宽限期，
// 宽限期结束（utility 回报/硬超时先到者）后置位 quitArmed 重新 app.quit() 放行
let quitArmed = false;
let agentShutdownInFlight = false;

app.on('before-quit', (event) => {
  if (quitArmed) return; // 宽限期结束后的真正退出
  const proc = agentProcess;
  if (!proc) {
    db?.close();
    db = null;
    return;
  }
  // 留宽限期让 utility 完成 driver 侧 cancel 链（SIGTERM 升级），再杀 utility 本体；
  // 此前同步立即 kill——cancel 未及发出 SIGTERM 即随进程消失（崩溃场景外的
  // 正常退出也依赖这段宽限，票面证据 5）。
  event.preventDefault();
  if (agentShutdownInFlight) return; // 重复触发（如连按 ⌘Q）：等首个宽限链收尾
  agentShutdownInFlight = true;

  let resolveAck!: () => void;
  const ack = new Promise<void>((r) => {
    resolveAck = r;
  });
  proc.on('message', (msg: { type?: string } | null) => {
    if (msg?.type === 'shutdown-complete') resolveAck();
  });
  proc.once('exit', () => resolveAck()); // utility 已退/先死：不再等
  try {
    proc.postMessage({ type: 'shutdown' });
  } catch {
    resolveAck(); // 进程已退：直接收尾
  }
  void raceShutdownAck(ack, AGENT_SHUTDOWN_GRACE_MS).then(() => {
    quitArmed = true;
    try {
      proc.kill();
    } catch {
      // 已退出：忽略
    }
    if (agentProcess === proc) agentProcess = null;
    db?.close();
    db = null;
    app.quit(); // 第二次 before-quit：quitArmed 已置位，直接放行
  });
});
