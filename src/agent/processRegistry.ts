import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 进程注册表 + 两级清理（ticket #19，ARCHITECTURE §2「进程注册表两级清理防泄漏」）。
 *
 * 第一级（运行时）：utility 进程内 Map——session/子进程逐项登记；
 *   取消、任务删除、app quit 时经 killAll/kill 逐级终止。
 * 第二级（启动时）：上次运行若崩溃可能留下孤儿 agent 子进程——utility 启动时
 *   调 sweepStale() 读状态文件，杀掉仍在跑的残留 pid 并清空文件。
 *
 * 纯 Node 实现，不依赖 Electron——vitest 直接测。
 */

export interface RegisteredProcess {
  /** 终止该会话底层进程（driver 提供，通常 = AbortController abort + kill） */
  kill: () => void;
  /** 已知子进程 pid（能拿到就登记，供二级清扫） */
  pids?: number[];
}

interface StaleEntry {
  pid: number;
  taskId: string;
  at: number;
}

export class ProcessRegistry {
  private readonly sessions = new Map<string, RegisteredProcess>();
  private readonly stateFile: string | null;

  /**
   * @param stateFile 二级清扫状态文件路径（如 <dataDir>/events/agent-processes.json）；
   *                  null = 不写文件（测试用）。
   */
  constructor(stateFile: string | null = null) {
    this.stateFile = stateFile;
  }

  size(): number {
    return this.sessions.size;
  }

  has(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  /** 登记会话；同 taskId 重复登记时先杀旧会话（Task 与 session 1:1） */
  register(taskId: string, entry: RegisteredProcess): void {
    if (this.sessions.has(taskId)) this.kill(taskId);
    this.sessions.set(taskId, entry);
    this.persist();
  }

  unregister(taskId: string): void {
    if (!this.sessions.delete(taskId)) return;
    this.persist();
  }

  /** 终止指定会话（幂等；kill 回调抛错不传播——清理路径不 fail） */
  kill(taskId: string): void {
    const entry = this.sessions.get(taskId);
    if (!entry) return;
    this.sessions.delete(taskId);
    try {
      entry.kill();
    } catch {
      // 进程刚退出等竞态：忽略
    }
    this.persist();
  }

  /** app quit / utility shutdown：全部终止 */
  killAll(): void {
    for (const taskId of [...this.sessions.keys()]) this.kill(taskId);
  }

  /** 当前登记的 pid 全集（测试断言用） */
  registeredPids(): number[] {
    return [...this.sessions.values()].flatMap((e) => e.pids ?? []);
  }

  /**
   * 第二级清理：杀掉上次运行残留的 agent 子进程。
   * 读状态文件 → 逐个 pid 探测存活 → 存活者 SIGTERM（宽限后 SIGKILL 由调用方按需再做；
   * 这里只做一轮 SIGTERM，agent CLI 收到即退）。返回清理的条目数。
   */
  sweepStale(now: number = Date.now()): number {
    if (!this.stateFile || !existsSync(this.stateFile)) return 0;
    let entries: StaleEntry[] = [];
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as unknown;
      if (Array.isArray(raw)) entries = raw as StaleEntry[];
    } catch {
      // 状态文件损坏：直接清空重建
    }
    let swept = 0;
    for (const e of entries) {
      if (typeof e?.pid !== 'number') continue;
      if (pidAlive(e.pid)) {
        try {
          process.kill(e.pid, 'SIGTERM');
          swept += 1;
        } catch {
          // ESRCH/EPERM：已退出或无权——都不阻塞启动
        }
      }
    }
    void now;
    this.persist(); // 清空（当前运行尚未登记任何会话时为空数组）
    return swept;
  }

  /** 状态文件落盘（崩溃时留给下一次启动做二级清扫） */
  private persist(): void {
    if (!this.stateFile) return;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const entries: StaleEntry[] = [];
      for (const [taskId, e] of this.sessions) {
        for (const pid of e.pids ?? []) entries.push({ pid, taskId, at: Date.now() });
      }
      writeFileSync(this.stateFile, JSON.stringify(entries), 'utf8');
    } catch {
      // 落盘失败不阻塞主流程（下次启动只是少清一轮）
    }
  }
}

/** pid 是否存活（signal 0 探测） */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
