import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * Agent 探测、引导与修复 + 自定义 ACP（ticket #26）端到端：
 * 1. PATH 隔离（无一家 agent 可装）→ 侧栏横幅出现 → 设置卡片（徽标/安装命令复制/探测日志）
 *    → 逐家路径修复重验证 → 横幅消失；
 * 2. 注册自定义 ACP agent（fake cli.mjs --format acp-jsonrpc）→ picker 可选 → 一轮对话跑通。
 *
 * 隔离口径：数据目录 mkdtemp OPEN_COWORK_DATA_DIR；测试 1 另压 PATH + 假 HOME
 * （认证启发式确定性）；等待全部用 expect 自动等待 / expect.poll，无裸 sleep。
 */

const FAKE_CLAUDE = join(process.cwd(), 'tests', 'fake-agent', 'cli.mjs');
const FAKE_CODEX = join(process.cwd(), 'tests', 'fake-agent', 'bin', 'fake-codex');
const FAKE_OPENCODE = join(process.cwd(), 'tests', 'fake-agent', 'bin', 'fake-opencode');
const FAKE_ACP = join(process.cwd(), 'tests', 'fake-agent', 'bin', 'fake-acp');

async function addWorkspaceAndReload(app: ElectronApplication, wsDir: string): Promise<void> {
  const win = await app.firstWindow();
  await win.evaluate(async (p) => {
    await window.openCowork?.workspaces.addByPath(p);
  }, wsDir);
  await win.reload();
  await expect(win.getByTestId('workspace-item')).toHaveCount(1);
}

test('横幅：未安装出现 → 设置卡片 → 路径修复重验证 → 横幅消失', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e26a-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'open-cowork-home-'));

  // PATH 压到系统目录（四家全「未安装」）；假 HOME + 哑密钥 env：
  // 修复后认证启发式经 env 命中（已认证），否则横幅因「未认证」不消失。
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OPEN_COWORK_DATA_DIR: dataDir,
      PATH: '/usr/bin:/bin',
      HOME: fakeHome,
      ANTHROPIC_API_KEY: 'e2e-dummy',
      OPENAI_API_KEY: 'e2e-dummy',
    },
    timeout: 30_000,
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();
    await addWorkspaceAndReload(app, wsDir);

    // 横幅出现（四家未安装）
    const banner = win.getByTestId('agent-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('未安装');

    // 「前往设置」锚点 → 设置页 Agent 卡片
    await win.getByTestId('agent-banner-settings').click();
    await expect(win.getByTestId('settings-agents')).toBeVisible();

    // 卡片信息完整：名称 + 状态徽标 + 能力徽标 + 安装命令 chip
    const codexCard = win.getByTestId('agent-card-codex');
    await expect(codexCard).toBeVisible();
    await expect(codexCard).toContainText('Codex');
    await expect(win.getByTestId('agent-status-codex')).toHaveText('未安装');
    await expect(codexCard.locator('.agent-cap').first()).toContainText('审批');
    await expect(win.getByTestId('agent-install-cmd-codex')).toContainText(
      'npm install -g @openai/codex',
    );

    // 安装命令一键复制
    await win.getByTestId('agent-install-copy-codex').click();
    await expect(win.getByTestId('agent-install-copy-codex')).toHaveText('已复制');

    // 探测日志折叠区可查看（初始 PATH 扫描记录）
    await win.getByTestId('agent-probe-log-codex').locator('summary').click();
    await expect(win.getByTestId('agent-probe-log-codex').locator('pre')).toContainText('codex');

    // 逐家路径修复（验证并保存 → 徽标转「已安装」）
    const repairs: Record<string, string> = {
      codex: FAKE_CODEX,
      'claude-code': FAKE_CLAUDE,
      opencode: FAKE_OPENCODE,
      pi: FAKE_ACP,
    };
    for (const [id, path] of Object.entries(repairs)) {
      await win.getByTestId(`agent-repair-input-${id}`).fill(path);
      await win.getByTestId(`agent-repair-save-${id}`).click();
      await expect(win.getByTestId(`agent-repair-feedback-${id}`)).toContainText('验证通过', {
        timeout: 10_000,
      });
      await expect(win.getByTestId(`agent-status-${id}`)).toContainText('已安装', {
        timeout: 10_000,
      });
    }

    // 全部健康（已安装 + 已认证）→ 横幅消失
    await expect(win.getByTestId('agent-banner')).toHaveCount(0, { timeout: 10_000 });

    // 注册一个命令不可用的自定义 agent → 卡片「未安装」→ 横幅再现 → picker 置灰
    // （AC：picker 按探测置灰同样覆盖自定义项；自定义项也进横幅口径）
    await win.getByTestId('custom-agent-form-toggle').click();
    await win.getByTestId('custom-agent-name').fill('broken-acp');
    await win.getByTestId('custom-agent-command').fill('/gone/broken-acp');
    await win.getByTestId('custom-agent-submit').click();
    await expect(win.locator('[data-custom-id]')).toHaveCount(1, { timeout: 15_000 });
    await expect(win.locator('[data-custom-id] .agent-badge')).toContainText('未安装');
    await expect(win.getByTestId('agent-banner')).toBeVisible({ timeout: 10_000 });

    await win.getByTestId('open-settings').click(); // 回主界面
    await win.getByTestId('new-task-toggle').click();
    const select = win.getByTestId('task-agent-select');
    await expect(select).toBeEnabled({ timeout: 10_000 });
    const customOption = select.locator('option[data-agent-id^="custom:"]');
    await expect(customOption).toHaveCount(1);
    await expect(customOption).toHaveAttribute('disabled', '');
    await expect(customOption).toContainText('未安装');
    // 修复过的内置四家保持可选
    await expect(select.locator('option[value="codex"]')).not.toHaveAttribute('disabled', '');
  } finally {
    await app.close();
  }
});

