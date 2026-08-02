import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * UI/UX 审计巡览脚本（非测试）：用 fake agent 造一组有真实感的演示数据
 * （双 workspace、已完成任务带 diff、待审批任务、置顶），逐屏截图供
 * 与 Codex 桌面端逐区比对。截图输出 /tmp/oc-audit-*.png。
 *
 * 两次启动：launch1 跑完整脚本（两个任务都批准 → awaiting_review），
 * launch2 跑挂起脚本（留一条待审批），巡览在 launch2 内进行。
 * 用法：npx tsx e2e/audit-tour.ts
 */

const FAKE_CLI = join(process.cwd(), 'tests', 'fake-agent', 'cli.mjs');
const OUT = '/tmp';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function makeRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'audit@example.com']);
  git(dir, ['config', 'user.name', 'audit']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

/** launch1 脚本：完整一轮（text → Read → Write 审批 → 落盘 → turn_end 带 usage） */
const FULL_SCRIPT = [
  { action: 'expect_stdin', match: 'demo' },
  {
    action: 'emit',
    event: {
      kind: 'text',
      text: '好的，我先看一下项目结构，然后实现这个模块。\n\n计划：\n1. 新增 `src/cart.js`（Cart 类：add / remove / total）\n2. 更新 `src/index.js` 完成接入',
      chunks: 3,
    },
  },
  { action: 'sleep', ms: 500 },
  { action: 'emit', event: { kind: 'tool_call', id: 'toolu_1', name: 'Read', input: { file_path: 'src/index.js' } } },
  { action: 'emit', event: { kind: 'tool_result', id: 'toolu_1', output: 'export function main() {\n  console.log("shop");\n}\n' } },
  { action: 'emit', event: { kind: 'tool_call', id: 'toolu_2', name: 'Write', input: { file_path: 'src/cart.js' } } },
  {
    action: 'emit',
    event: {
      kind: 'permission_request',
      id: 'perm_1',
      toolName: 'Write',
      input: { file_path: 'src/cart.js' },
      reason: '新增购物车模块',
      expectResponse: { behavior: 'allow', updatedPermissions: null },
    },
  },
  { action: 'sleep', ms: 500 },
  {
    action: 'write_file',
    path: 'src/cart.js',
    content:
      'export class Cart {\n  #items = [];\n\n  add(item) {\n    this.#items.push(item);\n    return this;\n  }\n\n  remove(id) {\n    this.#items = this.#items.filter((i) => i.id !== id);\n    return this;\n  }\n\n  total() {\n    return this.#items.reduce((sum, i) => sum + i.price, 0);\n  }\n}\n',
  },
  {
    action: 'write_file',
    path: 'src/index.js',
    content: 'import { Cart } from "./cart.js";\n\nexport function main() {\n  const cart = new Cart();\n  cart.add({ id: 1, price: 42 });\n  console.log("shop", cart.total());\n}\n',
  },
  { action: 'emit', event: { kind: 'tool_result', id: 'toolu_2', output: 'written' } },
  {
    action: 'emit',
    event: {
      kind: 'text',
      text: '模块已完成：\n\n- `add` / `remove` / `total` 三个方法就绪\n- `index.js` 已接入并导出\n\n可以在「变更」面板复查这两处改动。',
    },
  },
  { action: 'emit', event: { kind: 'turn_end', status: 'completed', usage: { inputTokens: 8432, outputTokens: 1203 } } },
];

/** launch2 脚本：留一条待审批（长时间挂起等人裁决） */
const PENDING_SCRIPT = [
  { action: 'expect_stdin', match: 'deploy' },
  { action: 'emit', event: { kind: 'text', text: '准备执行部署脚本。这一步会改动生产环境，需要你批准。', chunks: 2 } },
  { action: 'sleep', ms: 400 },
  { action: 'emit', event: { kind: 'tool_call', id: 'toolu_9', name: 'Bash', input: { command: './deploy.sh --prod' } } },
  {
    action: 'emit',
    event: {
      kind: 'permission_request',
      id: 'perm_9',
      toolName: 'Bash',
      input: { command: './deploy.sh --prod' },
      reason: '执行生产部署',
    },
  },
  { action: 'sleep', ms: 600_000 },
];

async function launch(dataDir: string, script: unknown[]): Promise<ElectronApplication> {
  const scriptFile = join(dataDir, `fake-script-${Date.now()}.jsonl`);
  await writeFile(scriptFile, script.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPEN_COWORK_DATA_DIR: dataDir,
      OPEN_COWORK_CLAUDE_CLI: FAKE_CLI,
      FAKE_AGENT_SCRIPT: scriptFile,
    },
    timeout: 30_000,
  });
}

