import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * 权限审批流（ticket #20）端到端：fake agent 发 permission_request →
 * 底部审批托盘逐条聚焦 → ⌘1/⌘2/⌘3 键盘决议 → 决议回传 agent（wire 级经
 * fake 脚本 expectResponse + JSONL 旁路双重断言）。
 *
 * 覆盖（票面指定三条，防 flake 不再加）：
 * 1. ⌘1 批准一次：托盘出现 → 状态 running→awaiting_approval→running → 工具继续 → 待复查；
 * 2. 两条并发：排队预览可见 → 逐条处理不遗漏；
 * 3. ⌘3 附理由拒绝：fake 收到 deny+理由（expectResponse + JSONL 断言）。
 *
 * 等待全部用 expect 自动等待 / expect.poll，无裸 sleep；数据目录 mkdtemp 隔离。
 */

const FAKE_CLI = join(process.cwd(), 'tests', 'fake-agent', 'cli.mjs');

interface LaunchOpts {
  dataDir: string;
  script: unknown[];
}

async function launchWithScript(opts: LaunchOpts): Promise<ElectronApplication> {
  const scriptFile = join(opts.dataDir, 'fake-script.jsonl');
  await writeFile(scriptFile, opts.script.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPEN_COWORK_DATA_DIR: opts.dataDir,
      OPEN_COWORK_CLAUDE_CLI: FAKE_CLI,
      FAKE_AGENT_SCRIPT: scriptFile,
    },
    timeout: 30_000,
  });
}

/** 添加 workspace + 经 UI 建任务（与 agent-conversation.spec.ts 同辅助，防耦复制） */
async function setupWorkspaceAndTask(
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
  await win.getByTestId('task-create-submit').click();
  await expect(win.getByTestId('task-item')).toHaveCount(1);
}

test('⌘1 批准一次：托盘出现 → awaiting_approval → 批准后工具继续 → 待复查', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e20a-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  const script = [
    { action: 'expect_stdin', match: '装依赖' },
    {
      action: 'emit',
      event: { kind: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'npm install -D eslint' } },
    },
    {
      action: 'emit',
      event: {
        kind: 'permission_request',
        id: 'perm_1',
        toolName: 'Bash',
        input: { command: 'npm install -D eslint' },
        reason: '安装开发依赖',
        // wire 级断言：⌘1 必须回 allow 且不回写权限
        expectResponse: { behavior: 'allow', updatedPermissions: null },
      },
    },
    { action: 'emit', event: { kind: 'tool_result', id: 'toolu_1', output: 'added 1 package' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript({ dataDir, script });
  try {
    await setupWorkspaceAndTask(app, wsDir, '帮我给项目装依赖');
    const win = (await app.windows())[0];

    await win.getByTestId('send-button').click();

    // 托盘出现：逐条聚焦当前请求（工具/目标/理由），排队预览为空
    const tray = win.getByTestId('approval-tray');
    await expect(tray).toBeVisible({ timeout: 15_000 });
    const current = win.getByTestId('approval-current');
    await expect(current).toContainText('Bash');
    await expect(win.getByTestId('approval-target')).toContainText('npm install -D eslint');
    await expect(current).toContainText('安装开发依赖');
    await expect(win.getByTestId('approval-queue')).toHaveCount(0);

    // 状态迁移：running → awaiting_approval（侧栏与详情行一致）
    await expect(win.getByTestId('detail-status-label')).toHaveText('待审批');
    await expect(win.getByTestId('task-item').first()).toHaveAttribute(
      'data-status',
      'awaiting_approval',
    );

    // ⌘1 批准一次（键盘优先；焦点在按钮上不在输入控件）
    await win.keyboard.press('Meta+1');

    // 托盘消失；决议回执落时间线；工具继续到完成
    await expect(tray).toHaveCount(0, { timeout: 15_000 });
    await expect(win.getByTestId('permission-row').first()).toContainText('已允许');
    await expect(win.getByTestId('tool-row').first()).toHaveAttribute('data-status', 'done', {
      timeout: 15_000,
    });

    // awaiting_approval → running →（turn_end）→ awaiting_review
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('task-item').first()).toHaveAttribute(
      'data-status',
      'awaiting_review',
    );
  } finally {
    await app.close();
  }
});

