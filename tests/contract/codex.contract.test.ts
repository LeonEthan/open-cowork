import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import codexDef from '../../src/agent/drivers/codex.driver';
import { defineContractSuite, runSession, writeScript } from './suite';

/**
 * Codex driver 跑共享 contract 用例表（ticket #22）。
 * 接线：executablePath → fake agent harness（codex-jsonrpc 格式，经 bin/fake-codex 包装锁定）。
 */

const FAKE_CODEX = fileURLToPath(new URL('../fake-agent/bin/fake-codex', import.meta.url));

defineContractSuite({
  id: 'codex',
  create: codexDef.create,
  makeParams: (scriptPath) => ({
    executablePath: FAKE_CODEX,
    env: { FAKE_AGENT_SCRIPT: scriptPath },
  }),
});

/**
 * 审批往返的 wire 级断言（ticket #22 票面补充用例）：
 * PermissionDecision → codex JSON-RPC 响应决策串的映射必须正确
 * （allow_once→accept / allow_always→acceptForSession / deny→decline），
 * fake 把收到的回执追加到 FAKE_AGENT_PERMISSION_LOG。
 */
describe('codex 审批往返（wire 级）', () => {
  const cases = [
    { decision: { behavior: 'allow' } as const, expectDecision: 'accept' },
    { decision: { behavior: 'allow', always: true } as const, expectDecision: 'acceptForSession' },
    { decision: { behavior: 'deny', message: '太危险' } as const, expectDecision: 'decline' },
  ];
  for (const c of cases) {
    it(`${c.expectDecision}：决议正确回传 codex JSON-RPC 响应`, async () => {
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
          id: 'codex',
          create: codexDef.create,
          makeParams: (scriptPath) => ({
            executablePath: FAKE_CODEX,
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
      // wire 层断言（fake 收到的 codex 决策串）
      const log = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(log).toHaveLength(1);
      expect(log[0].via).toBe('jsonrpc');
      expect(log[0].response.decision).toBe(c.expectDecision);
    });
  }
});