async function addWorkspace(win: Page, dir: string, expectedCount: number): Promise<void> {
  await win.evaluate(async (p) => {
    await window.openCowork?.workspaces.addByPath(p);
  }, dir);
  await win.reload();
  await win.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="workspace-item"]').length >= n,
    expectedCount,
    { timeout: 10_000 },
  );
}

async function createTask(win: Page, prompt: string, wsName: string): Promise<void> {
  await win.getByTestId('new-task-toggle').click();
  try {
    await win.waitForSelector('[data-testid="home-hero"]', { timeout: 8_000 });
  } catch {
    const dump = await win.evaluate(() => ({
      home: document.querySelectorAll('[data-testid="home-view"]').length,
      docFlow: document.querySelectorAll('[data-testid="document-flow"]').length,
      composer: document.querySelectorAll('[data-testid="composer"]').length,
      wsSelect: document.querySelectorAll('[data-testid="composer-workspace-select"]').length,
      current: document.querySelector('[data-testid="current-task"]')?.textContent ?? null,
    }));
    console.log('createTask home-hero 未出现，DOM:', JSON.stringify(dump));
    await win.screenshot({ path: '/tmp/oc-audit-debug.png' });
    throw new Error('home-hero not reached');
  }
  // 切到目标 workspace
  await win.getByTestId('composer-workspace-select').selectOption({ label: wsName });
  // 选 claude-code（fake CLI）
  await win.getByTestId('agent-model-picker-toggle').click();
  const agentSelect = win.getByTestId('task-agent-select');
  await agentSelect.waitFor({ state: 'visible' });
  await win.waitForFunction(
    () => !(document.querySelector('[data-testid="task-agent-select"]') as HTMLSelectElement | null)?.disabled,
    undefined,
    { timeout: 10_000 },
  );
  await agentSelect.selectOption('claude-code');
  await win.getByTestId('agent-model-picker-toggle').click();
  await win.getByTestId('composer-input').fill(prompt);
  await win.getByTestId('send-button').click();
  await win.waitForSelector('[data-testid="document-flow"]', { timeout: 15_000 });
}

async function shot(win: Page, name: string, settleMs = 600): Promise<void> {
  await win.waitForTimeout(settleMs);
  await win.screenshot({ path: `${OUT}/oc-audit-${name}.png` });
  console.log(`shot: ${OUT}/oc-audit-${name}.png`);
}

