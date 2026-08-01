import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DriverStartParams } from '../../src/agent/events';
import piDef, {
  PI_READ_ONLY_TOOLS,
  buildPiArgs,
  mapRuleToolToPi,
  translatePiStaticPolicy,
} from '../../src/agent/drivers/pi.driver';
import type { PiPermissionMode } from '../../src/agent/drivers/pi.driver';
import { defineContractSuite, runSession, writeScript } from './suite';
import type { DriverHarnessEntry } from './suite';
import type { AlwaysAllowRule } from '../../src/agent/events';

/**
 * pi driver 跑共享 contract 用例表（ticket #23）。
 * 接线：executablePath → fake agent harness（pi-rpc 格式，经 bin/fake-pi 包装锁定）。
 *
 * 审批覆盖（票面：「审批部分以静态策略路径覆盖」）：
 * pi 无内建审批 wire——approval:'degraded' 跳过共享套件的原生审批用例，
 * 审批面由本文件的静态策略翻译用例（三档 × 规则 → --tools 允许清单）
 * 与启动旗标 wire 级断言（fake 启动回显）覆盖。
 */

const FAKE_PI = fileURLToPath(new URL('../fake-agent/bin/fake-pi', import.meta.url));

defineContractSuite({
  id: 'pi',
  approval: 'degraded',
  create: piDef.create,
  makeParams: (scriptPath) =>
    // 共享归一用例在放权面下跑：fake 不执行 --tools 旗标（脚本原样发工具事件），
    // 缺省档位（auto 无规则=只读面）会触发纵深防御拦截。静态策略覆盖见下方专属用例。
    ({
      executablePath: FAKE_PI,
      env: { FAKE_AGENT_SCRIPT: scriptPath },
      permissionMode: 'full',
    }) as unknown as Partial<DriverStartParams>,
});

// ── 静态审批翻译（#20 策略引擎语义 → pi 启动旗标；表驱动纯函数用例） ──────────

describe('pi 静态审批翻译（translatePiStaticPolicy，#23 降级路径）', () => {
  const READ_SET = ['find', 'grep', 'ls', 'read'];

  const cases: Array<{
    name: string;
    mode: PiPermissionMode;
    rules: AlwaysAllowRule[];
    expectTools: string[] | null;
  }> = [
    {
      name: '只读档：仅读类工具（规则不影响只读档）',
      mode: 'readonly',
      rules: [{ tool: 'Bash', targetPattern: '*' }],
      expectTools: READ_SET,
    },
    {
      name: '只读档（空规则）：同样仅读类工具',
      mode: 'readonly',
      rules: [],
      expectTools: READ_SET,
    },
    {
      name: '完全放权：null（不附加 --tools，pi 全工具可用）',
      mode: 'full',
      rules: [{ tool: 'Bash', targetPattern: 'rm *' }],
      expectTools: null,
    },
    {
      name: '自动档（空规则）：等价只读面（fail-closed 保守兜底）',
      mode: 'auto',
      rules: [],
      expectTools: READ_SET,
    },
    {
      name: '自动档：Bash 规则 → bash 进允许清单',
      mode: 'auto',
      rules: [{ tool: 'Bash', targetPattern: 'npm *' }],
      expectTools: [...READ_SET, 'bash'],
    },
    {
      name: '自动档：Edit + Write 规则 → edit/write 进允许清单',
      mode: 'auto',
      rules: [
        { tool: 'Edit', targetPattern: '/tmp/a.ts' },
        { tool: 'Write', targetPattern: '*' },
      ],
      expectTools: [...READ_SET, 'edit', 'write'],
    },
    {
      name: '自动档：读类工具规则（Read/Glob/Grep/LS/NotebookRead）不改变读类面',
      mode: 'auto',
      rules: [
        { tool: 'Read', targetPattern: '*' },
        { tool: 'Glob', targetPattern: 'src/*' },
        { tool: 'NotebookRead', targetPattern: '*' },
      ],
      expectTools: READ_SET,
    },
    {
      name: '自动档：未知工具规则不构成放行依据（fail-closed 保守映射）',
      mode: 'auto',
      rules: [
        { tool: 'WebFetch', targetPattern: 'example.com/*' },
        { tool: 'mcp__something', targetPattern: '*' },
      ],
      expectTools: READ_SET,
    },
    {
      name: '自动档：pi 原生小写名规则直通',
      mode: 'auto',
      rules: [{ tool: 'bash', targetPattern: 'ls *' }],
      expectTools: [...READ_SET, 'bash'],
    },
    {
      name: '自动档：规则去重（多规则同工具）',
      mode: 'auto',
      rules: [
        { tool: 'Bash', targetPattern: 'npm *' },
        { tool: 'Bash', targetPattern: 'git *' },
      ],
      expectTools: [...READ_SET, 'bash'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const policy = translatePiStaticPolicy(c.mode, c.rules);
      expect(policy.mode).toBe(c.mode);
      expect(policy.allowedTools).toEqual(c.expectTools === null ? null : [...c.expectTools].sort());
      expect(policy.summary.length).toBeGreaterThan(0);
    });
  }

  it('读类工具常量与 #20 语义对齐（find/grep/ls/read，升序）', () => {
    expect([...PI_READ_ONLY_TOOLS].sort()).toEqual(READ_SET);
    expect(PI_READ_ONLY_TOOLS).not.toContain('bash');
    expect(PI_READ_ONLY_TOOLS).not.toContain('edit');
    expect(PI_READ_ONLY_TOOLS).not.toContain('write');
  });

  it('规则工具名映射表（claude 风格 ↔ pi 原生）', () => {
    expect(mapRuleToolToPi('Bash')).toBe('bash');
    expect(mapRuleToolToPi('Edit')).toBe('edit');
    expect(mapRuleToolToPi('Write')).toBe('write');
    expect(mapRuleToolToPi('Read')).toBe('read');
    expect(mapRuleToolToPi('Glob')).toBe('find');
    expect(mapRuleToolToPi('Grep')).toBe('grep');
    expect(mapRuleToolToPi('LS')).toBe('ls');
    expect(mapRuleToolToPi('WebFetch')).toBeNull();
    expect(mapRuleToolToPi('unknown-tool')).toBeNull();
  });
});

