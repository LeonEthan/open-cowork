import { listDrivers } from './drivers/registry';

/**
 * utility process（agent 适配层宿主）入口（ARCHITECTURE §1）。
 *
 * 本票的职责：接收 main 转交的 MessageChannel 端口，与 renderer 建立直连，
 * 实现 ping/pong + 流式计数 demo，证明高频事件不过 main。
 * 后续票据在此挂 AgentAdapter × N 与进程注册表两级清理。
 *
 * Electron utility process 中通过 process.parentPort 与 main 通信；
 * 类型上各版本定义不一，这里显式收窄为最小结构以避免类型依赖。
 */

interface MinimalPort {
  start: () => void;
  close?: () => void;
  on: (event: 'message', listener: (e: { data: unknown }) => void) => void;
  postMessage: (message: unknown) => void;
}

interface ParentPortLike {
  on: (
    event: 'message',
    listener: (e: { data: unknown; ports: readonly unknown[] }) => void,
  ) => void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

type WireMessage =
  | { type: 'ping' }
  | { type: 'counter:start' }
  | { type: 'counter:stop' };

/** ping/pong + 流式计数 demo：renderer 发 {type:'ping'} 回 pong；counter:start 后每 250ms 推 tick。 */
function wirePort(port: MinimalPort): void {
  let counterTimer: ReturnType<typeof setInterval> | null = null;
  let n = 0;

  port.on('message', ({ data }) => {
    const msg = data as WireMessage | null;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ping':
        port.postMessage({ type: 'pong', at: Date.now() });
        break;
      case 'counter:start':
        if (counterTimer) return;
        counterTimer = setInterval(() => {
          n += 1;
          port.postMessage({ type: 'counter:tick', value: n });
        }, 250);
        break;
      case 'counter:stop':
        if (counterTimer) clearInterval(counterTimer);
        counterTimer = null;
        break;
    }
  });

  port.start();
}

if (!parentPort) {
  console.error('[agent] process.parentPort 不可用——本进程只能由 Electron utilityProcess.fork 启动');
  process.exit(1);
}

parentPort.on('message', (e) => {
  const data = e.data as { type?: string } | null;
  if (data?.type === 'agent-port' && e.ports.length > 0) {
    wirePort(e.ports[0] as MinimalPort);
    console.log('[agent] MessageChannel 端口已接通');
  }
});

const drivers = listDrivers();
console.log(`[agent] utility 已启动 (pid=${process.pid})，已注册 driver: ${drivers.length} 个`);
