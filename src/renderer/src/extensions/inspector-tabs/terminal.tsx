import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import { TERMINAL_GLOBAL_KEY } from '../../../../shared/terminal';
import type { InspectorTabDef } from '../registry';

/**
 * 内置终端 tab（ticket #28）：
 * - main 侧 node-pty 起登录 shell（services/pty.ts），xterm.js 渲染；
 * - cwd 跟随当前任务：worktree 任务用 worktree_path，否则 workspace.path，
 *   无选中任务回退 home（解析在 main 侧 pty/cwd.ts，key = currentTaskId ?? 'global'）；
 * - tab 首次打开才起 shell（懒启动）；per taskId 会话独立——切 tab/切任务只是
 *   detach 持久 DOM 节点，pty 与 xterm 缓冲都保活，切回无损；
 * - 配色禁止硬编码（DESIGN.md §6）：从 CSS 变量实时解析喂给 xterm theme，
 *   <html data-theme> 切换时重读。
 */

/** xterm 会话（活在 React 组件之外：tab 卸载只是 detach，缓冲不丢） */
interface TermSession {
  key: string;
  term: Terminal;
  fitAddon: FitAddon;
  /** xterm 挂载的持久 DOM 节点 */
  hostEl: HTMLDivElement;
  /** 已发起 ptyCreate（幂等防重，StrictMode 双挂载/快速切换安全） */
  started: boolean;
  /** shell 已退出（重进时重开新会话） */
  exited: boolean;
  disposeBridge: () => void;
}

const sessions = new Map<string, TermSession>();

/**
 * 从 CSS 变量解析具体颜色。getPropertyValue 对 color-mix() 派生 token
 * （--selection / --border 等）返回未解析原文，xterm 只认具体颜色，
 * 故经探针元素取计算后的 rgb()。
 */
function resolveCssColor(varName: string): string | undefined {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = `var(${varName})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value || undefined;
}

function readXtermTheme(): ITheme {
  const background = resolveCssColor('--bg');
  return {
    background,
    foreground: resolveCssColor('--ink'),
    cursor: resolveCssColor('--accent'),
    cursorAccent: background,
    selectionBackground: resolveCssColor('--selection'),
  };
}

function readMonoFont(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return v || 'monospace';
}

function destroySession(session: TermSession): void {
  session.disposeBridge();
  session.term.dispose();
  session.hostEl.remove();
  sessions.delete(session.key);
}

function getOrCreateSession(key: string): TermSession {
  const existing = sessions.get(key);
  if (existing) return existing;

  const hostEl = document.createElement('div');
  hostEl.className = 'terminal-xterm-holder';
  const term = new Terminal({
    fontFamily: readMonoFont(),
    fontSize: 13,
    cursorBlink: true, // §5 允许的光标 blink
    theme: readXtermTheme(),
    scrollback: 2000, // 定位「随手验证」，缓冲克制
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(hostEl);

  const session: TermSession = {
    key,
    term,
    fitAddon,
    hostEl,
    started: false,
    exited: false,
    disposeBridge: () => {},
  };

  const api = window.openCowork;
  const unsubs: Array<() => void> = [];
  if (api) {
    // 输出订阅挂在会话级（不随组件卸载），detach 期间输出持续进缓冲
    unsubs.push(api.onPtyData(key, (data) => term.write(data)));
    unsubs.push(
      api.onPtyExit(key, (code) => {
        session.exited = true;
        term.writeln('');
        term.writeln(`[shell 已退出 (code=${code})]`);
      }),
    );
  }
  term.onData((data) => {
    if (session.started && !session.exited) api?.ptyWrite(key, data);
  });
  session.disposeBridge = () => {
    for (const u of unsubs) u();
  };
  sessions.set(key, session);
  return session;
}

function TerminalTab(): React.JSX.Element {
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const key = currentTaskId ?? TERMINAL_GLOBAL_KEY;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const api = window.openCowork;
    if (!container) return;

    let session = getOrCreateSession(key);
    if (session.exited) {
      // shell 已退出的会话：重进时丢弃重开
      destroySession(session);
      session = getOrCreateSession(key);
    }
    container.appendChild(session.hostEl);

    const syncSize = (): void => {
      session.fitAddon.fit();
      if (session.started && !session.exited) {
        api?.ptyResize(key, session.term.cols, session.term.rows);
      }
    };

    // 布局就绪后 fit + 懒启动（tab 首次打开才起 shell）
    const raf = requestAnimationFrame(() => {
      syncSize();
      if (!session.started && api) {
        session.started = true;
        api.ptyCreate(key, session.term.cols, session.term.rows).catch((err) => {
          session.started = false; // 下次进入重试
          session.term.writeln(`[终端启动失败] ${String(err)}`);
        });
      }
      session.term.focus();
    });

    // 容器尺寸变化（检查栏折叠/窗口缩放）→ 重新 fit 并同步 pty
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
  }, [key]);

  return (
    <div
      className="terminal-host"
      ref={containerRef}
      data-testid="terminal-host"
      data-session-key={key}
    />
  );
}

const def: InspectorTabDef = {
  id: 'terminal',
  title: '终端',
  order: 30, // §1 顺序：变更(20，#24) / 终端(30)；文件复查并入变更 tab（DESIGN.md §1 合并决议）
  component: TerminalTab,
};

export default def;
