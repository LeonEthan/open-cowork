import { useEffect } from 'react';
import type { AgentEvent } from '../../../agent/events';
import { useConversationStore } from '../stores/conversation';
import { useUiStore } from '../stores/ui';

type AgentPortMessage =
  | { type: 'pong'; at: number }
  | { type: 'agent-event'; taskId: string; event: AgentEvent };

/**
 * renderer ⇄ utility 的 MessageChannel 直连（ARCHITECTURE §1：高频事件不过 main）。
 * 流程：window.openCowork.requestAgentPort() → main 建 channel 两端分派 →
 * preload 经 window.postMessage 把端口转交页面 → 本 hook 接管收发。
 * 入向：ping/pong（活性）+ agent-event（归一事件流 → conversation store，rAF 合帧在 store 内）。
 */
export function useAgentPort(): void {
  const setUtilityPong = useUiStore((s) => s.setUtilityPong);
  const applyEvent = useConversationStore((s) => s.applyEvent);

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
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'pong') setUtilityPong(true);
        else if (msg.type === 'agent-event' && typeof msg.taskId === 'string') {
          applyEvent(msg.taskId, msg.event);
        }
      };
      port.start();
      port.postMessage({ type: 'ping' });
    };

    window.addEventListener('message', onWindowMessage);
    window.openCowork.requestAgentPort();

    return () => {
      window.removeEventListener('message', onWindowMessage);
      port?.close();
      port = null;
    };
  }, [setUtilityPong, applyEvent]);
}
