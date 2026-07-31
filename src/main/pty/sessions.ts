import { homedir } from 'node:os';
import { spawn, type IPty } from 'node-pty';
import { resolveLoginShell } from './shell';

/**
 * pty 会话管理（ticket #28 内置终端）：per key（taskId 或 'global'）各一独立 node-pty 会话。
 * 纯 Node 实现、不依赖 Electron——services/pty.ts 只负责 IPC 接线，vitest 可直接测本模块。
 */

/** 无任务选中时的会话 key（与渲染端约定一致） */
export const GLOBAL_TERMINAL_KEY = 'global';

export interface PtySessionSpec {
  cols: number;
  rows: number;
  /** 不传回退 home（调用方通常经 resolveTerminalCwd 解析后传入） */
  cwd?: string;
  /** 测试/排障用：覆盖 shell（默认 resolveLoginShell 登录 shell） */
  shell?: string;
  shellArgs?: string[];
}

export interface PtySessionHooks {
  onData?: (data: string) => void;
  onExit?: (exitCode: number) => void;
}

interface SessionEntry {
  pty: IPty;
  cwd: string;
}

export class PtySessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  size(): number {
    return this.sessions.size;
  }

  /** 已存在则复用（created=false，cwd 保持首次解析值——不把运行中的 shell 挪走） */
  getOrCreate(
    key: string,
    spec: PtySessionSpec,
    hooks: PtySessionHooks = {},
  ): { cwd: string; created: boolean } {
    const existing = this.sessions.get(key);
    if (existing) return { cwd: existing.cwd, created: false };

    const login = resolveLoginShell();
    const file = spec.shell ?? login.file;
    const args = spec.shellArgs ?? login.args;
    const cwd = spec.cwd ?? homedir();

    const pty = spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(2, Math.floor(spec.cols)),
      rows: Math.max(1, Math.floor(spec.rows)),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    pty.onData((data) => hooks.onData?.(data));
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(key);
      hooks.onExit?.(exitCode);
    });
    this.sessions.set(key, { pty, cwd });
    return { cwd, created: true };
  }

  write(key: string, data: string): void {
    const entry = this.sessions.get(key);
    if (!entry) return;
    try {
      entry.pty.write(data);
    } catch {
      // 进程刚退出、句柄竞态：静默丢弃（onExit 会完成清理）
    }
  }

  resize(key: string, cols: number, rows: number): void {
    const entry = this.sessions.get(key);
    if (!entry) return;
    try {
      entry.pty.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)));
    } catch {
      // 同上：退出竞态下 resize 抛 ESRCH，忽略
    }
  }

  dispose(key: string): void {
    const entry = this.sessions.get(key);
    if (!entry) return;
    this.sessions.delete(key);
    try {
      entry.pty.kill();
    } catch {
      // 已退出：无需处理
    }
  }

  disposeAll(): void {
    for (const key of [...this.sessions.keys()]) this.dispose(key);
  }
}