const main = async (): Promise<void> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-audit-'));
  const wsRoot = await mkdtemp(join(tmpdir(), 'oc-audit-ws-'));
  // workspace 名 = 目录名，命名子目录保证 composer 选项可预测
  const wsA = join(wsRoot, 'demo-shop');
  const wsB = join(wsRoot, 'notes-app');

  makeRepo(wsA, {
    'package.json': '{\n  "name": "demo-shop",\n  "version": "0.1.0"\n}\n',
    'src/index.js': 'export function main() {\n  console.log("shop");\n}\n',
    'src/util.js': 'export const noop = () => {};\n',
    'README.md': '# demo-shop\n\n示例商城项目。\n',
  });
  makeRepo(wsB, {
    'README.md': '# notes-app\n\n本地笔记应用。\n',
    'notes.txt': '第一条笔记\n',
  });
  // wsB 手工弄脏一处（未提交），让分支行/变更统计更真实
  writeFileSync(join(wsB, 'notes.txt'), '第一条笔记\n第二条笔记（未提交）\n');

  // ── launch 1：两个完成任务（awaiting_review + diff + usage） ──
  let app = await launch(dataDir, FULL_SCRIPT);
  let win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('[data-testid="task-sidebar"]');
  await addWorkspace(win, wsA, 1);
  await addWorkspace(win, wsB, 2);

  await createTask(win, 'demo：实现购物车模块', 'demo-shop');
  // 等审批托盘出现 → ⌘1 放行 → 等 awaiting_review
  await win.waitForSelector('[data-testid="approval-tray"]', { timeout: 15_000 });
  await win.keyboard.press('ControlOrMeta+1');
  await win.waitForSelector('[data-testid="approval-tray"]', { state: 'detached', timeout: 15_000 });
  await win.waitForTimeout(1200);

  await createTask(win, 'demo：整理笔记存储层', 'notes-app');
  await win.waitForSelector('[data-testid="approval-tray"]', { timeout: 15_000 });
  await win.keyboard.press('ControlOrMeta+1');
  await win.waitForSelector('[data-testid="approval-tray"]', { state: 'detached', timeout: 15_000 });
  await win.waitForTimeout(1200);
  await app.close();

  // ── launch 2：挂起任务（待审批）+ 巡览截图 ──
  app = await launch(dataDir, PENDING_SCRIPT);
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('[data-testid="task-sidebar"]');
  await win.waitForTimeout(800);

  await createTask(win, 'deploy：执行生产部署', 'demo-shop');
  await win.waitForSelector('[data-testid="approval-tray"]', { timeout: 15_000 });

  // 置顶任务 A（demo：实现购物车模块）
  await win.getByTestId('new-task-toggle').click();
  await win.waitForSelector('[data-testid="home-view"]');
  await win.locator('[data-testid="recent-item"]', { hasText: 'demo：实现购物车模块' }).first().click();
  await win.waitForSelector('[data-testid="task-title"]', { timeout: 10_000 });
  await win.getByTestId('task-menu').click();
  await win.getByTestId('task-pin-menu').click();
  await win.waitForTimeout(400);

  // ① 首页（有数据侧栏：置顶 / 项目 / 最近 + 待办铃铛）
  await win.getByTestId('new-task-toggle').click();
  await win.waitForSelector('[data-testid="home-hero"]');
  await shot(win, '01-home');

  // ② 通知弹层（待审批 1 + 待复查 2）
  await win.getByTestId('notice-toggle').click();
  await shot(win, '02-notices', 400);
  await win.keyboard.press('Escape');

  // ③ 任务 A 文档流（用户 pill / assistant / tool 行 / 按轮工作摘要 / 待复查条）
  await win.locator('[data-testid="pinned-group"] [data-testid="task-item"]').first().click();
  await win.waitForSelector('[data-testid="workgroup"]', { timeout: 10_000 });
  await shot(win, '03-task-flow');

  // ④ 工作摘要折叠态（Codex 默认折叠对照）
  await win.getByTestId('workgroup-summary').first().click();
  await shot(win, '04-workgroup-collapsed', 400);
  await win.getByTestId('workgroup-summary').first().click();

  // ⑤ 检查栏·变更 tab（diff 复查 + git 操作区）——选中任务有变更时栏自动可见，
  // 已可见就别再按开关（toggle 会写反向覆盖把它关掉）
  if ((await win.locator('[data-testid="changes-count"]').count()) === 0) {
    await win.getByTestId('toggle-inspector').click();
  }
  await win.waitForSelector('[data-testid="changes-count"]', { timeout: 10_000 });
  await shot(win, '05-changes');

  // ⑥ 任务头菜单 + Open in 弹层
  await win.getByTestId('task-menu').click();
  await shot(win, '06-task-menu', 300);
  await win.keyboard.press('Escape');
  await win.getByTestId('task-open-in').click();
  await shot(win, '07-open-in', 300);
  await win.keyboard.press('Escape');

  // ⑦ composer 权限弹层（任务视图）
  await win.getByTestId('permission-mode-chip').click();
  await shot(win, '08-permission', 300);
  await win.keyboard.press('Escape');

  // ⑧ 终端抽屉
  await win.keyboard.press('ControlOrMeta+T');
  await win.waitForSelector('[data-testid="terminal-drawer"]');
  await shot(win, '09-terminal', 2200);
  await win.keyboard.press('ControlOrMeta+T');
  await win.waitForTimeout(400);

  // ⑨ 待审批任务（审批托盘 + 文档流）
  await win.locator('[data-testid="task-item"], [data-testid="recent-item"]', { hasText: 'deploy：执行生产部署' }).first().click();
  await win.waitForSelector('[data-testid="approval-tray"]', { timeout: 10_000 });
  await shot(win, '10-approval');

  // ⑩ 设置页
  await win.getByTestId('open-settings').click();
  await shot(win, '11-settings');

  // ⑪ 深色主题：首页 + 任务文档流
  await win.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await win.keyboard.press('Escape');
  await win.getByTestId('new-task-toggle').click();
  await win.waitForSelector('[data-testid="home-hero"]');
  await shot(win, '12-dark-home');
  await win.locator('[data-testid="recent-item"]', { hasText: 'demo：实现购物车模块' }).first().click();
  await win.waitForSelector('[data-testid="workgroup"]', { timeout: 10_000 });
  await shot(win, '13-dark-task');

  await app.close();
  console.log('done. data:', dataDir);
};

void main();
