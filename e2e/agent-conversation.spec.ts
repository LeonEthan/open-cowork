import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * 单会话对话闭环（ticket #19）端到端：
 * fake agent harness 经 OPEN_COWORK_CLAUDE_CLI 注入（driver 读它），脚本驱动 wire 输出。
 *
 * 黄金路径：建任务 → 开始 → 流式 markdown / 工具极简行 / 思考折叠 →
 *   turn_end → awaiting_review → 追问一轮 → 再回到 awaiting_review → JSONL 旁路落盘。
 * 取消：运行中点取消 → cancelled。
 * 失败：脚本非零退出 → failed 横幅呈现原因 + 重试回 ready。
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

/** 添加 workspace + 经 UI 建任务（返回任务标题） */
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

test('对话闭环黄金路径：流式 markdown/工具行/思考折叠 → awaiting_review → 追问一轮', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e19-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  const script = [
    { action: 'expect_stdin', match: '打招呼' },
    { action: 'emit', event: { kind: 'thinking', text: '用户需要一个打招呼函数' } },
    {
      action: 'emit',
      event: {
        kind: 'text',
        text: '好的，这是**打招呼**函数：\n\n```ts\nfunction hello(name: string) {\n  return `hi ${name}`;\n}\n```',
        chunks: 3,
      },
    },
    { action: 'emit', event: { kind: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } } },
    { action: 'emit', event: { kind: 'tool_result', id: 'toolu_1', output: 'ok' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed', usage: { inputTokens: 42, outputTokens: 17 } } },
    { action: 'expect_stdin', match: '补充' },
    { action: 'emit', event: { kind: 'text', text: '补充说明：文档已涵盖。' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript({ dataDir, script });
  try {
    await setupWorkspaceAndTask(app, wsDir, '实现一个打招呼函数');
    const win = (await app.windows())[0];

    // 创建后自动选中：ready 态输入区为「开始」（首轮用创建时的需求描述）
    await expect(win.getByTestId('detail-status-label')).toHaveText('就绪');
    await win.getByTestId('send-button').click();

    // 流式 markdown：**打招呼** → <strong>；代码块经 Shiki/纯文本兜底呈现
    await expect(win.getByTestId('msg-assistant').first()).toContainText('好的，这是', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('msg-assistant').first().locator('strong')).toContainText('打招呼');
    await expect(win.getByTestId('msg-assistant').first().locator('.code-block')).toContainText(
      'function hello',
    );

    // 思考过程：左边线折叠区（默认折叠，summary 一行小字）
    const thinking = win.getByTestId('msg-thinking').first();
    await expect(thinking.locator('summary')).toContainText('思考过程');
    await expect(thinking).not.toHaveAttribute('open', '');

    // 工具调用极简行：icon + 名称 + 目标 + 状态（完成）
    const toolRow = win.getByTestId('tool-row').first();
    await expect(toolRow).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
    await expect(toolRow).toContainText('Bash');
    await expect(toolRow).toContainText('npm test');

    // 一轮结束 → 待复查（状态机：running → awaiting_review）
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('task-item').first()).toHaveAttribute(
      'data-status',
      'awaiting_review',
    );

    // 输入区 chip（读 task 行选择快照）
    await expect(win.getByTestId('composer-agent-chip')).toContainText('Claude Code');

    // 追问一轮（awaiting_review → running → awaiting_review）
    await win.getByTestId('composer-input').fill('补充一句说明');
    await win.getByTestId('send-button').click();
    await expect(win.getByTestId('msg-user').last()).toContainText('补充一句说明');
    await expect(win.getByTestId('msg-assistant').last()).toContainText('补充说明：文档已涵盖。', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });

    // JSONL 旁路：events/<taskId>/<sessionId>.jsonl 落盘，含收与发
    await expect
      .poll(
        () => {
          const eventsRoot = join(dataDir, 'events');
          if (!existsSync(eventsRoot)) return 0;
          const taskDirs = readdirSync(eventsRoot).filter((d) => d !== 'agent-processes.json');
          if (taskDirs.length === 0) return 0;
          const files = readdirSync(join(eventsRoot, taskDirs[0])).filter((f) =>
            f.endsWith('.jsonl'),
          );
          if (files.length === 0) return 0;
          const content = readFileSync(join(eventsRoot, taskDirs[0], files[0]), 'utf8');
          const lines = content.trim().split('\n').filter(Boolean);
          const hasIn = lines.some((l) => l.includes('"dir":"in"'));
          const hasOut = lines.some((l) => l.includes('"dir":"out"'));
          return hasIn && hasOut ? lines.length : 0;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test('取消：运行中点取消 → cancelled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e19c-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  const script = [
    { action: 'expect_stdin' },
    { action: 'emit', event: { kind: 'text', text: '开始长篇输出…' } },
    { action: 'sleep', ms: 60_000 },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript({ dataDir, script });
  try {
    await setupWorkspaceAndTask(app, wsDir, '写一个很长很长的故事');
    const win = (await app.windows())[0];

    await win.getByTestId('send-button').click();
    // 运行中：流式文本到达 + 取消键出现
    await expect(win.getByTestId('msg-assistant').first()).toContainText('开始长篇输出', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('cancel-button')).toBeVisible();
    await expect(win.getByTestId('detail-status-label')).toHaveText('运行中');

    await win.getByTestId('cancel-button').click();
    await expect(win.getByTestId('detail-status-label')).toHaveText('已取消', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('task-item').first()).toHaveAttribute('data-status', 'cancelled');
  } finally {
    await app.close();
  }
});

test('失败：agent 异常退出 → failed 呈现原因 + 重试回 ready', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e19f-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  const script = [
    { action: 'expect_stdin' },
    { action: 'emit', event: { kind: 'text', text: '跑到一半' } },
    { action: 'exit', code: 1 },
  ];

  const app = await launchWithScript({ dataDir, script });
  try {
    await setupWorkspaceAndTask(app, wsDir, '做一个会失败的任务');
    const win = (await app.windows())[0];

    await win.getByTestId('send-button').click();
    await expect(win.getByTestId('msg-assistant').first()).toContainText('跑到一半', {
      timeout: 15_000,
    });

    // failed 态：横幅呈现原因 + 状态点/标签
    await expect(win.getByTestId('detail-status-label')).toHaveText('失败', { timeout: 15_000 });
    const banner = win.getByTestId('failed-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('任务失败');
    await expect(win.getByTestId('task-item').first()).toHaveAttribute('data-status', 'failed');

    // 重试 → failed → ready，横幅消失、回到「开始」
    await win.getByTestId('retry-button').click();
    await expect(win.getByTestId('detail-status-label')).toHaveText('就绪');
    await expect(win.getByTestId('failed-banner')).toHaveCount(0);
    await expect(win.getByTestId('send-button')).toBeVisible();
  } finally {
    await app.close();
  }
});