describe('pi 启动参数组装（buildPiArgs）', () => {
  it('只读档：--mode rpc --no-session --tools 读类清单', () => {
    const policy = translatePiStaticPolicy('readonly', []);
    const args = buildPiArgs({ model: null, policy });
    expect(args).toEqual(['--mode', 'rpc', '--no-session', '--tools', 'find,grep,ls,read']);
  });

  it('完全放权：无 --tools 旗标', () => {
    const policy = translatePiStaticPolicy('full', []);
    const args = buildPiArgs({ model: null, policy });
    expect(args).toEqual(['--mode', 'rpc', '--no-session']);
    expect(args).not.toContain('--tools');
  });

  it('model 快照 → --model 旗标', () => {
    const policy = translatePiStaticPolicy('full', []);
    const args = buildPiArgs({ model: 'anthropic/claude-sonnet-4', policy });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4');
  });

  it('自动档规则命中：--tools 含规则工具', () => {
    const policy = translatePiStaticPolicy('auto', [{ tool: 'Bash', targetPattern: 'npm *' }]);
    const args = buildPiArgs({ model: null, policy });
    const toolsValue = args[args.indexOf('--tools') + 1];
    expect(toolsValue.split(',')).toContain('bash');
    expect(toolsValue.split(',')).toContain('read');
  });
});

// ── 启动旗标 wire 级断言（fake 启动回显：driver 实际 spawn 的 argv） ──────────

