import { describe, expect, it } from 'vitest';
import type { AlwaysAllowRule } from '../src/agent/events';
import { matchesAlwaysAllowRule } from '../src/agent/events';
import {
  deriveDisplayTarget,
  displayTarget,
  extractFullCommand,
  ruleMatchTarget,
} from '../src/agent/commandTarget';

/**
 * 命令/目标文本归一器表驱动测试（ticket #31）。
 *
 * 锁定 #31 安全语义：规则匹配用**完整命令文本**（extractFullCommand/ruleMatchTarget），
 * 首行 + 截断投影（displayTarget/deriveDisplayTarget）仅展示用；
 * 多行命令逐行全命中才放行（matchesAlwaysAllowRule 升级语义，events.ts 权威匹配器）。
 */

describe('extractFullCommand：按工具取完整文本（不投影、不截断）', () => {
  const LONG = `npm run ${'x'.repeat(200)}`;

  it('Bash：完整 command（多行与超长原样保留）', () => {
    const multi = 'npm install\nrm -rf ~';
    expect(extractFullCommand('Bash', { command: multi })).toBe(multi);
    expect(extractFullCommand('Bash', { command: LONG })).toBe(LONG);
  });
  it('工具名大小写不敏感（claude 风格与原生小写同口径）', () => {
    expect(extractFullCommand('bash', { command: 'ls' })).toBe('ls');
    expect(extractFullCommand('BASH', { command: 'ls' })).toBe('ls');
  });
  it('写/读类：file_path（claude）→ filePath（opencode）→ path（pi 系）→ grantRoot（codex）', () => {
    expect(extractFullCommand('Edit', { file_path: '/a.ts' })).toBe('/a.ts');
    expect(extractFullCommand('Write', { filePath: '/b.ts' })).toBe('/b.ts');
    expect(extractFullCommand('Read', { path: '/c.ts' })).toBe('/c.ts');
    expect(extractFullCommand('NotebookEdit', { file_path: '/n.ipynb' })).toBe('/n.ipynb');
    expect(extractFullCommand('Edit', { grantRoot: '/repo' })).toBe('/repo');
    // 优先级：file_path 先于其余键
    expect(extractFullCommand('Edit', { file_path: '/a.ts', path: '/z.ts' })).toBe('/a.ts');
  });
  it('Glob/Grep/find：pattern；LS：path；WebFetch：url；WebSearch：query', () => {
    expect(extractFullCommand('Glob', { pattern: '*.ts' })).toBe('*.ts');
    expect(extractFullCommand('Grep', { pattern: 'foo' })).toBe('foo');
    expect(extractFullCommand('find', { pattern: '*.md' })).toBe('*.md');
    expect(extractFullCommand('LS', { path: '/repo' })).toBe('/repo');
    expect(extractFullCommand('WebFetch', { url: 'https://x.com/a' })).toBe('https://x.com/a');
    expect(extractFullCommand('WebSearch', { query: 'q' })).toBe('q');
  });
  it('Task/Agent：description 优先，回退 prompt', () => {
    expect(extractFullCommand('Task', { description: '调研', prompt: '长文' })).toBe('调研');
    expect(extractFullCommand('Agent', { prompt: '长文' })).toBe('长文');
  });
  it('未知工具 / 键缺失 / 空串 / 非对象 input → null', () => {
    expect(extractFullCommand('McpX', { command: 'ls' })).toBe(null);
    expect(extractFullCommand('Bash', {})).toBe(null);
    expect(extractFullCommand('Bash', { command: '' })).toBe(null);
    expect(extractFullCommand('Bash', { command: 42 })).toBe(null);
    expect(extractFullCommand('Bash', null)).toBe(null);
    expect(extractFullCommand('Bash', undefined)).toBe(null);
  });
});

describe('displayTarget：展示投影（仅 UI，永不进匹配链）', () => {
  it('首行投影（多行只取首行）', () => {
    expect(displayTarget('npm install\nrm -rf ~')).toBe('npm install');
  });
  it('120 字符截断 + 省略号；恰好 120 不截断', () => {
    const exact = 'a'.repeat(120);
    expect(displayTarget(exact)).toBe(exact);
    const over = 'a'.repeat(121);
    expect(displayTarget(over)).toBe(`${'a'.repeat(120)}…`);
  });
  it('null / 空串 / 首行为空 → null', () => {
    expect(displayTarget(null)).toBe(null);
    expect(displayTarget('')).toBe(null);
    expect(displayTarget('\n第二行')).toBe(null);
  });
});

describe('deriveDisplayTarget：展示归纳（含 fallback 投影）', () => {
  it('完整提取后投影（Bash 多行 → 首行）', () => {
    expect(deriveDisplayTarget('Bash', { command: 'npm install\nrm -rf ~' })).toBe('npm install');
  });
  it('无法归纳时用 fallback（如 claude blockedPath），同样经投影', () => {
    expect(deriveDisplayTarget('Bash', {}, '/blocked/path')).toBe('/blocked/path');
    expect(deriveDisplayTarget('Bash', {}, `${'p'.repeat(121)}`)).toBe(`${'p'.repeat(120)}…`);
    expect(deriveDisplayTarget('McpX', {})).toBe(null);
  });
});

