import { MessageChannelMain } from 'electron';
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
}
