import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { addWorkspaceViaBridge, createTaskViaComposer } from './helpers';

/**
 * diff 复查与回滚（ticket #24）端到端：
 * fake agent 脚本 write_file 制造真实工作区变更 → turn_end 捕获 →
 * 检查栏「变更」tab 列表 + 内嵌 diff → 文件级/任务级接受回滚与恢复。
 *
 * ① git workspace：两文件变更 → 文件级回滚其一（工作区还原 + 可恢复）→
 *    恢复 → 任务级全部接受 → done；全程断言 git log/index 不变（不自动 commit）。
 * ② 非 git workspace：快照兜底同款简版——全部回滚 → done → 快照期内恢复。
 * 等待全部用 expect 自动等待 / expect.poll，无裸 sleep；数据目录 mkdtemp 隔离。
 */

const FAKE_CLI = join(process.cwd(), 'tests', 'fake-agent', 'cli.mjs');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
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

/** 添加 workspace + 经首页 composer 建任务并开跑（ticket #36：create+start 一步到位） */
async function setupWorkspaceAndTask(
  app: ElectronApplication,
  wsDir: string,
  prompt: string,
): Promise<void> {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByTestId('task-sidebar')).toBeVisible();
  await addWorkspaceViaBridge(win, wsDir);
  await createTaskViaComposer(win, { prompt, agent: 'claude-code' });
}

