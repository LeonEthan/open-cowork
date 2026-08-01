import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import claudeDef from '../../src/agent/drivers/claude.driver';
import { defineContractSuite, runSession, writeScript, type DriverHarnessEntry } from './suite';

/**
 * Claude driver 跑共享 contract 用例表（ticket #19）。
 * 接线：executablePath → fake agent harness（claude stream-json 格式脚本化输出）。
 * #22/#23 新增 driver 时仿照本文件新建 <name>.contract.test.ts，复用 suite.ts。
 */
const entry: DriverHarnessEntry = {
  id: 'claude-code',
  create: claudeDef.create,
  makeParams: (scriptPath) => ({
    executablePath: fileURLToPath(new URL('../fake-agent/cli.mjs', import.meta.url)),
    env: { FAKE_AGENT_SCRIPT: scriptPath },
  }),
  // ticket #30：claude 豁免 pid 断言——Agent SDK 的 query()/Query 公开接口不暴露
  // 子进程 pid（子进程由 SDK 托管 spawn）；不改 SDK、不 monkey-patch（票面约束），
  // 崩溃孤儿风险由 SDK 自身进程关系承担（见 claude.driver.ts 注释与修复报告）。
  supportsPid: false,
};

defineContractSuite(entry);

/**
 * audit phase-g（不碰全局红线）：allow_always 回写 updatedPermissions 时，
 * 仅 destination='session' 的 suggestion 放行；userSettings/projectSettings
 * 等会让 CLI 改写用户全局 ~/.claude/settings.json 等持久配置，一律丢弃。
 */
describe('claude 专属：updatedPermissions destination 白名单', () => {
  it('非 session 目的地的 suggestions 一律丢弃（不碰用户全局配置）', async () => {
    const SESSION_UPDATE = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm *' }],
      behavior: 'allow',
      destination: 'session',
    };
    const script = writeScript([
      { action: 'expect_stdin' },
      {
        action: 'emit',
        event: {
          kind: 'permission_request',
          id: 'perm_filter',
          toolName: 'Bash',
          input: { command: 'npm install' },
          suggestions: [
            SESSION_UPDATE,
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
              behavior: 'allow',
              destination: 'userSettings', // 会写用户全局配置——必须丢弃
            },
            { type: 'setMode', mode: 'acceptEdits', destination: 'projectSettings' }, // 同上
          ],
          // wire 级断言：agent 实际只收到 session 那条
          expectResponse: { behavior: 'allow', updatedPermissions: [SESSION_UPDATE] },
        },
      },
      { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
      { action: 'exit', code: 0 },
    ]);
    const { end } = await runSession(entry, script, {
      permissionDecision: { behavior: 'allow', always: true },
    });
    expect(end.reason).toBe('completed');
  });

  it('全部 suggestions 被过滤时不回写 updatedPermissions', async () => {
    const script = writeScript([
      { action: 'expect_stdin' },
      {
        action: 'emit',
        event: {
          kind: 'permission_request',
          id: 'perm_filter_all',
          toolName: 'Bash',
          input: { command: 'npm install' },
          suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'npm *' }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ],
          // 键缺省（fake 侧 got ?? null）：过滤干净后不带 updatedPermissions
          expectResponse: { behavior: 'allow', updatedPermissions: null },
        },
      },
      { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
      { action: 'exit', code: 0 },
    ]);
    const { end } = await runSession(entry, script, {
      permissionDecision: { behavior: 'allow', always: true },
    });
    expect(end.reason).toBe('completed');
  });
});
