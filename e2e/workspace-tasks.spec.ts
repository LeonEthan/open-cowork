import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * workspace 与任务管理（ticket #18）端到端：
 * 启动 → 添加 workspace（临时目录）→ 经 UI 建任务（ready 落库）→
 * 关窗 → 同一 OPEN_COWORK_DATA_DIR 重开 → workspace 与任务完整恢复。
 *
 * 说明：添加 workspace 的原生目录 dialog 无法被 Playwright 驱动，
 * 这里走桥 API addByPath 写入后 reload（与 dialog 路径共用同一 repo/IPC）；
 * 任务创建走真实 UI 表单。workers=1，用 expect 自动等待，无裸 sleep。
 */
test('workspace 与任务：创建 → 关窗重开后完整恢复', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e18-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  const launch = (): Promise<ElectronApplication> =>
    electron.launch({
      args: ['.'],
      env: { ...process.env, OPEN_COWORK_DATA_DIR: dataDir },
      timeout: 30_000,
    });

  // ── 第一次启动：添加 workspace + 建任务 ──
  let app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();

    // 添加 workspace（桥 API；原生 dialog 路径见 workspaces:pick-and-add）
    await win.evaluate(async (p) => {
      await window.openCowork?.workspaces.addByPath(p);
    }, wsDir);
    await win.reload();
    // ticket #35：workspace 行 = chevron + 文件夹 icon + 名称（basename；全路径在 title）
    await expect(win.getByTestId('workspace-item')).toHaveCount(1);
    await expect(win.getByTestId('workspace-item').first()).toContainText(basename(wsDir));

    // 经 UI 表单建任务：需求描述 + agent/provider/model 占位 picker
    await win.getByTestId('new-task-toggle').click();
    await expect(win.getByTestId('new-task-form')).toBeVisible();
    await win.getByTestId('task-prompt-input').fill('实现一个 hello world 脚本');
    await win.getByTestId('task-agent-select').selectOption('codex');
    await win.getByTestId('task-create-submit').click();

    // 侧栏任务项：状态点 + 标题 + 元信息（六态之 ready）
    await expect(win.getByTestId('task-item')).toHaveCount(1);
    const item = win.getByTestId('task-item').first();
    await expect(item).toHaveAttribute('data-status', 'ready');
    await expect(item).toContainText('实现一个 hello world 脚本');
    await expect(item.getByTestId('task-status-dot')).toHaveClass(/status-dot ready/);
    await expect(item).toContainText('Codex'); // agent 选择快照进元信息

    // 创建后自动选中：文档流显示该任务的需求描述与状态占位
    await expect(win.getByTestId('document-flow')).toContainText('实现一个 hello world 脚本');
    await expect(win.getByTestId('document-flow')).toContainText('就绪');
  } finally {
    await app.close();
  }

  // ── 第二次启动（同一数据目录）：完整恢复 ──
  app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expect(win.getByTestId('workspace-item')).toHaveCount(1);
    await expect(win.getByTestId('workspace-item').first()).toContainText(basename(wsDir));

    await expect(win.getByTestId('task-item')).toHaveCount(1);
    const item = win.getByTestId('task-item').first();
    await expect(item).toHaveAttribute('data-status', 'ready');
    await expect(item).toContainText('实现一个 hello world 脚本');

    // ticket #35：workspace 分组折叠——折叠后任务行隐藏；折叠态经 ui store 持久化记忆
    await win.getByTestId('workspace-toggle').first().click();
    await expect(win.getByTestId('workspace-toggle').first()).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(win.getByTestId('task-item')).toHaveCount(0);
    await win.reload();
    await expect(win.getByTestId('workspace-toggle').first()).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(win.getByTestId('task-item')).toHaveCount(0);
    await win.getByTestId('workspace-toggle').first().click();
    await expect(win.getByTestId('task-item')).toHaveCount(1);

    // 重启后选中态为瞬态（未持久化）：点击任务项，文档流恢复呈现
    await win.getByTestId('task-item').first().click();
    await expect(win.getByTestId('document-flow')).toContainText('实现一个 hello world 脚本');
  } finally {
    await app.close();
  }
});
