import { describe, expect, it } from 'vitest';
import { AGENT_SHUTDOWN_GRACE_MS, raceShutdownAck } from '../src/main/agentShutdown';

/**
 * ticket #30：utility 关停宽限期协调（raceShutdownAck 纯函数，手工时钟注入）。
 * 语义：「utility 回报清理完成 / 宽限超时」取先到者；ack 永不到达由硬超时兜底
 * （不挂死）；ack 先到时清理定时器（不留悬挂句柄）。
 */

function manualClock(): {
  calls: { fn: () => void; ms: number }[];
  cleared: unknown[];
  timers: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
  fire: (index?: number) => void;
} {
  const calls: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  return {
    calls,
    cleared,
    timers: {
      setTimeout: (fn, ms) => {
        calls.push({ fn, ms });
        return calls.length - 1;
      },
      clearTimeout: (h) => {
        cleared.push(h);
      },
    },
    fire: (index = 0) => {
      calls[index].fn();
    },
  };
}

describe('raceShutdownAck（ticket #30 宽限期）', () => {
  it('ack 先到 → "ack"，定时器被清理（不悬挂）', async () => {
    const clock = manualClock();
    let resolveAck!: () => void;
    const ack = new Promise<void>((r) => {
      resolveAck = r;
    });
    const race = raceShutdownAck(ack, 300, clock.timers);
    expect(clock.calls).toHaveLength(1);
    expect(clock.calls[0].ms).toBe(300);
    resolveAck();
    await expect(race).resolves.toBe('ack');
    expect(clock.cleared).toEqual([0]);
  });

  it('ack 永不到达 → 硬超时兜底 "timeout"（退出不挂死）', async () => {
    const clock = manualClock();
    const race = raceShutdownAck(new Promise<void>(() => {}), 300, clock.timers);
    clock.fire();
    await expect(race).resolves.toBe('timeout');
  });

  it('ack 通道 reject（utility 异常）→ 按不再等待处理（"ack"），定时器清理', async () => {
    const clock = manualClock();
    const race = raceShutdownAck(Promise.reject(new Error('utility 已死')), 300, clock.timers);
    await expect(race).resolves.toBe('ack');
    expect(clock.cleared).toHaveLength(1);
  });

  it('默认宽限期 300ms（票面区间 200–500ms）', () => {
    expect(AGENT_SHUTDOWN_GRACE_MS).toBe(300);
  });
});
