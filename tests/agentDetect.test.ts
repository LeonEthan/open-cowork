import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOG,
  probeAuth,
  probeCustomCommand,
  probeEntry,
  readOverrides,
  resolveExecutable,
  writeOverrides,
} from '../src/main/services/agentDetect';
import {
  deriveAcpTarget,
  mapAcpToolKind,
  selectPermissionOutcome,
} from '../src/agent/drivers/acp.driver';

/**
 * agent catalog 与探测（ticket #26）：纯函数接缝——execFile/PATH/HOME 全部经 deps 注入，
 * 不起真实子进程、不读本机 HOME。
 */

const entry = (id: string): (typeof AGENT_CATALOG)[number] => {
  const e = AGENT_CATALOG.find((x) => x.id === id);
  if (!e) throw new Error(`catalog 缺少 ${id}`);
  return e;
};

describe('agent catalog（内置四家元数据）', () => {
  it('四家齐备，徽标/安装命令/官网/认证启发式完整', () => {
    expect(AGENT_CATALOG.map((e) => e.id)).toEqual(['claude-code', 'codex', 'opencode', 'pi']);
    for (const e of AGENT_CATALOG) {
      expect(e.displayName.length).toBeGreaterThan(0);
      expect(e.executable.length).toBeGreaterThan(0);
      expect(e.installCommand.length).toBeGreaterThan(0);
      expect(e.homepage).toMatch(/^https:\/\//);
      expect(['native', 'degraded', 'none']).toContain(e.capabilities.approval);
      expect(e.auth.envs.length + e.auth.homeFiles.length).toBeGreaterThan(0);
    }
    // ARCHITECTURE §2：pi 为降级接入（无内建审批）
    expect(entry('pi').capabilities.approval).toBe('degraded');
    expect(entry('claude-code').capabilities.approval).toBe('native');
  });
});

describe('可执行解析优先级（env 覆盖 → 持久化 override → PATH）', () => {
  const claude = entry('claude-code');

  it('env 覆盖命中即安装（via=env）', () => {
    const r = resolveExecutable(claude, {
      env: { OPEN_COWORK_CLAUDE_CLI: '/opt/fake/claude', PATH: '/usr/bin' },
      isExecutable: () => true,
    });
    expect(r).toEqual({ installed: true, resolvedPath: '/opt/fake/claude', via: 'env' });
  });

  it('env 覆盖失效时落到持久化 override（via=override）', () => {
    const r = resolveExecutable(claude, {
      env: { OPEN_COWORK_CLAUDE_CLI: '/gone/claude', PATH: '/usr/bin' },
      overrides: { claude: '/repaired/claude' },
      isExecutable: (p) => p === '/repaired/claude',
    });
    expect(r).toEqual({ installed: true, resolvedPath: '/repaired/claude', via: 'override' });
  });

  it('均无覆盖时 PATH 逐目录扫描（via=path）', () => {
    const r = resolveExecutable(claude, {
      env: { PATH: '/a:/b' },
      isExecutable: (p) => p === join('/b', 'claude'),
    });
    expect(r).toEqual({ installed: true, resolvedPath: join('/b', 'claude'), via: 'path' });
  });

  it('全不命中 → 未安装', () => {
    const r = resolveExecutable(claude, { env: { PATH: '/a' }, isExecutable: () => false });
    expect(r.installed).toBe(false);
    expect(r.resolvedPath).toBeNull();
  });
});

describe('认证启发式（零 spawn）', () => {
  const claude = entry('claude-code');

  it('密钥 env 命中 → 已认证', () => {
    const r = probeAuth(claude, { env: { ANTHROPIC_API_KEY: 'sk-x' }, home: null });
    expect(r.authenticated).toBe(true);
    expect(r.evidence).toContain('ANTHROPIC_API_KEY');
  });

  it('配置文件命中 → 已认证（真实 fs，mkdtemp 假 HOME）', () => {
    const home = mkdtempSync(join(tmpdir(), 'open-cowork-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    const r = probeAuth(claude, { env: {}, home });
    expect(r.authenticated).toBe(true);
    expect(r.evidence).toContain('.credentials.json');
  });

  it('均无 → 未认证（codex 口径含 auth.json 路径提示）', () => {
    const home = mkdtempSync(join(tmpdir(), 'open-cowork-home-'));
    const r = probeAuth(entry('codex'), { env: {}, home });
    expect(r.authenticated).toBe(false);
    expect(r.evidence).toContain('.codex/auth.json');
  });
});

describe('完整条目探测（probeEntry，stub 版本探测）', () => {
  it('已安装：版本首行 + 认证结论 + 徽标透传；日志逐行记录', async () => {
    const logs: string[] = [];
    const d = await probeEntry(entry('codex'), {
      env: { OPENAI_API_KEY: 'sk-x', PATH: '/x' },
      isExecutable: (p) => p === join('/x', 'codex'),
      run: async () => ({ code: 0, stdout: 'codex-cli 0.146.0\nextra\n', stderr: '' }),
      log: (l) => logs.push(l),
      now: () => 1234,
    });
    expect(d.installed).toBe(true);
    expect(d.resolvedPath).toBe(join('/x', 'codex'));
    expect(d.version).toBe('codex-cli 0.146.0');
    expect(d.authenticated).toBe(true);
    expect(d.capabilities.approval).toBe('native');
    expect(d.installCommand).toContain('codex');
    expect(d.source).toBe('builtin');
    expect(d.probedAt).toBe(1234);
    expect(logs.some((l) => l.includes('PATH 探测命中'))).toBe(true);
    expect(logs.some((l) => l.includes('--version'))).toBe(true);
  });

  it('版本探测失败不影响安装判定（fake CLI 无 --version 语义的场景）', async () => {
    const d = await probeEntry(entry('codex'), {
      env: { PATH: '/x' },
      home: null, // 隔离本机 HOME（~/.codex/auth.json 可能真实存在）
      isExecutable: () => true,
      run: async () => ({ code: 64, stdout: '', stderr: '缺少 --script', error: 'exit 64' }),
      log: () => {},
    });
    expect(d.installed).toBe(true);
    expect(d.version).toBeNull();
    expect(d.authenticated).toBe(false);
  });

  it('首行不含数字 = 非版本串（banner/JSONL），按未探测到处理（附录 B 审计 P2）', async () => {
    const d = await probeEntry(entry('codex'), {
      env: { PATH: '/x' },
      home: null,
      isExecutable: () => true,
      // fake harness 式输出：JSONL init 行（内含数字字段，单靠数字判据拦不住）
      run: async () => ({ code: 0, stdout: '{"type":"system","subtype":"init","version":"fake-0.0.0"}\n', stderr: '' }),
      log: () => {},
    });
    expect(d.installed).toBe(true);
    expect(d.version).toBeNull();
  });

  it('未安装：version/authenticated 均为 null，不跑版本探测', async () => {
    let ran = false;
    const d = await probeEntry(entry('opencode'), {
      env: { PATH: '/x' },
      isExecutable: () => false,
      run: async () => {
        ran = true;
        return { code: 0, stdout: '', stderr: '' };
      },
      log: () => {},
    });
    expect(d.installed).toBe(false);
    expect(d.version).toBeNull();
    expect(d.authenticated).toBeNull();
    expect(ran).toBe(false);
  });

  it('override 命中时结果带 overridePath（设置页「恢复自动探测」依据）', async () => {
    const d = await probeEntry(entry('codex'), {
      env: { PATH: '/x' },
      overrides: { codex: '/repaired/codex' },
      isExecutable: (p) => p === '/repaired/codex',
      run: async () => ({ code: 0, stdout: 'v1\n', stderr: '' }),
      log: () => {},
    });
    expect(d.overridePath).toBe('/repaired/codex');
  });
});

describe('override 持久化（agent-overrides.json）', () => {
  it('写入后可读回；损坏文件回落空表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-cowork-ovr-'));
    expect(readOverrides(dir)).toEqual({});
    writeOverrides(dir, { codex: '/repaired/codex' });
    expect(readOverrides(dir)).toEqual({ codex: '/repaired/codex' });
    writeFileSync(join(dir, 'agent-overrides.json'), '{{{', 'utf8');
    expect(readOverrides(dir)).toEqual({});
  });
});

