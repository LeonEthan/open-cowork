import { app } from 'electron';
import { resolveTerminalCwd } from '../pty/cwd';
import { GLOBAL_TERMINAL_KEY, PtySessionManager } from '../pty/sessions';
import type { ServiceContext } from './index';

/**
 * pty 服务（ticket #28 内置终端 tab）：
 * - node-pty 起登录 shell（macOS 默认 /bin/zsh -l，读 SHELL 兜底，见 pty/shell.ts）；
 * - per taskId 各一独立会话（key=taskId；无任务选中时 key='global'）；
 * - IPC：pty:create（invoke，懒启动/复用）· pty:write · pty:resize · pty:dispose ·
 *   pty:list（invoke，ticket #38：存活 key 快照）；
 *   输出经 pty:data / pty:exit 推回渲染端（仅创建会话的那个 webContents）；
 *   ticket #38：会话活性经 pty:session {key, alive} 广播（创建/退出/dispose），
 *   renderer 据此派生检查栏「终端活跃」（DESIGN.md §1.2）。
 * - cwd 由 main 侧按当前任务解析（worktree_path → workspace.path → home，见 pty/cwd.ts）；
 * - 窗口关闭 / 应用退出前全部 pty 清理。
 *
 * 会话本体在 pty/sessions.ts（纯 Node，可单测），本文件只做接线与来源校验。
 */

/** taskId 为 uuid（含连字符），'global' 字面量；拒绝路径字符防注入 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_WRITE_LEN = 1_000_000;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

export default function register(ctx: ServiceContext): void {
  const manager = new PtySessionManager();

  // 与全仓 senderAllowed 惯例同款（usage.ts/agent.ts/changes.ts/approvals.ts）：
  // 仅主窗口渲染端可调。pty:write 是任意字节注入用户登录 shell 的写面，
  // 三个 send 通道与 pty:create 一样必须过这道闸门。
  const senderAllowed = (event: { sender: Electron.WebContents }): boolean => {
    const win = ctx.getMainWindow();
    return !!win && event.sender === win.webContents;
  };

  // 窗口级清理（macOS 关窗不退 app、窗口可经 activate 重建，故按实例 hook 一次）；
  // before-quit 兜底，保证任何退出路径下不残留子进程。
  const hookedWindows = new WeakSet<object>();
  const hookWindowCleanup = (): void => {
    const win = ctx.getMainWindow();
    if (!win || hookedWindows.has(win)) return;
    hookedWindows.add(win);
    win.once('closed', () => manager.disposeAll());
    win.webContents.once('destroyed', () => manager.disposeAll());
  };
  app.on('before-quit', () => manager.disposeAll());

  ctx.ipcMain.handle('pty:create', (event, key: unknown, cols: unknown, rows: unknown) => {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new Error('[pty] 非法会话 key');
    }
    if (!senderAllowed(event)) {
      throw new Error('[pty] 来源非法');
    }
    hookWindowCleanup();
    const wc = event.sender;
    const cwd = resolveTerminalCwd(ctx.db, key === GLOBAL_TERMINAL_KEY ? null : key);
    const result = manager.getOrCreate(
      key,
      { cols: clampInt(cols, 2, 500, 80), rows: clampInt(rows, 1, 200, 24), cwd },
      {
        onData: (data) => {
          if (!wc.isDestroyed()) wc.send('pty:data', { key, data });
        },
        onExit: (exitCode) => {
          if (!wc.isDestroyed()) {
            wc.send('pty:exit', { key, exitCode });
            // ticket #38：shell 退出 = 会话消亡（sessions.ts 同步从 map 删除），广播活性
            wc.send('pty:session', { key, alive: false });
          }
        },
      },
    );
    // ticket #38：新会话诞生广播（复用已有会话 created=false 不广播——活性本就为 true）
    if (result.created && !wc.isDestroyed()) wc.send('pty:session', { key, alive: true });
    return { ok: true as const, cwd: result.cwd, created: result.created };
  });

  // ticket #38：存活会话 key 快照（renderer 启动/重载时播种 liveTerminals）
  ctx.ipcMain.handle('pty:list', (event) => {
    if (!senderAllowed(event)) {
      throw new Error('[pty] 来源非法');
    }
    return manager.keys();
  });

  ctx.ipcMain.on('pty:write', (event, key: unknown, data: unknown) => {
    if (!senderAllowed(event)) return;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return;
    if (typeof data !== 'string' || data.length > MAX_WRITE_LEN) return;
    manager.write(key, data);
  });

  ctx.ipcMain.on('pty:resize', (event, key: unknown, cols: unknown, rows: unknown) => {
    if (!senderAllowed(event)) return;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return;
    manager.resize(key, clampInt(cols, 2, 500, 80), clampInt(rows, 1, 200, 24));
  });

  ctx.ipcMain.on('pty:dispose', (event, key: unknown) => {
    if (!senderAllowed(event)) return;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return;
    manager.dispose(key);
    // ticket #38：dispose 即消亡（无论此前是否存活，幂等广播活性 false）
    if (!event.sender.isDestroyed()) event.sender.send('pty:session', { key, alive: false });
  });
}
