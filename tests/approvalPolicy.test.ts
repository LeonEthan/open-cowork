import { describe, expect, it } from 'vitest';
import type { AlwaysAllowRule } from '../src/agent/events';
import { matchesAlwaysAllowRule } from '../src/agent/events';
import { decidePermission, deriveAlwaysAllowRule, isReadOnlyTool } from '../src/main/approval/policy';
import type { PermissionMode } from '../src/main/db/entities';

/**
 * 审批策略引擎表驱动测试（ticket #20，票面权威语义）：
 * - readonly 只读：写类/命令类一律 auto_deny（读类放行，不查规则）；
 * - auto 自动：命中规则 auto_allow，未命中 ask；
 * - full 完全放权：一律 auto_allow。
 * 覆盖矩阵：三档 × 规则命中/未命中 × 读/写类工具 + 规则匹配/派生边界。
 */

interface Case {
  name: string;
  mode: PermissionMode;
  rules: AlwaysAllowRule[];
  toolName: string;
  target: string | null;
  expect: 'auto_allow' | 'auto_deny' | 'ask';
  /** auto_allow 且命中规则时的规则标签 */
  rulePattern?: string | null;
}

const NPM_RULE: AlwaysAllowRule = { tool: 'Bash', targetPattern: 'npm *' };
const WRITE_RULE: AlwaysAllowRule = { tool: 'Write', targetPattern: '/repo/.eslintrc.json' };

const CASES: Case[] = [
  // ── readonly 只读档：读类放行（不查规则），写/命令类一律拒 ──
  { name: '只读档·Read 放行', mode: 'readonly', rules: [], toolName: 'Read', target: '/a.ts', expect: 'auto_allow', rulePattern: null },
  { name: '只读档·Glob 放行', mode: 'readonly', rules: [], toolName: 'Glob', target: '*.ts', expect: 'auto_allow', rulePattern: null },
  { name: '只读档·Grep 放行', mode: 'readonly', rules: [], toolName: 'Grep', target: 'foo', expect: 'auto_allow', rulePattern: null },
  { name: '只读档·LS 放行', mode: 'readonly', rules: [], toolName: 'LS', target: '/repo', expect: 'auto_allow', rulePattern: null },
  { name: '只读档·Bash 拒（命令类）', mode: 'readonly', rules: [], toolName: 'Bash', target: 'ls -la', expect: 'auto_deny' },
  { name: '只读档·Edit 拒（写类）', mode: 'readonly', rules: [], toolName: 'Edit', target: '/a.ts', expect: 'auto_deny' },
  { name: '只读档·Write 拒（写类）', mode: 'readonly', rules: [], toolName: 'Write', target: '/a.ts', expect: 'auto_deny' },
  { name: '只读档·NotebookEdit 拒（写类）', mode: 'readonly', rules: [], toolName: 'NotebookEdit', target: '/n.ipynb', expect: 'auto_deny' },
  { name: '只读档·WebFetch 拒（联网读不属本地只读）', mode: 'readonly', rules: [], toolName: 'WebFetch', target: 'https://x.com', expect: 'auto_deny' },
  { name: '只读档·WebSearch 拒（联网）', mode: 'readonly', rules: [], toolName: 'WebSearch', target: 'q', expect: 'auto_deny' },
  { name: '只读档·未知工具拒（fail-closed 保守分类）', mode: 'readonly', rules: [], toolName: 'McpX', target: null, expect: 'auto_deny' },
  { name: '只读档·命中规则也拒（「一律」无例外）', mode: 'readonly', rules: [NPM_RULE], toolName: 'Bash', target: 'npm test', expect: 'auto_deny' },
  { name: '只读档·读类命中规则仍放行（不查规则直放）', mode: 'readonly', rules: [], toolName: 'Read', target: null, expect: 'auto_allow', rulePattern: null },

  // ── auto 自动档：规则命中放行，未命中 ask ──
  { name: '自动档·无规则 → ask', mode: 'auto', rules: [], toolName: 'Bash', target: 'npm test', expect: 'ask' },
  { name: '自动档·规则未命中（目标不符）→ ask', mode: 'auto', rules: [NPM_RULE], toolName: 'Bash', target: 'yarn test', expect: 'ask' },
  { name: '自动档·规则未命中（工具不符）→ ask', mode: 'auto', rules: [NPM_RULE], toolName: 'Edit', target: 'npm test', expect: 'ask' },
  { name: '自动档·通配规则命中 → auto_allow 带标签', mode: 'auto', rules: [NPM_RULE], toolName: 'Bash', target: 'npm install -D eslint', expect: 'auto_allow', rulePattern: 'Bash: npm *' },
  { name: '自动档·精确规则命中 → auto_allow 带标签', mode: 'auto', rules: [WRITE_RULE], toolName: 'Write', target: '/repo/.eslintrc.json', expect: 'auto_allow', rulePattern: 'Write: /repo/.eslintrc.json' },
  { name: '自动档·读类工具未命中也 ask（自动档不区分读写）', mode: 'auto', rules: [], toolName: 'Read', target: '/a.ts', expect: 'ask' },

  // ── full 完全放权档：一律 auto_allow ──
  { name: '放权档·Bash 直放', mode: 'full', rules: [], toolName: 'Bash', target: 'rm -rf build', expect: 'auto_allow', rulePattern: null },
  { name: '放权档·Write 直放', mode: 'full', rules: [], toolName: 'Write', target: '/a.ts', expect: 'auto_allow', rulePattern: null },
  { name: '放权档·未知工具直放', mode: 'full', rules: [], toolName: 'McpX', target: null, expect: 'auto_allow', rulePattern: null },
  { name: '放权档·有规则也不标注（档位直放非规则命中）', mode: 'full', rules: [NPM_RULE], toolName: 'Bash', target: 'npm test', expect: 'auto_allow', rulePattern: null },
];

