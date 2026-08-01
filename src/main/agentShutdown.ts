/**
 * ticket #30：utility 关停宽限期协调（纯逻辑，注入时钟便于 vitest）。
 *
 * main before-quit：先发 {type:'shutdown'} → 等 utility 回报清理完成
 * （{type:'shutdown-complete'}）或宽限超时（默认 AGENT_SHUTDOWN_GRACE_MS，
 * 取先到者）→ 再杀 utility 本体。此前实现是 postMessage 后同步立即 kill——
 * driver 侧 cancel 链（SIGTERM→宽限→SIGKILL 升级）未及发出即随 utility 消失。
 *
 * 不引入退出挂死：ack 永不到达（utility 已死/不应答）由定时器硬超时兜底；
 * ack 通道 reject（对端异常）按「不再等待」处理，同样立即放行。
 */

/** 宽限期默认 300ms（票面区间 200–500ms） */
export const AGENT_SHUTDOWN_GRACE_MS = 300;

export interface ShutdownRaceTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const defaultTimers: ShutdownRaceTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
};

/**
 * 「utility 回报清理完成 / 宽限超时」取先到者。
 * 返回 'ack'（回报先到或 ack 通道异常——都不再等待）或 'timeout'（硬超时兜底）。
 * ack 先到时清理定时器（不留悬挂句柄）。
 */
export function raceShutdownAck(
  ack: Promise<unknown>,
  timeoutMs: number = AGENT_SHUTDOWN_GRACE_MS,
  timers: ShutdownRaceTimers = defaultTimers,
): Promise<'ack' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(() => resolve('timeout'), timeoutMs);
    const onAck = (): void => {
      timers.clearTimeout(timer);
      resolve('ack');
    };
    ack.then(onAck, onAck);
  });
}