test('git workspace：两文件变更 → diff 呈现 → 文件级回滚/恢复 → 全部接受 → done，无自动 commit', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e24-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-wsg-'));

  // git 仓打底：hello.txt 已提交
  git(wsDir, ['init', '-q']);
  git(wsDir, ['config', 'user.email', 'e2e@example.com']);
  git(wsDir, ['config', 'user.name', 'e2e']);
  git(wsDir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(wsDir, 'hello.txt'), 'v1\n');
  git(wsDir, ['add', '-A']);
  git(wsDir, ['commit', '-q', '-m', 'base']);
  const headBefore = git(wsDir, ['rev-parse', 'HEAD']).trim();

  const script = [
    { action: 'expect_stdin', match: '改文件' },
    { action: 'write_file', path: 'hello.txt', content: 'v1\nv2 line added\n' },
    { action: 'write_file', path: 'new-file.txt', content: 'brand new\n' },
    { action: 'emit', event: { kind: 'text', text: '已修改两个文件。' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript(dataDir, script);
  try {
    await setupWorkspaceAndTask(app, wsDir, '改文件两处处');
    const win = (await app.windows())[0];
    // composer 发送即开跑（ticket #36）

    // turn_end → 捕获 → awaiting_review
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });

    // 「变更」tab：两文件入列（path + 状态徽标 + +N/-N）
    await win.getByTestId('inspector-tab-changes').click();
    await expect(win.getByTestId('change-row')).toHaveCount(2, { timeout: 10_000 });
    await expect(win.locator('[data-testid="change-row"][data-path="hello.txt"]')).toBeVisible();
    await expect(win.locator('[data-testid="change-row"][data-path="new-file.txt"]')).toBeVisible();
    const helloRow = win.locator('[data-testid="change-row"][data-path="hello.txt"]');
    await expect(helloRow).toHaveAttribute('data-status', 'pending');
    await expect(helloRow.getByTestId('change-stats')).toContainText('+1');
    await expect(helloRow.getByTestId('change-stats')).toContainText('-0');

    // 内嵌 diff：+绿/-红/上下文灰逐行呈现
    await helloRow.click();
    const diff = win.locator('[data-testid="change-diff"][data-path="hello.txt"]');
    await expect(diff).toBeVisible();
    await expect(diff.locator('[data-sign="add"]')).toHaveCount(1);
    await expect(diff.locator('[data-sign="add"]')).toContainText('v2 line added');
    await expect(diff.locator('[data-sign="ctx"]').first()).toContainText('v1');
    await expect(diff.locator('[data-sign="meta"]').first()).toContainText('diff --git');

    // 文件级回滚 hello.txt → 工作区还原 + 行变「已回滚」+ 出现「恢复」
    await helloRow.getByTestId('change-rollback').click();
    await expect(
      win.locator('[data-testid="change-row"][data-path="hello.txt"]'),
    ).toHaveAttribute('data-status', 'reverted', { timeout: 10_000 });
    expect(readFileSync(join(wsDir, 'hello.txt'), 'utf8')).toBe('v1\n');
    await expect(
      win.locator('[data-testid="change-restore"][data-path="hello.txt"]'),
    ).toBeVisible();

    // 恢复 → 改动回到工作区 + 行回「待复查」
    await win.locator('[data-testid="change-restore"][data-path="hello.txt"]').click();
    await expect(
      win.locator('[data-testid="change-row"][data-path="hello.txt"]'),
    ).toHaveAttribute('data-status', 'pending', { timeout: 10_000 });
    expect(readFileSync(join(wsDir, 'hello.txt'), 'utf8')).toBe('v1\nv2 line added\n');

    // 任务级全部接受 → done（状态机 awaiting_review → done）
    await win.getByTestId('changes-accept-all').click();
    await expect(win.getByTestId('detail-status-label')).toHaveText('完成', {
      timeout: 10_000,
    });
    await expect(
      win.locator('[data-testid="change-row"][data-path="new-file.txt"]'),
    ).toHaveAttribute('data-status', 'accepted');

    // 红线：不自动 commit、index 不变；改动留工作区（未提交形态）
    expect(git(wsDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    git(wsDir, ['diff', '--cached', '--quiet']); // 非零退出即失败
    const status = git(wsDir, ['status', '--porcelain']);
    expect(status).toContain(' M hello.txt');
    expect(status).toContain('?? new-file.txt');
  } finally {
    await app.close();
  }
});

test('非 git workspace：快照兜底复查 → 全部回滚 → done → 快照期内恢复', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e24n-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-wsn-'));

  const script = [
    { action: 'expect_stdin', match: '记笔记' },
    { action: 'write_file', path: 'notes.md', content: '# 笔记\n第一行\n' },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript(dataDir, script);
  try {
    await setupWorkspaceAndTask(app, wsDir, '记笔记到文件');
    const win = (await app.windows())[0];
    // composer 发送即开跑（ticket #36）

    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });
    await win.getByTestId('inspector-tab-changes').click();
    await expect(win.getByTestId('change-row')).toHaveCount(1, { timeout: 10_000 });
    const row = win.locator('[data-testid="change-row"][data-path="notes.md"]');
    await expect(row).toHaveAttribute('data-status', 'pending');
    // 快照来源同样自合成 unified diff（+ 行呈现）
    await row.click();
    await expect(
      win.locator('[data-testid="change-diff"][data-path="notes.md"] [data-sign="add"]').first(),
    ).toContainText('# 笔记');

    // 任务级全部回滚 → 新增文件从工作区消失 → done
    await win.getByTestId('changes-rollback-all').click();
    await expect(win.getByTestId('detail-status-label')).toHaveText('完成', {
      timeout: 10_000,
    });
    expect(existsSync(join(wsDir, 'notes.md'))).toBe(false);
    await expect(row).toHaveAttribute('data-status', 'reverted');

    // 快照兜底工件落位：rollback-backup 留有回滚前内容
    await expect
      .poll(
        () => {
          const snaps = join(dataDir, 'snapshots');
          if (!existsSync(snaps)) return false;
          const taskDirs = readdirSync(snaps);
          if (taskDirs.length === 0) return false;
          const backup = join(snaps, taskDirs[0], 'rollback-backup', 'notes.md');
          return existsSync(backup) && readFileSync(backup, 'utf8') === '# 笔记\n第一行\n';
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // 快照期保留（done 后）：已回滚改动仍可恢复
    await win.locator('[data-testid="change-restore"][data-path="notes.md"]').click();
    await expect(row).toHaveAttribute('data-status', 'pending', { timeout: 10_000 });
    expect(readFileSync(join(wsDir, 'notes.md'), 'utf8')).toBe('# 笔记\n第一行\n');
  } finally {
    await app.close();
  }
});