test('自定义 ACP agent：注册 → picker 可选 → 一轮对话跑通', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e26b-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));

  const script = [
    { action: 'expect_stdin', match: '打招呼' },
    {
      action: 'emit',
      event: { kind: 'text', text: '好的，这是**打招呼**函数。', chunks: 2 },
    },
    { action: 'emit', event: { kind: 'tool_call', id: 'call_1', name: 'Bash', input: { command: 'npm test' } } },
    { action: 'emit', event: { kind: 'tool_result', id: 'call_1', output: 'ok' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed', usage: { inputTokens: 5, outputTokens: 7 } } },
    { action: 'exit', code: 0 },
  ];
  const scriptFile = join(dataDir, 'acp-script.jsonl');
  await writeFile(scriptFile, script.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  // 常规 PATH（fake-acp 经 shebang 需要 node）；脚本路径走注册表单的 env 字段注入
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OPEN_COWORK_DATA_DIR: dataDir },
    timeout: 30_000,
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();
    await addWorkspaceAndReload(app, wsDir);

    // 设置页注册自定义 ACP agent（命令 = fake-acp 包装；env 携带脚本路径）
    await win.getByTestId('open-settings').click();
    await expect(win.getByTestId('settings-agents')).toBeVisible();
    await win.getByTestId('custom-agent-form-toggle').click();
    await win.getByTestId('custom-agent-name').fill('fake-acp-agent');
    await win.getByTestId('custom-agent-command').fill(FAKE_ACP);
    await win.getByTestId('custom-agent-env').fill(`FAKE_AGENT_SCRIPT=${scriptFile}`);
    await win.getByTestId('custom-agent-submit').click();
    const customCard = win.locator('[data-custom-id]');
    await expect(customCard).toHaveCount(1, { timeout: 15_000 });
    await expect(customCard.locator('.agent-badge')).toContainText('已安装', { timeout: 15_000 });

    // 回到主界面建任务：picker 中自定义 agent 可选（未置灰）
    await win.getByTestId('open-settings').click();
    await win.getByTestId('new-task-toggle').click();
    const select = win.getByTestId('task-agent-select');
    await expect(select).toBeEnabled({ timeout: 10_000 });
    const customOption = select.locator('option[data-agent-id^="custom:"]');
    await expect(customOption).toHaveCount(1);
    await expect(customOption).not.toHaveAttribute('disabled', '');
    await expect(customOption).toContainText('fake-acp-agent');
    const customValue = await customOption.getAttribute('value');
    await win.getByTestId('task-prompt-input').fill('实现一个打招呼函数');
    await select.selectOption(customValue!);
    await win.getByTestId('task-create-submit').click();
    await expect(win.getByTestId('task-item')).toHaveCount(1);

    // 开跑：ACP 握手 → 一轮对话 → 文档流渲染 → 待复查
    await expect(win.getByTestId('detail-status-label')).toHaveText('就绪');
    await win.getByTestId('send-button').click();
    await expect(win.getByTestId('msg-assistant').first()).toContainText('好的，这是', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('msg-assistant').first().locator('strong')).toContainText('打招呼');
    const toolRow = win.getByTestId('tool-row').first();
    await expect(toolRow).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
    await expect(toolRow).toContainText('npm test');
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', { timeout: 15_000 });
    // 自定义名贯穿：输入区 chip 显示注册名（非 custom:<uuid>）
    await expect(win.getByTestId('composer-agent-chip')).toContainText('fake-acp-agent');
  } finally {
    await app.close();
  }
});
