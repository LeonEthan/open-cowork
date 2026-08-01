import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { addWorkspaceViaBridge, createTaskViaComposer } from './helpers';

/**
 * workspace 与任务管理（ticket #18）端到端：
 * 启动 → 添加 workspace（临时目录）→ 经首页 composer 建任务（ticket #36：
 * create+start 一步到位，fake agent 一轮跑完落 awaiting_review）→
 * 关窗 → 同一 OPEN_COWORK_DATA_DIR 重开 → workspace 与任务完整恢复。
 *
 * 说明：添加 workspace 的原生目录 dialog 无法被 Playwright 驱动，
 * 这里走桥 API addByPath 写入后 reload（与 dialog 路径共用同一 repo/IPC）；
 * 任务创建走真实 UI（composer）。workers=1，用 expect 自动等待，无裸 sleep。
 * ticket #36：发送即开跑——codex 经 OPEN_COWORK_CODEX_CLI 指向 fake harness
 * （与 agent-drivers.spec.ts 同夹具），一轮对话干净收尾。
 */

const FAKE_CODEX = join(process.cwd(), 'tests', 'fake-agent', 'bin', 'fake-codex');

test('workspace 与任务：创建 → 关窗重开后完整恢复', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e18-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  // fake codex 一轮对话脚本（发送即开跑：首轮用创建时的需求描述）
  const script = [
    { action: 'expect_stdin', match: 'hello world' },
    { action: 'emit', event: { kind: 'text', text: 'hello world 脚本已完成。' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];
  const scriptFile = join(dataDir, 'fake-script.jsonl');
  await writeFile(scriptFile, script.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  const launch = (): Promise<ElectronApplication> =>
    electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        OPEN_COWORK_DATA_DIR: dataDir,
        OPEN_COWORK_CODEX_CLI: FAKE_CODEX,
        FAKE_AGENT_SCRIPT: scriptFile,
      },
      timeout: 30_000,
    });

  // ── 第一次启动：添加 workspace + composer 建任务（发送即开跑）──
  let app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();

    // 添加 workspace（桥 API；原生 dialog 路径见 workspaces:pick-and-add）
    await addWorkspaceViaBridge(win, wsDir);
    // ticket #35：workspace 行 = chevron + 文件夹 icon + 名称（basename；全路径在 title）
    await expect(win.getByTestId('workspace-item').first()).toContainText(basename(wsDir));

    // ticket #36：经首页 composer 建任务——合并 picker 选 codex，发送即开跑
    await createTaskViaComposer(win, { prompt: '实现一个 hello world 脚本', agent: 'codex' });

    // 侧栏任务项：状态点 + 标题 + 元信息（一轮跑完 → awaiting_review）
    const item = win.getByTestId('task-item').first();
    await expect(item).toHaveAttribute('data-status', 'awaiting_review', { timeout: 15_000 });
    await expect(item).toContainText('实现一个 hello world 脚本');
    await expect(item.getByTestId('task-status-dot')).toHaveClass(/status-dot awaiting_review/);
    await expect(item).toContainText('Codex'); // agent 选择快照进元信息

    // 创建后自动选中：文档流呈现该任务的对话（用户消息 + agent 回复 + 状态行）
    await expect(win.getByTestId('document-flow')).toContainText('实现一个 hello world 脚本');
    await expect(win.getByTestId('document-flow')).toContainText('hello world 脚本已完成。', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('document-flow')).toContainText('待复查');
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
    await expect(item).toHaveAttribute('data-status', 'awaiting_review');
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
