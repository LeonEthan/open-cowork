import { useEffect, useRef } from 'react';
import { destroySession, getOrCreateSession, readXtermTheme } from './sessions';

/**
 * 终端挂载组件（§1.2 修订：从检查栏 tab 迁为底部抽屉终端体）：
 * - props.sessionKey = taskId 或 'global'；挂载即 attach 会话的持久 DOM 节点，
 *   卸载仅 detach——pty 与 xterm 缓冲保活（会话语义见 ./sessions.ts，一字不动）；
 * - 首次挂载才懒启动 shell（ptyCreate 幂等）；容器尺寸变化（抽屉调高/窗口缩放）
 *   经 ResizeObserver 重新 fit 并同步 pty；
 * - <html data-theme> 切换经 MutationObserver 重读 CSS 变量（§6 瞬间切换）。
 */
export function TerminalHost({ sessionKey }: { sessionKey: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const api = window.openCowork;
    if (!container) return;

    let session = getOrCreateSession(sessionKey);
    if (session.exited) {
      // shell 已退出的会话：重进时丢弃重开
      destroySession(session);
      session = getOrCreateSession(sessionKey);
    }
    container.appendChild(session.hostEl);

    const syncSize = (): void => {
      session.fitAddon.fit();
      if (session.started && !session.exited) {
        api?.ptyResize(sessionKey, session.term.cols, session.term.rows);
      }
    };

    // 主题重读（§6）：attach 即对齐一次——MutationObserver 只覆盖挂载期间的切换，
    // 卸载窗口（如设置视图，附录 B 审计 P2）内的主题变化靠本行兜住
    session.term.options.theme = readXtermTheme();

    // 布局就绪后 fit + 懒启动（会话首次 attach 才起 shell）
    const raf = requestAnimationFrame(() => {
      syncSize();
      if (!session.started && api) {
        session.started = true;
        api.ptyCreate(sessionKey, session.term.cols, session.term.rows).catch((err) => {
          session.started = false; // 下次进入重试
          session.term.writeln(`[终端启动失败] ${String(err)}`);
        });
      }
      session.term.focus();
    });

    // 容器尺寸变化（抽屉调高/窗口缩放）→ 重新 fit 并同步 pty
    const ro = new ResizeObserver(() => syncSize());
    ro.observe(container);

    // 主题切换（<html data-theme>，§6 瞬间切换）→ 重读 CSS 变量
    const mo = new MutationObserver(() => {
      session.term.options.theme = readXtermTheme();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      session.hostEl.remove(); // 仅 detach，会话与 pty 保活
    };
  }, [sessionKey]);

  return (
    <div
      className="terminal-host"
      ref={containerRef}
      data-testid="terminal-host"
      data-session-key={sessionKey}
    />
  );
}
