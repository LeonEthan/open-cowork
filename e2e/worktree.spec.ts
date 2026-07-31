import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * worktree 隔离与回流（ticket #25）端到端：
 * ① git workspace 勾选 worktree 建任务 → fake agent write_file 落进隔离目录
 *    （断言原目录零改动）→ 变更 tab 有 diff → 「回流到原目录」→ 原目录出现
 *    未提交改动（git status 有、git log 无新 commit）→ 「清理 worktree」磁盘回收；
 * ② base 漂移：worktree 任务创建后在原仓 commit 一次 → 回流被阻断并提示 →
 *    「我已处理，强制回流」放行。
 * 等待全部用 expect 自动等待 / expect.poll，无裸 sleep；数据目录 mkdtemp 隔离。
 */

const FAKE_CLI = join(process.cwd(), 'tests', 'fake-agent', 'cli.mjs');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function initGitWorkspace(wsDir: string): void {
  git(wsDir, ['init', '-q', '-b', 'main']);
  git(wsDir, ['config', 'user.email', 'e2e@example.com']);
  git(wsDir, ['config', 'user.name', 'e2e']);
  git(wsDir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(wsDir, 'hello.txt'), 'v1\n');
  git(wsDir, ['add', '-A']);
  git(wsDir, ['commit', '-q', '-m', 'base']);
}

async function launchWithScript(dataDir: string, script: unknown[]): Promise<ElectronApplication> {
  const scriptFile = join(dataDir, 'fake-script.jsonl');
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

/** 添加 workspace + 经 UI 建 worktree 任务（勾选隔离） */
async function setupWorktreeTask(
  app: ElectronApplication,
  wsDir: string,
  prompt: string,
): Promise<void> {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByTestId('task-sidebar')).toBeVisible();
  await win.evaluate(async (p) => {
    await window.openCowork?.workspaces.addByPath(p);
  }, wsDir);
  await win.reload();
  await expect(win.getByTestId('workspace-item')).toHaveCount(1);
  await win.getByTestId('new-task-toggle').click();
  await win.getByTestId('task-prompt-input').fill(prompt);
  await win.getByTestId('task-agent-select').selectOption('claude-code');
  // git workspace：worktree 勾选框可用（探测经 IPC，自动等待 enabled）
  await expect(win.getByTestId('task-worktree-checkbox')).toBeEnabled();
  await win.getByTestId('task-worktree-checkbox').check();
  await win.getByTestId('task-create-submit').click();
  await expect(win.getByTestId('task-item')).toHaveCount(1);
}

/** dataDir/worktrees/ 下当前唯一的 worktree 目录（不存在返回 null） */
function soleWorktreeDir(dataDir: string): string | null {
  const wtRoot = join(dataDir, 'worktrees');
  if (!existsSync(wtRoot)) return null;
  const entries = readdirSync(wtRoot).filter((e) => existsSync(join(wtRoot, e)));
  return entries.length > 0 ? join(wtRoot, entries[0]) : null;
}

