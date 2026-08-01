import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * Codex + opencode driver（ticket #22）端到端：
 * 1. 会话 picker 按探测结果置灰/可选（PATH 探测与 OPEN_COWORK_*_CLI 注入双通道）；
 * 2. 选 codex 建任务 → fake 脚本一轮对话 → 文档流渲染齐全 → awaiting_review。
 *
 * e2e 起 agent 一律走 OPEN_COWORK_*_CLI 覆盖指到 fake harness 包装
 * （bin/fake-codex 锁定 codex-jsonrpc wire 格式）；数据目录 mkdtemp 隔离；
 * 等待全部用 expect 自动等待 / expect.poll，无裸 sleep。
 */

const FAKE_CLAUDE = join(process.cwd(), 'tests', 'fake-agent', 'cli.mjs');
const FAKE_CODEX = join(process.cwd(), 'tests', 'fake-agent', 'bin', 'fake-codex');
// #23：pi driver 已接入——picker 注入点与 driver executablePath 同源
const FAKE_PI = join(process.cwd(), 'tests', 'fake-agent', 'bin', 'fake-pi');

interface LaunchOpts {
  dataDir: string;
  script?: unknown[];
  /** 覆盖 PATH（picker 探测确定性：屏蔽本机真实 agent 二进制） */
  path?: string;
}

async function launchApp(opts: LaunchOpts): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    ...process.env,
    OPEN_COWORK_DATA_DIR: opts.dataDir,
    // 探测注入：claude/codex/pi 指向 fake（picker 应可选；opencode 无覆盖则「未安装」）
    OPEN_COWORK_CLAUDE_CLI: FAKE_CLAUDE,
    OPEN_COWORK_CODEX_CLI: FAKE_CODEX,
    OPEN_COWORK_PI_CLI: FAKE_PI,
    ...(opts.path ? { PATH: opts.path } : {}),
  };
  if (opts.script) {
    const scriptFile = join(opts.dataDir, 'fake-script.jsonl');
    await writeFile(scriptFile, opts.script.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    env.FAKE_AGENT_SCRIPT = scriptFile;
  }
  return electron.launch({ args: ['.'], env, timeout: 30_000 });
}

test('会话 picker 按探测结果列出四家：env 覆盖可选，未安装置灰', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e22p-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  // PATH 压到系统目录：屏蔽本机真实 codex/opencode/claude/pi 二进制（探测确定性）。
  // 此时 claude/codex/pi 经 env 覆盖「已安装」（#23 pi 已接入），opencode 无覆盖「未安装」。
  const app = await launchApp({ dataDir, path: '/usr/bin:/bin' });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();
    await win.evaluate(async (p) => {
      await window.openCowork?.workspaces.addByPath(p);
    }, wsDir);
    await win.reload();
    await expect(win.getByTestId('workspace-item')).toHaveCount(1);
    await win.getByTestId('new-task-toggle').click();

    const select = win.getByTestId('task-agent-select');
    // 探测完成前 select 禁用（「探测中…」）；完成后四家列出
    await expect(select).toBeEnabled({ timeout: 10_000 });
    const option = (value: string) => select.locator(`option[value="${value}"]`);

    // <option> 的 disabled 以属性断言（Playwright 的 toBeDisabled 不覆盖 option 元素）
    await expect(option('claude-code')).not.toHaveAttribute('disabled', '');
    await expect(option('codex')).not.toHaveAttribute('disabled', '');
    await expect(option('opencode')).toHaveAttribute('disabled', '');
    await expect(option('opencode')).toContainText('未安装');
    // #23：pi 不再是「即将支持」——env 覆盖探测到即可选
    await expect(option('pi')).not.toHaveAttribute('disabled', '');
    await expect(option('pi')).not.toContainText('即将支持');

    // 回填逻辑选中第一个可用 agent（catalog 序：claude-code）
    await expect(select).toHaveValue('claude-code');
    // 可改选 codex（已安装）
    await select.selectOption('codex');
    await expect(select).toHaveValue('codex');
    // #23：可改选 pi（已安装）
    await select.selectOption('pi');
    await expect(select).toHaveValue('pi');
  } finally {
    await app.close();
  }
});

test('codex 一轮对话：fake 脚本驱动 → 文档流渲染齐全 → awaiting_review', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e22c-'));
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
    { action: 'emit', event: { kind: 'tool_call', id: 'call_1', name: 'Bash', input: { command: 'npm test' } } },
    { action: 'emit', event: { kind: 'tool_result', id: 'call_1', output: 'ok' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed', usage: { inputTokens: 42, outputTokens: 17 } } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchApp({ dataDir, script });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();
    await win.evaluate(async (p) => {
      await window.openCowork?.workspaces.addByPath(p);
    }, wsDir);
    await win.reload();
    await expect(win.getByTestId('workspace-item')).toHaveCount(1);
    await win.getByTestId('new-task-toggle').click();
    await win.getByTestId('task-prompt-input').fill('实现一个打招呼函数');
    await win.getByTestId('task-agent-select').selectOption('codex');
    await win.getByTestId('task-create-submit').click();
    await expect(win.getByTestId('task-item')).toHaveCount(1);

    // 创建后自动选中：ready 态「开始」首轮
    await expect(win.getByTestId('detail-status-label')).toHaveText('就绪');
    await win.getByTestId('send-button').click();

    // 流式 markdown 渲染齐全（与 claude 路径同一文档流）
    await expect(win.getByTestId('msg-assistant').first()).toContainText('好的，这是', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('msg-assistant').first().locator('strong')).toContainText('打招呼');

    // 思考过程折叠区
    const thinking = win.getByTestId('msg-thinking').first();
    await expect(thinking.locator('summary')).toContainText('思考过程');

    // 工具调用极简行：running → done
    const toolRow = win.getByTestId('tool-row').first();
    await expect(toolRow).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
    await expect(toolRow).toContainText('Bash');
    await expect(toolRow).toContainText('npm test');

    // 一轮结束 → 待复查；输入区 chip 显示 Codex
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('task-item').first()).toHaveAttribute(
      'data-status',
      'awaiting_review',
    );
    await expect(win.getByTestId('composer-agent-chip')).toContainText('Codex');
  } finally {
    await app.close();
  }
});
