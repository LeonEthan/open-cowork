import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * pi driver（ticket #23）端到端（降级接入 + 静态审批策略）：
 * 1. pi 任务一轮对话：fake 脚本驱动 → 文档流渲染齐全 → turn_end 后 awaiting_review；
 * 2. 只读档：启动配置含禁写语义——driver 实际 spawn 的旗标经 fake 启动回显断言
 *    （--tools 允许清单无 bash/edit/write）。
 *
 * e2e 起 agent 走 OPEN_COWORK_PI_CLI 覆盖指到 fake harness 包装
 * （bin/fake-pi 锁定 pi-rpc wire 格式）；数据目录 mkdtemp 隔离；
 * 等待全部用 expect 自动等待 / expect.poll，无裸 sleep。
 */

const FAKE_PI = join(process.cwd(), 'tests', 'fake-agent', 'bin', 'fake-pi');

interface LaunchOpts {
  dataDir: string;
  script?: unknown[];
  /** 追加 env（如 FAKE_AGENT_STARTUP_LOG 启动回显路径） */
  extraEnv?: Record<string, string>;
}

async function launchApp(opts: LaunchOpts): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    ...process.env,
    OPEN_COWORK_DATA_DIR: opts.dataDir,
    OPEN_COWORK_PI_CLI: FAKE_PI,
    // PATH 不压（fake 包装 shebang 需要 node）；picker 里本机真实 agent 是否可见
    // 不影响用例——建任务一律显式 selectOption('pi')（env 覆盖保证可选）。
    ...(opts.extraEnv ?? {}),
  };
  if (opts.script) {
    const scriptFile = join(opts.dataDir, 'fake-script.jsonl');
    await writeFile(scriptFile, opts.script.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    env.FAKE_AGENT_SCRIPT = scriptFile;
  }
  return electron.launch({ args: ['.'], env, timeout: 30_000 });
}

/** 建 workspace + 建 pi 任务（创建后自动选中，就绪态） */
async function setupWorkspaceAndPiTask(
  win: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  wsDir: string,
  prompt: string,
): Promise<void> {
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByTestId('task-sidebar')).toBeVisible();
  await win.evaluate(async (p) => {
    await window.openCowork?.workspaces.addByPath(p);
  }, wsDir);
  await win.reload();
  await expect(win.getByTestId('workspace-item')).toHaveCount(1);
  await win.getByTestId('new-task-toggle').click();
  await win.getByTestId('task-prompt-input').fill(prompt);
  const select = win.getByTestId('task-agent-select');
  await expect(select).toBeEnabled({ timeout: 10_000 });
  await select.selectOption('pi');
  await win.getByTestId('task-create-submit').click();
  await expect(win.getByTestId('task-item')).toHaveCount(1);
  await expect(win.getByTestId('detail-status-label')).toHaveText('就绪');
}

test('pi 一轮对话：fake 脚本驱动 → 文档流渲染齐全 → awaiting_review', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e23a-'));
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
    await setupWorkspaceAndPiTask(win, wsDir, '实现一个打招呼函数');

    // 工具渲染用例在放权面跑：默认「自动」档无命中规则时等价只读面，
    // bash 会被静态策略（含纵深防御）拦截——该路径由 contract 用例覆盖。
    const modeChip = win.getByTestId('permission-mode-chip');
    await expect(modeChip).toHaveAttribute('data-mode', 'auto');
    await modeChip.click();
    await expect(modeChip).toHaveAttribute('data-mode', 'full');

    await win.getByTestId('send-button').click();

    // 流式 markdown 渲染齐全（与其他三家同一文档流）
    await expect(win.getByTestId('msg-assistant').first()).toContainText('好的，这是', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('msg-assistant').first().locator('strong')).toContainText('打招呼');

    // 思考过程折叠区
    const thinking = win.getByTestId('msg-thinking').first();
    await expect(thinking.locator('summary')).toContainText('思考过程');

    // 工具调用极简行：running → done（pi bash → 归一 Bash）
    const toolRow = win.getByTestId('tool-row').first();
    await expect(toolRow).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
    await expect(toolRow).toContainText('Bash');
    await expect(toolRow).toContainText('npm test');

    // 一轮结束 → 待复查；输入区 chip 显示 pi
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('task-item').first()).toHaveAttribute(
      'data-status',
      'awaiting_review',
    );
    await expect(win.getByTestId('composer-agent-chip')).toContainText('pi');
  } finally {
    await app.close();
  }
});

test('只读档：pi 启动旗标含禁写语义（fake 启动回显断言 --tools 无 bash/edit/write）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e23r-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));
  const startupLog = join(dataDir, 'startup.jsonl');

  const script = [
    { action: 'expect_stdin' },
    { action: 'emit', event: { kind: 'text', text: '只读模式回复' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchApp({
    dataDir,
    script,
    extraEnv: { FAKE_AGENT_STARTUP_LOG: startupLog },
  });
  try {
    const win = await app.firstWindow();
    await setupWorkspaceAndPiTask(win, wsDir, '只读档巡检');

    // 默认「自动」档 → 权限 chip 循环两次到「只读」（auto → full → readonly）
    const modeChip = win.getByTestId('permission-mode-chip');
    await expect(modeChip).toHaveAttribute('data-mode', 'auto');
    await modeChip.click();
    await expect(modeChip).toHaveAttribute('data-mode', 'full');
    await modeChip.click();
    await expect(modeChip).toHaveAttribute('data-mode', 'readonly');

    await win.getByTestId('send-button').click();
    // 待复查 = fake 已完整跑完一轮（启动回显必然已落盘）
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });

    // driver 实际 spawn 的旗标（经 fake 启动回显）：只读档 → --tools 读类清单
    const lines = (await readFile(startupLog, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as { args: string[] };
    expect(record.args).toContain('--mode');
    expect(record.args[record.args.indexOf('--mode') + 1]).toBe('rpc');
    expect(record.args).toContain('--no-session');
    expect(record.args).toContain('--tools');
    const tools = record.args[record.args.indexOf('--tools') + 1].split(',');
    expect(tools).toContain('read');
    expect(tools).toContain('grep');
    expect(tools).toContain('find');
    expect(tools).toContain('ls');
    // 禁写语义：写类与命令执行工具不在允许清单
    expect(tools).not.toContain('bash');
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('write');
  } finally {
    await app.close();
  }
});