test('worktree 任务全流程：隔离运行（原目录零改动）→ 变更 tab → 回流未提交形态 → 清理回收', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e25-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws25-'));
  initGitWorkspace(wsDir);
  const headBefore = git(wsDir, ['rev-parse', 'HEAD']).trim();

  const script = [
    { action: 'expect_stdin', match: '隔离改造' },
    { action: 'write_file', path: 'hello.txt', content: 'v1\nv2 in worktree\n' },
    { action: 'write_file', path: 'worktree-only.txt', content: 'isolated\n' },
    { action: 'emit', event: { kind: 'text', text: '已在隔离目录完成修改。' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript(dataDir, script);
  try {
    await setupWorktreeTask(app, wsDir, '隔离改造两个文件');

    // 任务入库后 worktree 已建（集中目录 <dataDir>/worktrees/<taskId>）
    const wtDir = soleWorktreeDir(dataDir);
    expect(wtDir).not.toBeNull();

    const win = (await app.windows())[0];
    await win.getByTestId('send-button').click();

    // fake agent 在 worktree 内写文件：worktree 有、原目录零改动（票面 AC）
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });
    expect(readFileSync(join(wtDir!, 'worktree-only.txt'), 'utf8')).toBe('isolated\n');
    expect(existsSync(join(wsDir, 'worktree-only.txt'))).toBe(false);
    expect(readFileSync(join(wsDir, 'hello.txt'), 'utf8')).toBe('v1\n');
    expect(git(wsDir, ['status', '--porcelain'])).toBe('');

    // 变更 tab：worktree 内改动照常捕获（diff 在隔离目录量起）
    await win.getByTestId('inspector-tab-changes').click();
    await expect(win.getByTestId('change-row')).toHaveCount(2, { timeout: 10_000 });
    await expect(
      win.locator('[data-testid="change-row"][data-path="worktree-only.txt"]'),
    ).toBeVisible();
    await expect(win.getByTestId('worktree-panel')).toBeVisible();

    // 回流到原目录：未提交形态落位（git status 有改动、log 无新 commit、HEAD 不动）
    await win.getByTestId('worktree-backflow').click();
    await expect(win.getByTestId('worktree-message')).toContainText('已回流 2 个文件', {
      timeout: 10_000,
    });
    expect(readFileSync(join(wsDir, 'hello.txt'), 'utf8')).toBe('v1\nv2 in worktree\n');
    expect(readFileSync(join(wsDir, 'worktree-only.txt'), 'utf8')).toBe('isolated\n');
    const status = git(wsDir, ['status', '--porcelain']);
    expect(status).toContain(' M hello.txt');
    expect(status).toContain('?? worktree-only.txt');
    expect(git(wsDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(wsDir, ['log', '--oneline']).trim().split('\n')).toHaveLength(1);

    // 清理 worktree（两段确认）：磁盘回收 + 面板消失 + 分支保留（逃生舱）
    await win.getByTestId('worktree-cleanup').click();
    await win.getByTestId('worktree-cleanup-confirm').click();
    await expect(win.getByTestId('worktree-panel')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => soleWorktreeDir(dataDir), { timeout: 10_000 }).toBeNull();
    expect(git(wsDir, ['worktree', 'list', '--porcelain'])).not.toContain('worktrees/');
    expect(git(wsDir, ['branch', '--list', 'cowork/*']).trim()).not.toBe('');
    // 回流成果不因清理丢失（改动已在原目录工作区）
    expect(readFileSync(join(wsDir, 'worktree-only.txt'), 'utf8')).toBe('isolated\n');
  } finally {
    await app.close();
  }
});

test('base 漂移：任务创建后原仓新提交 → 回流阻断并提示 → 强制回流放行', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e25d-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws25d-'));
  initGitWorkspace(wsDir);

  // 任务无需真跑 agent——脚本仅打底（不会启动）
  const script = [{ action: 'exit', code: 0 }];
  const app = await launchWithScript(dataDir, script);
  try {
    await setupWorktreeTask(app, wsDir, '漂移验证任务');
    const win = (await app.windows())[0];

    // 任务创建后原仓前进一次提交（base 漂移；面板状态为创建时的快照，漂移由服务端守卫兜底）
    writeFileSync(join(wsDir, 'upstream.txt'), 'upstream\n');
    git(wsDir, ['add', '-A']);
    git(wsDir, ['commit', '-q', '-m', 'upstream work']);

    // 变更 tab：worktree 面板在；点「回流到原目录」→ 服务端漂移守卫阻断 → 提示 + 强制路径
    await win.getByTestId('inspector-tab-changes').click();
    await expect(win.getByTestId('worktree-panel')).toBeVisible({ timeout: 10_000 });
    await win.getByTestId('worktree-backflow').click();
    await expect(win.getByTestId('worktree-error')).toContainText('漂移', { timeout: 10_000 });
    await expect(win.getByTestId('worktree-drift-hint')).toBeVisible();
    // 阻断后：普通回流键撤下，只剩「我已处理，强制回流」；原目录零改动
    await expect(win.getByTestId('worktree-backflow')).toHaveCount(0);
    await expect(win.getByTestId('worktree-backflow-force')).toBeVisible();
    expect(git(wsDir, ['status', '--porcelain'])).toBe('');

    // 用户确认已处理 → 强制回流放行（本例 worktree 无改动，files=0 成功）
    await win.getByTestId('worktree-backflow-force').click();
    await expect(win.getByTestId('worktree-message')).toContainText('没有可回流的改动', {
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});