describe('审批策略引擎（三档 × 命中 × 读/写类矩阵）', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const verdict = decidePermission(c.mode, c.rules, { toolName: c.toolName, target: c.target });
      expect(verdict.kind).toBe(c.expect);
      if (c.expect === 'auto_allow') {
        expect((verdict as { rulePattern: string | null }).rulePattern).toBe(c.rulePattern ?? null);
      }
      if (c.expect === 'auto_deny') {
        expect((verdict as { reason: string }).reason).toContain('只读');
      }
    });
  }

  it('多规则按记忆先后排序，先记者优先命中', () => {
    const rules: AlwaysAllowRule[] = [
      { tool: 'Bash', targetPattern: 'npm *' },
      { tool: 'Bash', targetPattern: 'npm install *' },
    ];
    const verdict = decidePermission('auto', rules, { toolName: 'Bash', target: 'npm install x' });
    expect(verdict).toEqual({ kind: 'auto_allow', rulePattern: 'Bash: npm *' });
  });
});

/**
 * ticket #31 策略集成：规则匹配改用**完整命令**（input 提取），展示投影 target 不进匹配链；
 * 多行命令逐行全命中才 auto_allow，任一行未命中 → ask（非 deny）。
 * 每例的 target 均为首行+截断投影（模拟 driver 实发），input 携完整未截断命令。
 */
