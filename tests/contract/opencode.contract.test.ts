import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import opencodeDef from '../../src/agent/drivers/opencode.driver';
import { defineContractSuite, runSession, writeScript } from './suite';

/**
 * opencode driver 跑共享 contract 用例表（ticket #22）。
 * 接线：executablePath → fake agent harness（opencode-sse 格式，经 bin/fake-opencode
 * 包装锁定）；fake 起进程内 HTTP+SSE server（ephemeral 端口，监听行与真实 serve 同形）。
 */

const FAKE_OPENCODE = fileURLToPath(new URL('../fake-agent/bin/fake-opencode', import.meta.url));

defineContractSuite({
  id: 'opencode',
  create: opencodeDef.create,
  makeParams: (scriptPath) => ({
    executablePath: FAKE_OPENCODE,
    env: { FAKE_AGENT_SCRIPT: scriptPath },
  }),
});

/**
 * 审批往返的 wire 级断言（ticket #22 票面补充用例）：
 * PermissionDecision → POST /permission/{id}/reply 的 reply 值映射必须正确
 * （allow_once→once / allow_always→always / deny→reject），
 * fake 把收到的回执追加到 FAKE_AGENT_PERMISSION_LOG。
 */
describe('opencode 审批往返（wire 级）', () => {
  const cases = [
    { decision: { behavior: 'allow' } as const, expectReply: 'once' },
    { decision: { behavior: 'allow', always: true } as const, expectReply: 'always' },
    { decision: { behavior: 'deny', message: '太危险' } as const, expectReply: 'reject' },
  ];
  for (const c of cases) {
    it(`${c.expectReply}：决议正确回传 /permission/{id}/reply`, async () => {
      const logDir = mkdtempSync(join(tmpdir(), 'open-cowork-permlog-'));
      const logFile = join(logDir, 'perm.jsonl');
      const script = writeScript([
        { action: 'expect_stdin' },
        {
          action: 'emit',
          event: {
            kind: 'permission_request',
            id: 'perm_1',
            toolName: 'Bash',
            input: { command: 'rm -rf build' },
            reason: '需要删除构建产物',
          },
        },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(
        {
          id: 'opencode',
          create: opencodeDef.create,
          makeParams: (scriptPath) => ({
            executablePath: FAKE_OPENCODE,
            env: { FAKE_AGENT_SCRIPT: scriptPath, FAKE_AGENT_PERMISSION_LOG: logFile },
          }),
        },
        script,
        { permissionDecision: c.decision },
      );
      expect(end.reason).toBe('completed');
      // 归一层断言（决议回执进事件流）
      const res = collected.byType('permission_response')[0];
      expect(res.decision.behavior).toBe(c.decision.behavior);
      // wire 层断言（fake 收到的 HTTP 回执）
      const log = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(log).toHaveLength(1);
      expect(log[0].via).toBe('http');
      expect(log[0].reply).toBe(c.expectReply);
      if (c.expectReply === 'reject') expect(log[0].message).toBe('太危险');
    });
  }
});