describe('自定义命令探测（probeCustomCommand）', () => {
  it('绝对路径可执行 → ok + 版本；不可执行 → 明确 error', async () => {
    const ok = await probeCustomCommand(
      { id: 'a1', command: '/opt/fake/my-acp', args: ['serve'] },
      {
        isExecutable: (p) => p === '/opt/fake/my-acp',
        run: async (cmd, args) => {
          expect(args).toEqual(['serve', '--version']);
          return { code: 0, stdout: 'my-acp 1.2.3\n', stderr: '' };
        },
        log: () => {},
        now: () => 42,
      },
    );
    expect(ok).toEqual({
      ok: true,
      resolvedPath: '/opt/fake/my-acp',
      version: 'my-acp 1.2.3',
      error: null,
      at: 42,
    });

    const miss = await probeCustomCommand(
      { id: 'a1', command: '/gone/my-acp', args: [] },
      { isExecutable: () => false, log: () => {} },
    );
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain('/gone/my-acp');
  });

  it('裸命令名走 PATH 扫描', async () => {
    const r = await probeCustomCommand(
      { id: 'a2', command: 'my-acp', args: [] },
      {
        env: { PATH: '/p1:/p2' },
        isExecutable: (p) => p === join('/p2', 'my-acp'),
        run: async () => ({ code: 0, stdout: 'v0.1\n', stderr: '' }),
        log: () => {},
      },
    );
    expect(r.ok).toBe(true);
    expect(r.resolvedPath).toBe(join('/p2', 'my-acp'));
  });
});