describe('#31 完整命令匹配（policy 集成）', () => {
  interface FullCase {
    name: string;
    rules: AlwaysAllowRule[];
    toolName: string;
    /** driver 实发的展示投影（首行+截断） */
    target: string | null;
    /** driver 实发的完整 input（未截断） */
    input?: unknown;
    expect: 'auto_allow' | 'ask';
    rulePattern?: string;
  }
  const NPM_WILDCARD: AlwaysAllowRule = { tool: 'Bash', targetPattern: 'npm *' };
  const NPM_EXACT: AlwaysAllowRule = { tool: 'Bash', targetPattern: 'npm install' };

  const FULL_CASES: FullCase[] = [
    {
      name: '单行命中（完整文本匹配）',
      rules: [NPM_WILDCARD],
      toolName: 'Bash',
      target: 'npm install -D eslint',
      input: { command: 'npm install -D eslint' },
      expect: 'auto_allow',
      rulePattern: 'Bash: npm *',
    },
    {
      name: '单行未命中 → ask',
      rules: [NPM_WILDCARD],
      toolName: 'Bash',
      target: 'yarn add eslint',
      input: { command: 'yarn add eslint' },
      expect: 'ask',
    },
    {
      name: '多行全命中 → auto_allow（每行都命中同一条规则，幂等合理）',
      rules: [NPM_WILDCARD],
      toolName: 'Bash',
      target: 'npm install',
      input: { command: 'npm install\nnpm test' },
      expect: 'auto_allow',
      rulePattern: 'Bash: npm *',
    },
    {
      name: '多行部分命中 → ask（越权行拦下，不 auto_allow 也不 deny）',
      rules: [NPM_WILDCARD],
      toolName: 'Bash',
      target: 'npm install',
      input: { command: 'npm install\nrm -rf ~' },
      expect: 'ask',
    },
    {
      name: '空行与 # 注释行忽略 → auto_allow',
      rules: [NPM_WILDCARD],
      toolName: 'Bash',
      target: 'npm install',
      input: { command: 'npm install\n\n# 然后跑测试\nnpm test' },
      expect: 'auto_allow',
      rulePattern: 'Bash: npm *',
    },
    {
      name: '绕过剧本：无通配精确规则 + 多行（"npm install\\nrm -rf ~"）→ ask（#31 修复核心）',
      rules: [NPM_EXACT],
      toolName: 'Bash',
      target: 'npm install',
      input: { command: 'npm install\nrm -rf ~' },
      expect: 'ask',
    },
    {
      name: '绕过剧本变体：首行通配投影不放大授权（尾行 rm 拦下）',
      rules: [{ tool: 'Bash', targetPattern: 'npm install*' }],
      toolName: 'Bash',
      target: 'npm install',
      input: { command: 'npm install\nrm -rf ~' },
      expect: 'ask',
    },
    {
      name: '精确规则单行完整命中仍放行（不误伤既有记忆）',
      rules: [NPM_EXACT],
      toolName: 'Bash',
      target: 'npm install',
      input: { command: 'npm install' },
      expect: 'auto_allow',
      rulePattern: 'Bash: npm install',
    },
    {
      name: '截断投影不作数：>120 字符命令按完整文本匹配（通配前缀命中）',
      rules: [NPM_WILDCARD],
      toolName: 'Bash',
      target: `npm run ${'x'.repeat(108)}…`, // 展示投影：120 截断
      input: { command: `npm run ${'x'.repeat(200)}` },
      expect: 'auto_allow',
      rulePattern: 'Bash: npm *',
    },
    {
      name: '截断投影不作数：截断处恰成精确匹配也不命中（完整文本 ≠ 规则）',
      rules: [{ tool: 'Bash', targetPattern: `npm run ${'x'.repeat(105)}` }],
      toolName: 'Bash',
      target: `npm run ${'x'.repeat(108)}…`,
      input: { command: `npm run ${'x'.repeat(200)}` },
      expect: 'ask',
    },
    {
      name: 'input 缺席的旧调用形状：回退 target 匹配（兼容）',
      rules: [NPM_WILDCARD],
      toolName: 'Bash',
      target: 'npm test',
      expect: 'auto_allow',
      rulePattern: 'Bash: npm *',
    },
    {
      name: '非 Bash 工具：完整路径匹配精确规则（input.file_path）',
      rules: [{ tool: 'Write', targetPattern: '/repo/.eslintrc.json' }],
      toolName: 'Write',
      target: '/repo/.eslintrc.json',
      input: { file_path: '/repo/.eslintrc.json' },
      expect: 'auto_allow',
      rulePattern: 'Write: /repo/.eslintrc.json',
    },
  ];

  for (const c of FULL_CASES) {
    it(c.name, () => {
      const verdict = decidePermission('auto', c.rules, {
        toolName: c.toolName,
        target: c.target,
        ...(c.input !== undefined ? { input: c.input } : {}),
      });
      expect(verdict.kind).toBe(c.expect);
      if (c.expect === 'auto_allow') {
        expect((verdict as { rulePattern: string | null }).rulePattern).toBe(c.rulePattern ?? null);
      }
    });
  }

  it('只读档不受 #31 影响：多行命令仍一律 auto_deny（「一律」无例外）', () => {
    const verdict = decidePermission('readonly', [NPM_WILDCARD], {
      toolName: 'Bash',
      target: 'npm install',
      input: { command: 'npm install\nnpm test' },
    });
    expect(verdict.kind).toBe('auto_deny');
  });
});

