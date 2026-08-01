import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessRegistry, pidAlive } from '../src/agent/processRegistry';

/**
 * 进程注册表（ticket #19 进程治理）：运行时 Map 的登记/终止语义 +
 * 启动时 sweepStale 二级清理（真实起子进程验证 pid 探测与终止）。
 */

describe('ProcessRegistry 运行时（第一级）', () => {
  it('register/kill/killAll/unregister 语义', () => {
    const reg = new ProcessRegistry(null);
    let killedA = 0;
    let killedB = 0;
    reg.register('a', { kill: () => (killedA += 1) });
    reg.register('b', { kill: () => (killedB += 1) });
    expect(reg.size()).toBe(2);

    reg.kill('a');
    expect(killedA).toBe(1);
    expect(reg.has('a')).toBe(false);
    reg.kill('a'); // 幂等
    expect(killedA).toBe(1);

    reg.killAll();
    expect(killedB).toBe(1);
    expect(reg.size()).toBe(0);
  });

  it('同 taskId 重复登记先杀旧会话（Task 与 session 1:1）', () => {
    const reg = new ProcessRegistry(null);
    let first = 0;
    let second = 0;
    reg.register('t', { kill: () => (first += 1) });
    reg.register('t', { kill: () => (second += 1) });
    expect(first).toBe(1);
    reg.kill('t');
    expect(second).toBe(1);
  });

  it('kill 回调抛错不传播（清理路径不 fail）', () => {
    const reg = new ProcessRegistry(null);
    reg.register('x', {
      kill: () => {
        throw new Error('boom');
      },
    });
    expect(() => reg.kill('x')).not.toThrow();
    expect(reg.size()).toBe(0);
  });

  it('状态文件随登记/注销落盘（供二级清扫）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-reg-'));
    const file = join(dir, 'agent-processes.json');
    const reg = new ProcessRegistry(file);
    reg.register('t1', { kill: () => {}, pids: [424242] });
    const entries = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; taskId: string }[];
    expect(entries).toEqual([{ pid: 424242, taskId: 't1', at: expect.any(Number) }]);
    reg.unregister('t1');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });
});

describe('ProcessRegistry 二级清理（sweepStale）', () => {
  it('状态文件不存在/损坏 → 0，不抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-reg-'));
    const missing = new ProcessRegistry(join(dir, 'missing.json'));
    expect(missing.sweepStale()).toBe(0);
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{oops', 'utf8');
    const reg = new ProcessRegistry(broken);
    expect(reg.sweepStale()).toBe(0);
  });

  it('死 pid 不动，活 pid 被杀并清空文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-reg-'));
    const file = join(dir, 'agent-processes.json');
    // 活 pid：当前进程自己（signal 0 必活；sweep 会对其 SIGTERM——换成 spawn 一个 sleep 子进程更安全）
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const child = spawn('sleep', ['30']);
    expect(child.pid).toBeGreaterThan(0);
    const livePid = child.pid!;
    writeFileSync(
      file,
      JSON.stringify([
        { pid: livePid, taskId: 'live', at: 1 },
        { pid: 999999, taskId: 'dead', at: 1 }, // 几乎不可能存在的 pid
      ]),
      'utf8',
    );
    const reg = new ProcessRegistry(file);
    const swept = reg.sweepStale();
    expect(swept).toBe(1); // 只有活 pid 被处理
    // sleep 收到 SIGTERM 后退出
    return new Promise<void>((resolve) => {
      child.on('exit', () => {
        expect(pidAlive(livePid)).toBe(false);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
        resolve();
      });
    });
  });

  /**
   * ticket #30 崩溃链实证（第二级清理修复的端到端）：
   * register 带 pids → persist 的状态文件含 pid → 模拟崩溃（不调 unregister/killAll，
   * 直接弃 registry——状态文件保留 pid 登记）→ 新实例 sweepStale 把登记的 pid 清掉。
   * 真实 spawn sleep 30 子进程实证；finally 兜底保证不泄漏测试进程。
   */
  it('崩溃链：register(pids) → 文件含 pid → 弃 registry → sweepStale 杀活进程并清空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-reg-'));
    const file = join(dir, 'agent-processes.json');
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const child = spawn('sleep', ['30']);
    expect(child.pid).toBeGreaterThan(0);
    const livePid = child.pid!;
    try {
      // 运行态登记：pids 随 register 落盘（修复前 register 从不传 pids → 文件恒空 → sweep 恒 no-op）
      const reg = new ProcessRegistry(file);
      reg.register('task-crash', { kill: () => {}, pids: [livePid] });
      expect(reg.registeredPids()).toEqual([livePid]);
      const entries = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; taskId: string }[];
      expect(entries).toEqual([{ pid: livePid, taskId: 'task-crash', at: expect.any(Number) }]);

      // 模拟崩溃：弃 registry（不 unregister 不 killAll）→ 状态文件保留登记
      // 先挂 exit 监听再 sweep，防同 tick 竞态漏收
      const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
      // 下次启动：新实例读状态文件做二级清扫
      const next = new ProcessRegistry(file);
      expect(next.sweepStale()).toBe(1);
      await exited;
      expect(pidAlive(livePid)).toBe(false);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
    } finally {
      if (pidAlive(livePid)) {
        try {
          process.kill(livePid, 'SIGKILL');
        } catch {
          // 已退出
        }
      }
    }
  });
});

describe('pidAlive', () => {
  it('当前进程存活；不可能的大 pid 不存活', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999999)).toBe(false);
  });
});
