import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAcpDriver } from '../../src/agent/drivers/acp.driver';
import { defineContractSuite, runSession, writeScript } from './suite';

/**
 * 通用 ACP driver（ticket #26）跑共享 contract 用例表。
 * 接线：注册 spec（command → fake harness 的 fake-acp 包装，锁定 acp-jsonrpc wire 格式），
 * 脚本路径经任务 env（DriverStartParams.env）注入——与真实自定义 agent 的
 * 「注册 env < 任务 env」合并序一致。
 */

const FAKE_ACP = fileURLToPath(new URL('../fake-agent/bin/fake-acp', import.meta.url));

const harness = {
  id: 'acp',
  create: () =>
    createAcpDriver({ id: 'custom:contract', displayName: 'fake ACP agent', command: FAKE_ACP, args: [] }),
  makeParams: (scriptPath: string) => ({
    env: { FAKE_AGENT_SCRIPT: scriptPath },
  }),
};

defineContractSuite(harness);

/**
 * 审批往返的 wire 级断言（ticket #26 票面补充用例）：
 * PermissionDecision → ACP session/request_permission 响应 outcome 的映射必须正确
 * （allow_once→selected 'allow' / allow_always→selected 'always' / deny→selected 'reject'），
 * fake 把收到的回执追加到 FAKE_AGENT_PERMISSION_LOG。
 */
describe('acp 审批往返（wire 级）', () => {
  const cases = [
    { decision: { behavior: 'allow' } as const, expectOptionId: 'allow' },
    { decision: { behavior: 'allow', always: true } as const, expectOptionId: 'always' },
    { decision: { behavior: 'deny', message: '太危险' } as const, expectOptionId: 'reject' },
  ];
  for (const c of cases) {
    it(`${c.expectOptionId}：决议正确回传 ACP outcome.selected`, async () => {
      const logDir = mkdtempSync(join(tmpdir(), 'open-cowork-acpperm-'));
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
          id: 'acp',
          create: harness.create,
          makeParams: (scriptPath) => ({
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
      // wire 层断言（fake 收到的 ACP outcome）
      const log = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(log).toHaveLength(1);
      expect(log[0].via).toBe('acp-jsonrpc');
      expect(log[0].response.outcome).toEqual({ outcome: 'selected', optionId: c.expectOptionId });
    });
  }
});
