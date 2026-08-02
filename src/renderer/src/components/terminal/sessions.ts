import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/**
 * 终端会话核心（ticket #28 起；§1.2 修订后从检查栏 tab 迁出为底部抽屉的会话底座）：
 * - main 侧 node-pty 起登录 shell（services/pty.ts），xterm.js 渲染；
 * - cwd 跟随当前任务：worktree 任务用 worktree_path，否则 workspace.path，
 *   无选中任务回退 home（解析在 main 侧 pty/cwd.ts，key = currentTaskId ?? 'global'）；
 * - 会话活在 React 组件之外：TerminalHost 卸载只是 detach 持久 DOM 节点，
 *   pty 与 xterm 缓冲都保活，切 tab/隐藏抽屉/切任务重进无损；
 * - 配色禁止硬编码（DESIGN.md §6）：从 CSS 变量实时解析喂给 xterm theme，
 *   <html data-theme> 切换时由 TerminalHost 的 MutationObserver 重读。
 */

/** xterm 会话（活在 React 组件之外：组件卸载只是 detach，缓冲不丢） */
export interface TermSession {
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

/** 全部存活（含 detach 保活中）的 renderer 会话，key=taskId 或 'global' */
export const sessions = new Map<string, TermSession>();

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

export function readXtermTheme(): ITheme {
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

export function destroySession(session: TermSession): void {
  session.disposeBridge();
  session.term.dispose();
  session.hostEl.remove();
  sessions.delete(session.key);
}

export function getOrCreateSession(key: string): TermSession {
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