describe('ACP 归一映射（acp.driver 纯函数）', () => {
  it('ToolCallKind → 归一工具名（与审批规则口径一致）', () => {
    expect(mapAcpToolKind('execute')).toBe('Bash');
    expect(mapAcpToolKind('edit')).toBe('Edit');
    expect(mapAcpToolKind('read')).toBe('Read');
    expect(mapAcpToolKind('search')).toBe('Grep');
    expect(mapAcpToolKind('fetch')).toBe('WebFetch');
    expect(mapAcpToolKind('delete')).toBe('unknown'); // 保守：fail-closed 视为写类
    expect(mapAcpToolKind(undefined)).toBe('unknown');
  });

  it('目标归纳：execute→command；edit→locations[0]；fetch→url；回退 title', () => {
    expect(deriveAcpTarget({ kind: 'execute', rawInput: { command: 'npm test' } })).toBe('npm test');
    expect(
      deriveAcpTarget({ kind: 'edit', locations: [{ path: '/tmp/a.ts' }], rawInput: {} }),
    ).toBe('/tmp/a.ts');
    expect(deriveAcpTarget({ kind: 'edit', rawInput: { file_path: '/tmp/b.ts' } })).toBe('/tmp/b.ts');
    expect(deriveAcpTarget({ kind: 'fetch', rawInput: { url: 'https://x.dev' } })).toBe(
      'https://x.dev',
    );
    expect(deriveAcpTarget({ kind: 'other', title: '浏览计划' })).toBe('浏览计划');
    expect(deriveAcpTarget({ kind: 'other' })).toBeNull();
  });

  it('审批决议 → outcome：allow/always/deny 的选项选择与 cancelled 兜底', () => {
    const opts = [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    expect(selectPermissionOutcome({ behavior: 'allow' }, opts)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(selectPermissionOutcome({ behavior: 'allow', always: true }, opts)).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' },
    });
    expect(selectPermissionOutcome({ behavior: 'deny' }, opts)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    // 无 allow_always 选项时 always 决议回退 allow_once；无 reject 选项时 deny → cancelled（fail-closed）
    expect(
      selectPermissionOutcome({ behavior: 'allow', always: true }, [opts[0]!, opts[2]!]),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(selectPermissionOutcome({ behavior: 'deny' }, [opts[0]!])).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});