describe('规则匹配 matchesAlwaysAllowRule（events.ts 权威匹配器）', () => {
  const rule = (targetPattern: string, tool = 'Bash'): AlwaysAllowRule => ({ tool, targetPattern });

  it('`*` 匹配该工具一切目标（含 null 目标）', () => {
    expect(matchesAlwaysAllowRule(rule('*'), 'Bash', 'anything')).toBe(true);
    expect(matchesAlwaysAllowRule(rule('*'), 'Bash', null)).toBe(true);
  });
  it('前缀通配 `npm *`', () => {
    expect(matchesAlwaysAllowRule(rule('npm *'), 'Bash', 'npm install')).toBe(true);
    expect(matchesAlwaysAllowRule(rule('npm *'), 'Bash', 'npmx install')).toBe(false);
    expect(matchesAlwaysAllowRule(rule('npm *'), 'Bash', 'yarn')).toBe(false);
  });
  it('无通配 = 字面精确匹配', () => {
    expect(matchesAlwaysAllowRule(rule('/a.ts', 'Write'), 'Write', '/a.ts')).toBe(true);
    expect(matchesAlwaysAllowRule(rule('/a.ts', 'Write'), 'Write', '/a.ts.bak')).toBe(false);
  });
  it('工具名精确（大小写敏感）', () => {
    expect(matchesAlwaysAllowRule(rule('*', 'bash'), 'Bash', 'x')).toBe(false);
  });
  it('正则元字符按字面处理', () => {
    expect(matchesAlwaysAllowRule(rule('a.b *'), 'Bash', 'a.b c')).toBe(true);
    expect(matchesAlwaysAllowRule(rule('a.b *'), 'Bash', 'axb c')).toBe(false);
  });
  it('null 目标不匹配非 `*` 模式', () => {
    expect(matchesAlwaysAllowRule(rule('npm *'), 'Bash', null)).toBe(false);
  });
});

describe('「总是允许」规则派生 deriveAlwaysAllowRule', () => {
  it('Bash：首词 + ` *`', () => {
    expect(deriveAlwaysAllowRule('Bash', 'npm install -D eslint')).toEqual({
      tool: 'Bash',
      targetPattern: 'npm *',
    });
    expect(deriveAlwaysAllowRule('Bash', 'npx eslint . --fix')).toEqual({
      tool: 'Bash',
      targetPattern: 'npx *',
    });
  });
  it('WebFetch：域名 + `/*`', () => {
    expect(deriveAlwaysAllowRule('WebFetch', 'https://eslint.org/docs/latest/rules')).toEqual({
      tool: 'WebFetch',
      targetPattern: 'eslint.org/*',
    });
    expect(deriveAlwaysAllowRule('WebFetch', 'http://example.com/x')).toEqual({
      tool: 'WebFetch',
      targetPattern: 'example.com/*',
    });
  });
  it('其余工具：目标原样精确', () => {
    expect(deriveAlwaysAllowRule('Write', '/repo/.eslintrc.json')).toEqual({
      tool: 'Write',
      targetPattern: '/repo/.eslintrc.json',
    });
  });
  it('无目标/空白目标 → `*`', () => {
    expect(deriveAlwaysAllowRule('Bash', null)).toEqual({ tool: 'Bash', targetPattern: '*' });
    expect(deriveAlwaysAllowRule('Bash', '   ')).toEqual({ tool: 'Bash', targetPattern: '*' });
  });
  it('读类工具白名单边界（NotebookRead 读 / NotebookEdit 写）', () => {
    expect(isReadOnlyTool('NotebookRead')).toBe(true);
    expect(isReadOnlyTool('NotebookEdit')).toBe(false);
  });
});