describe('pi 启动旗标（wire 级，fake 启动回显断言）', () => {
  /** 跑一个最小会话并读取 fake 启动回显 */
  async function runAndReadStartupLog(
    permissionMode: PiPermissionMode,
    rules: AlwaysAllowRule[],
  ): Promise<{ args: string[] }> {
    const logDir = mkdtempSync(join(tmpdir(), 'open-cowork-pi-startup-'));
    const logFile = join(logDir, 'startup.jsonl');
    const script = writeScript([
      { action: 'expect_stdin' },
      { action: 'emit', event: { kind: 'text', text: '好' } },
      { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
      { action: 'exit', code: 0 },
    ]);
    const entry: DriverHarnessEntry = {
      id: 'pi',
      create: piDef.create,
      makeParams: (scriptPath) =>
        // permissionMode 无 DriverStartParams 字段（events.ts 冻结）——
        // 与 utility 宿主同款的结构化附加透传（双重断言绕过过剩属性检查）
        ({
          executablePath: FAKE_PI,
          env: { FAKE_AGENT_SCRIPT: scriptPath, FAKE_AGENT_STARTUP_LOG: logFile },
          permissionMode,
          alwaysAllowRules: rules,
        }) as unknown as Partial<DriverStartParams>,
    };
    const { end } = await runSession(entry, script);
    expect(end.reason).toBe('completed');
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]) as { args: string[] };
  }

  it('只读档：--tools 禁写禁执行（无 bash/edit/write）', async () => {
    const { args } = await runAndReadStartupLog('readonly', []);
    // bin/fake-pi 会在头部插入 --format pi-rpc（harness 包装），断言关注 driver 拼的旗标段
    expect(args).toContain('--mode');
    expect(args[args.indexOf('--mode') + 1]).toBe('rpc');
    expect(args).toContain('--no-session');
    const toolsValue = args[args.indexOf('--tools') + 1];
    expect(toolsValue).toBeTruthy();
    const tools = toolsValue.split(',');
    expect(tools).toContain('read');
    expect(tools).toContain('grep');
    expect(tools).toContain('find');
    expect(tools).toContain('ls');
    expect(tools).not.toContain('bash');
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('write');
  });

  it('自动档 + Bash 规则：--tools 含 bash', async () => {
    const { args } = await runAndReadStartupLog('auto', [{ tool: 'Bash', targetPattern: 'npm *' }]);
    const tools = args[args.indexOf('--tools') + 1].split(',');
    expect(tools).toContain('bash');
    expect(tools).toContain('read');
    expect(tools).not.toContain('edit');
  });

  it('完全放权：不加 --tools 旗标', async () => {
    const { args } = await runAndReadStartupLog('full', []);
    expect(args).not.toContain('--tools');
    expect(args).toContain('--mode');
  });
});

// ── pi 专属归一细节（共享套件未覆盖的降级路径行为） ──────────────────────────

describe('pi 专属归一（usage / 静态策略纵深防御）', () => {
  function piEntry(env: Record<string, string>): DriverHarnessEntry {
    return {
      id: 'pi',
      create: piDef.create,
      makeParams: (scriptPath) => ({
        executablePath: FAKE_PI,
        env: { FAKE_AGENT_SCRIPT: scriptPath, ...env },
      }),
    };
  }

  it('usage 归一：turn_end 的 message.usage 累计为 UsageEvent（形状对齐 events.ts）', async () => {
    const script = writeScript([
      { action: 'expect_stdin' },
      { action: 'emit', event: { kind: 'text', text: '干活' } },
      {
        action: 'emit',
        event: {
          kind: 'turn_end',
          status: 'completed',
          usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 7, cacheWriteTokens: 3 },
        },
      },
      { action: 'exit', code: 0 },
    ]);
    const { collected, end } = await runSession(piEntry({}), script);
    expect(end.reason).toBe('completed');
    const usageEvents = collected.byType('usage');
    expect(usageEvents).toHaveLength(1);
    const u = usageEvents[0].usage;
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(40);
    expect(u.cacheReadTokens).toBe(7);
    expect(u.cacheWriteTokens).toBe(3);
    // model 来自握手 get_state（fake 回 ctx.model 缺省值）
    expect(u.model).toBe('fake-model-1');
  });

  it('纵深防御（fail-closed）：清单外工具执行 → 会话终止 + turn_end(failed)', async () => {
    // 只读档下 fake 强行执行 bash（模拟旗标语义被绕过）——driver 应立即 fail-closed
    const script = writeScript([
      { action: 'expect_stdin' },
      { action: 'emit', event: { kind: 'tool_call', id: 'evil_1', name: 'Bash', input: { command: 'rm -rf /' } } },
      { action: 'sleep', ms: 60_000 }, // driver 若不杀，脚本挂到超时即失败
      { action: 'exit', code: 0 },
    ]);
    const entry = piEntry({});
    const readonlyEntry: DriverHarnessEntry = {
      ...entry,
      makeParams: (scriptPath) =>
        ({
          ...entry.makeParams(scriptPath),
          permissionMode: 'readonly',
        }) as DriverStartParams,
    };
    const { collected, end } = await runSession(readonlyEntry, script);
    expect(end.reason).toBe('failed');
    expect(end.error).toContain('静态策略');
    const turnEnds = collected.byType('turn_end');
    expect(turnEnds.some((t) => t.status === 'failed')).toBe(true);
    const fatal = collected.byType('error').find((e) => e.fatal);
    expect(fatal?.message).toContain('bash');
  });
});