test('两条并发审批：排队预览可见 → 逐条 ⌘1 处理不遗漏', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e20b-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  const script = [
    { action: 'expect_stdin' },
    {
      action: 'emit',
      event: { kind: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'npm install -D eslint' } },
    },
    // detach：perm_1 发射后不阻塞脚本——perm_2 紧随其后，制造并发 pending
    {
      action: 'emit',
      event: {
        kind: 'permission_request',
        id: 'perm_1',
        toolName: 'Bash',
        input: { command: 'npm install -D eslint' },
        reason: '安装开发依赖',
        expectResponse: { behavior: 'allow', updatedPermissions: null },
      },
      detach: true,
    },
    {
      action: 'emit',
      event: { kind: 'tool_call', id: 'toolu_2', name: 'Write', input: { file_path: '.eslintrc.json' } },
    },
    {
      action: 'emit',
      event: {
        kind: 'permission_request',
        id: 'perm_2',
        toolName: 'Write',
        input: { file_path: '.eslintrc.json' },
        reason: '创建配置文件',
        expectResponse: { behavior: 'allow', updatedPermissions: null },
      },
    },
    { action: 'emit', event: { kind: 'tool_result', id: 'toolu_1', output: 'ok' } },
    { action: 'emit', event: { kind: 'tool_result', id: 'toolu_2', output: 'written' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript({ dataDir, script });
  try {
    await setupWorkspaceAndTask(app, wsDir, '装依赖并创建配置文件');
    const win = (await app.windows())[0];

    await win.getByTestId('send-button').click();

    // 两条并发：计数 2，当前聚焦首条（到达序），排队预览可扫读第二条
    const tray = win.getByTestId('approval-tray');
    await expect(tray).toBeVisible({ timeout: 15_000 });
    await expect(tray.locator('.approval-count')).toHaveText('2');
    await expect(win.getByTestId('approval-current')).toContainText('Bash');
    await expect(win.getByTestId('approval-queue')).toBeVisible();
    await expect(win.getByTestId('approval-queue-item')).toHaveCount(1);
    await expect(win.getByTestId('approval-queue-item').first()).toContainText('Write');

    // 逐条处理：第一条 ⌘1 后第二条成为焦点（队列清空）
    await win.keyboard.press('Meta+1');
    await expect(win.getByTestId('approval-current')).toContainText('Write', { timeout: 15_000 });
    await expect(win.getByTestId('approval-queue')).toHaveCount(0);

    // 第二条 ⌘1 后托盘消失、两条回执都落时间线，轮次完成
    await win.keyboard.press('Meta+1');
    await expect(tray).toHaveCount(0, { timeout: 15_000 });
    const rows = win.getByTestId('permission-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('已允许');
    await expect(rows.nth(1)).toContainText('已允许');
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});

test('⌘3 附理由拒绝：理由随 deny 回传 agent（wire + JSONL 双断言）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e20c-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  const script = [
    { action: 'expect_stdin' },
    {
      action: 'emit',
      event: {
        kind: 'permission_request',
        id: 'perm_1',
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        reason: '删除构建产物',
        // wire 级断言：agent 实际收到 deny + 用户理由
        expectResponse: { behavior: 'deny', message: '太危险，不许删' },
      },
    },
    { action: 'emit', event: { kind: 'text', text: '好的，已放弃删除操作。' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript({ dataDir, script });
  try {
    await setupWorkspaceAndTask(app, wsDir, '清理构建产物');
    const win = (await app.windows())[0];

    await win.getByTestId('send-button').click();

    const tray = win.getByTestId('approval-tray');
    await expect(tray).toBeVisible({ timeout: 15_000 });

    // ⌘3 展开拒绝理由输入 → 填理由 → 确认拒绝
    await win.keyboard.press('Meta+3');
    const reasonInput = win.getByTestId('deny-reason-input');
    await expect(reasonInput).toBeVisible();
    await reasonInput.fill('太危险，不许删');
    await win.getByTestId('deny-confirm').click();

    // 托盘消失；时间线呈现已拒绝；轮次照常完成（agent 收到反馈后放弃）
    await expect(tray).toHaveCount(0, { timeout: 15_000 });
    await expect(win.getByTestId('permission-row').first()).toContainText('已拒绝');
    await expect(win.getByTestId('msg-assistant').last()).toContainText('已放弃删除操作', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });

    // JSONL 旁路：permission-respond 入向指令含 deny + 理由（审计链完整）
    await expect
      .poll(
        () => {
          const eventsRoot = join(dataDir, 'events');
          if (!existsSync(eventsRoot)) return false;
          const taskDirs = readdirSync(eventsRoot).filter((d) => d !== 'agent-processes.json');
          if (taskDirs.length === 0) return false;
          const files = readdirSync(join(eventsRoot, taskDirs[0])).filter((f) =>
            f.endsWith('.jsonl'),
          );
          if (files.length === 0) return false;
          const content = readFileSync(join(eventsRoot, taskDirs[0], files[0]), 'utf8');
          return (
            content.includes('"kind":"permission-respond"') &&
            content.includes('"behavior":"deny"') &&
            content.includes('太危险，不许删')
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});
