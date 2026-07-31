import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import codexDef from '../src/agent/drivers/codex.driver';
import opencodeDef from '../src/agent/drivers/opencode.driver';
import type { AgentDriver, AgentEvent } from '../src/agent/events';

/**
 * 真实 CLI 手动 smoke（ticket #22，不进门禁）：
 * 本机安装的 codex / opencode 经真 driver 各跑一轮真实对话。
 *
 * 运行方式（默认 skip）：
 *   OPEN_COWORK_REAL_SMOKE=1 npx vitest run tests/real-smoke.test.ts
 *
 * 前置：本机 which codex / which opencode 可用且各自凭证已配置
 * （codex 用 ~/.codex 登录态；opencode 用其全局 provider 配置）。
 * 会话均为只读 cwd（mkdtemp 空目录）、prompt 仅要求回一个单词——不产生写操作。
 */

const SMOKE = process.env.OPEN_COWORK_REAL_SMOKE === '1';

async function runRealRound(
  driver: AgentDriver,
  prompt: string,
  timeoutMs: number,
): Promise<{ events: AgentEvent[]; end: { reason: string; error?: string } }> {
  const events: AgentEvent[] = [];
  const session = driver.start(
    {
      taskId: `real-smoke-${driver.id}`,
      prompt,
      cwd: mkdtempSync(join(tmpdir(), 'open-cowork-smoke-')),
      model: null,
      permissionHandler: async () => ({ behavior: 'deny', message: 'smoke 不审批任何写操作' }),
    },
    (e) => events.push(e),
  );
  // 真实 CLI 的 serve/app-server 进程在轮次结束后常驻（per-task 进程模型，与 claude 同）：
  // 先等 turn_end 到达（一轮对话真跑通），再 cancel 收尾会话（顺带覆盖取消路径）。
  await Promise.race([
    new Promise<void>((resolve) => {
      const check = (): void => {
        if (events.some((e) => e.type === 'turn_end')) resolve();
        else setTimeout(check, 50);
      };
      check();
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`真实 smoke 超时（${timeoutMs}ms）`)), timeoutMs),
    ),
  ]);
  await session.cancel();
  const end = await session.done;
  return { events, end };
}

describe.skipIf(!SMOKE)('真实 CLI smoke（OPEN_COWORK_REAL_SMOKE=1 手动跑）', () => {
  it('codex 真实一轮：session_started → text_delta → usage → turn_end(completed)', async () => {
    const { events, end } = await runRealRound(codexDef.create(), 'Reply with exactly one word: ok', 120_000);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session_started');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
    const turnEnd = events.find((e) => e.type === 'turn_end');
    expect(turnEnd && 'status' in turnEnd && turnEnd.status).toBe('completed');
    expect(end.reason).toBe('cancelled');
  }, 130_000);

  it('opencode 真实一轮：session_started → text_delta → usage → turn_end(completed)', async () => {
    const { events, end } = await runRealRound(opencodeDef.create(), 'Reply with exactly one word: ok', 120_000);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session_started');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
    const turnEnd = events.find((e) => e.type === 'turn_end');
    expect(turnEnd && 'status' in turnEnd && turnEnd.status).toBe('completed');
    expect(end.reason).toBe('cancelled');
  }, 130_000);
});
