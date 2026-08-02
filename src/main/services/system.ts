import { isAbsolute } from 'node:path';
import { MessageChannelMain, shell } from 'electron';
import type { ServiceContext } from './index';

/**
 * system 服务：应用信息查询 + renderer ⇄ utility MessageChannel 建立。
 * （本文件同时是「如何新增一个服务」的实例，见 services/index.ts 头注释。）
 */
export default function register(ctx: ServiceContext): void {
  ctx.ipcMain.handle('system:get-data-dir', () => ctx.dataDir);

  // renderer 请求与 utility process 建立 MessageChannel 直连：
  // main 只做「接线员」——创建 channel，一端交给 utility，一端交给 renderer，
  // 之后高频事件流（token 级流式输出、工具事件）不再经过 main（ARCHITECTURE §1）。
  ctx.ipcMain.on('agent-port-request', (event) => {
    const agent = ctx.getAgentProcess();
    const win = ctx.getMainWindow();
    if (!agent || !win || event.sender !== win.webContents) {
      console.warn('[services/system] agent-port-request 被拒绝：utility 未就绪或来源非法');
      return;
    }
    const { port1, port2 } = new MessageChannelMain();
    agent.postMessage({ type: 'agent-port' }, [port1]);
    win.webContents.postMessage('agent-port', null, [port2]);
  });

  // ── Codex 对齐（additive）：系统 shell 集成 ──
  // 入参必须是绝对路径字符串；来源仅信任主窗口 webContents。
  const guardAbsolutePath = (event: Electron.IpcMainInvokeEvent, channel: string, p: unknown): string => {
    const win = ctx.getMainWindow();
    if (!win || event.sender !== win.webContents) throw new Error(`${channel} 来源非法`);
    if (typeof p !== 'string' || !isAbsolute(p)) {
      throw new Error(`${channel} 需要绝对路径字符串`);
    }
    return p;
  };

  // 在系统文件管理器中定位（macOS Finder 高亮、Explorer /select:）
  ctx.ipcMain.handle('shell:show-in-folder', (event, path: unknown) => {
    shell.showItemInFolder(guardAbsolutePath(event, 'shell:show-in-folder', path));
  });

  // 以系统默认方式打开（openPath 返回非空字符串表示失败——reject 之让 renderer 弹错误）
  ctx.ipcMain.handle('shell:open-path', async (event, path: unknown) => {
    const result = await shell.openPath(guardAbsolutePath(event, 'shell:open-path', path));
    if (result.length > 0) throw new Error(result);
    return { ok: true as const };
  });
}