describe('ruleMatchTarget：匹配入口（完整命令优先，回退展示 target）', () => {
  it('input 有规范键 → 完整命令（不是投影）', () => {
    expect(ruleMatchTarget('Bash', { command: 'npm install\nrm -rf ~' }, 'npm install')).toBe(
      'npm install\nrm -rf ~',
    );
  });
  it('input 缺规范键 → 回退 driver 归纳的 target', () => {
    expect(ruleMatchTarget('Edit', { locations: [{ path: '/a.ts' }] }, '/a.ts')).toBe('/a.ts');
    expect(ruleMatchTarget('McpX', null, 'server-x')).toBe('server-x');
    expect(ruleMatchTarget('Bash', {}, null)).toBe(null);
  });
});

describe('matchesAlwaysAllowRule 多行语义（#31：逐行全命中才放行）', () => {
  const rule = (targetPattern: string, tool = 'Bash'): AlwaysAllowRule => ({
    tool,
    targetPattern,
  });

  interface Case {
    name: string;
    pattern: string;
    target: string | null;
    expect: boolean;
  }
  const CASES: Case[] = [
    // ── 单行：既有行为不变（回归锁定）──
    { name: '单行·通配前缀命中', pattern: 'npm *', target: 'npm install', expect: true },
    { name: '单行·通配前缀未命中', pattern: 'npm *', target: 'yarn add', expect: false },
    { name: '单行·精确命中', pattern: 'npm install', target: 'npm install', expect: true },
    { name: '单行·精确未命中', pattern: 'npm install', target: 'npm installx', expect: false },
    { name: '单行·全通配', pattern: '*', target: 'rm -rf ~', expect: true },
    // ── 多行：逐行全命中才放行 ──
    { name: '多行·全命中放行（幂等合理）', pattern: 'npm *', target: 'npm install\nnpm test', expect: true },
    { name: '多行·部分命中不放行（越权行拦下）', pattern: 'npm *', target: 'npm install\nrm -rf ~', expect: false },
    { name: '多行·首行命中不代表全文命中', pattern: 'npm *', target: 'rm -rf ~\nnpm install', expect: false },
    // ── #31 绕过剧本：无通配精确规则不得被多行绕过 ──
    { name: '绕过剧本·精确规则 vs 多行', pattern: 'npm install', target: 'npm install\nrm -rf ~', expect: false },
    { name: '绕过剧本·首行通配 vs 多行尾行', pattern: 'npm install*', target: 'npm install\nrm -rf ~', expect: false },
    // ── 空行与注释行忽略 ──
    { name: '多行·空行忽略', pattern: 'npm *', target: 'npm install\n\n\nnpm test', expect: true },
    { name: '多行·# 注释行忽略', pattern: 'npm *', target: 'npm install\n# 然后收尾\nnpm test', expect: true },
    { name: '多行·注释行带前导空白也算注释', pattern: 'npm *', target: 'npm install\n   # 注释\nnpm test', expect: true },
    { name: '多行·行首尾空白不计', pattern: 'npm install', target: '  npm install  \nnpm install', expect: true },
    { name: '单行有效行+注释行 → 按有效行匹配', pattern: 'npm install', target: 'npm install\n# 收尾说明', expect: true },
    { name: 'CRLF·\\r 随行尾空白去除', pattern: 'npm *', target: 'npm install\r\nnpm test\r\n', expect: true },
    // ── 全空/全注释：既有单文本语义（等效无操作命令）──
    { name: '全注释·全通配命中', pattern: '*', target: '# 什么也没做\n\n', expect: true },
    { name: '全注释·非全通配不命中', pattern: 'npm *', target: '# 什么也没做', expect: false },
    // ── null / 空目标边界（回归锁定）──
    { name: 'null 目标·全通配命中', pattern: '*', target: null, expect: true },
    { name: 'null 目标·非全通配不命中', pattern: 'npm *', target: null, expect: false },
  ];
  for (const c of CASES) {
    it(c.name, () => {
      expect(matchesAlwaysAllowRule(rule(c.pattern), 'Bash', c.target)).toBe(c.expect);
    });
  }

  it('工具名不匹配一律 false（多行也不例外）', () => {
    expect(matchesAlwaysAllowRule(rule('npm *', 'Edit'), 'Bash', 'npm install\nnpm test')).toBe(
      false,
    );
  });

  it('「每一行命中同一条规则」：规则集 find 语义下不允许跨行拼规则', () => {
    // 两行分别命中不同规则也不行——单条规则必须覆盖全部行
    const rules: AlwaysAllowRule[] = [rule('npm *'), rule('yarn *')];
    const hit = rules.find((r) => matchesAlwaysAllowRule(r, 'Bash', 'npm install\nyarn add'));
    expect(hit).toBeUndefined();
    // 同规则覆盖两行 → 命中
    const hit2 = rules.find((r) => matchesAlwaysAllowRule(r, 'Bash', 'npm install\nnpm test'));
    expect(hit2).toEqual(rule('npm *'));
  });
});
