import { useEffect } from 'react';
import { useUiStore } from '../stores/ui';

type AgentPortMessage =
  | { type: 'pong'; at: number }
  | { type: 'counter:tick'; value: number };

/**
 * renderer ⇄ utility 的 MessageChannel 直连（ARCHITECTURE §1：高频事件不过 main）。
 * 流程：window.openCowork.requestAgentPort() → main 建 channel 两端分派 →
 * preload 经 window.postMessage 把端口转交页面 → 本 hook 接管收发。
 * 本票验证：ping/pong + 流式计数（250ms tick，写入 store 供状态栏展示）。
 */
export function useAgentPort(): void {
  const setUtilityPong = useUiStore((s) => s.setUtilityPong);
  const setUtilityTick = useUiStore((s) => s.setUtilityTick);

  useEffect(() => {
    if (!window.openCowork) return; // 纯浏览器环境（vite 单测/预览）下静默降级
    let port: MessagePort | null = null;

    const onWindowMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; source?: string } | null;
      if (data?.type !== 'agent-port' || data.source !== 'open-cowork-preload') return;
      const p = e.ports[0];
      if (!p || port) return;
      port = p;
      port.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as AgentPortMessage | null;
        if (msg?.type === 'pong') setUtilityPong(true);
        if (msg?.type === 'counter:tick') setUtilityTick(msg.value);
      };
      port.start();
      port.postMessage({ type: 'ping' });
      port.postMessage({ type: 'counter:start' });
    };

    window.addEventListener('message', onWindowMessage);
    window.openCowork.requestAgentPort();

    return () => {
      window.removeEventListener('message', onWindowMessage);
      port?.postMessage({ type: 'counter:stop' });
      port?.close();
      port = null;
    };
  }, [setUtilityPong, setUtilityTick]);
}
