import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { addWorkspaceViaBridge, createTaskViaComposer } from './helpers';

/**
 * 用量与 context 水位（ticket #27）端到端：
 * ① 挂 provider（models.dev 价目）的任务跑一轮带 usage 的对话 →
 *    文档流轮次灰字与侧栏任务 chip 出现且数值/口径正确（$0.06 · models.dev 价）；
 * ② 无 provider（订阅途径）+ 大 inputTokens 的 usage →
 *    轮次灰字标「订阅制·费用仅供参考」，水位环 >80% 出警告与「建议压缩上下文」。
 *
 * fake agent harness 经 OPEN_COWORK_CLAUDE_CLI 注入；等待全部用 expect 自动等待，
 * 无裸 sleep；数据目录 mkdtemp 隔离；env 剥离宿主 ANTHROPIC_/OPENAI_。
 */

const FAKE_CLI = join(process.cwd(), 'tests', 'fake-agent', 'cli.mjs');
const TEST_KEY = 'sk-e2e-usage-test-key-0001';

function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('OPENAI_')) continue;
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

async function launchWithScript(opts: {
  dataDir: string;
  script: unknown[];
}): Promise<ElectronApplication> {
  const scriptFile = join(opts.dataDir, 'fake-script.jsonl');
  await writeFile(scriptFile, opts.script.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return electron.launch({
    args: ['.'],
    env: {
      ...scrubbedEnv(),
      OPEN_COWORK_DATA_DIR: opts.dataDir,
      OPEN_COWORK_CLAUDE_CLI: FAKE_CLI,
      FAKE_AGENT_SCRIPT: scriptFile,
    },
    timeout: 30_000,
  });
}

/** 添加 workspace（经桥直给路径）并 reload 让侧栏见效（ticket #36：实现迁 helpers.ts） */
async function addWorkspace(app: ElectronApplication, wsDir: string): Promise<void> {
  const win = await app.firstWindow();
  await addWorkspaceViaBridge(win, wsDir);
}

test('① 带价目一轮对话：轮次灰字 + 任务 chip 数值与 models.dev 口径标注', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e27a-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));
  const script = [
    { action: 'expect_stdin', match: '写个函数' },
    { action: 'emit', event: { kind: 'text', text: '完成了。' } },
    {
      action: 'emit',
      event: {
        kind: 'turn_end',
        status: 'completed',
        usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 800, model: 'claude-sonnet-4-5' },
      },
    },
    { action: 'exit', code: 0 },
  ];
  const app = await launchWithScript({ dataDir, script });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();

    // 设置页添加 Anthropic 预设 provider（快照价目：sonnet $3/$15）
    await win.getByTestId('open-settings').click();
    await expect(win.getByTestId('settings-providers')).toBeVisible();
    await win.getByTestId('preset-add-anthropic').click();
    await win.getByTestId('preset-key-anthropic').fill(TEST_KEY);
    await win.getByTestId('preset-confirm-anthropic').click();
    await expect(win.getByTestId('provider-item')).toHaveCount(1);

    // workspace + 任务（provider=Anthropic，model=claude-sonnet-4-5）
    // ticket #36：首页 composer 合并 picker 选择；发送即开跑（create+start 一步到位）
    await addWorkspace(app, wsDir);
    await createTaskViaComposer(win, {
      prompt: '写个函数',
      agent: 'claude-code',
      provider: { label: 'Anthropic' },
      awaitModelValue: 'claude-sonnet-4-5',
      model: 'claude-sonnet-4-5',
    });

    // 开跑 → 等 awaiting_review（composer 发送即启动）
    await expect(win.getByTestId('task-item')).toHaveAttribute('data-status', 'awaiting_review');

    // 轮次灰字：reconcile 后带折算金额与口径（10000×$3 + 2000×$15 /1M = $0.06；缓存不折算）
    await expect(win.getByTestId('turn-usage')).toHaveText(
      '10.0k in / 2.0k out · $0.06 · models.dev 价',
    );
    await expect(win.getByTestId('turn-usage')).toHaveAttribute('data-pending', 'false');

    // 侧栏任务 chip：token 总量 + 折算金额
    await expect(win.getByTestId('task-usage-chip')).toHaveText('12.0k tokens · $0.06');

    // 水位环出现且未警告（(10000+800)/200000 = 5.4%）
    await expect(win.getByTestId('context-ring')).toBeVisible();
    await expect(win.getByTestId('context-ring')).toHaveAttribute('data-warn', 'false');
    await expect(win.getByTestId('context-ring-warning')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('② 订阅途径 + 大 inputTokens：灰字标「仅供参考」，水位环 >80% 出压缩建议', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e27b-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));
  const script = [
    { action: 'expect_stdin', match: '大上下文' },
    { action: 'emit', event: { kind: 'text', text: '读完了。' } },
    {
      action: 'emit',
      event: {
        kind: 'turn_end',
        status: 'completed',
        // 170_000 / 默认窗口 200_000（无 provider → per-agent 保守默认）= 85% > 80%
        usage: { inputTokens: 170_000, outputTokens: 500, model: 'claude-sonnet-4-5' },
      },
    },
    { action: 'exit', code: 0 },
  ];
  const app = await launchWithScript({ dataDir, script });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();

    await addWorkspace(app, wsDir);
    // ticket #36：不选 provider/model = 订阅途径（agent 自带登录态）；发送即开跑
    await createTaskViaComposer(win, { prompt: '大上下文任务', agent: 'claude-code' });

    await expect(win.getByTestId('task-item')).toHaveAttribute('data-status', 'awaiting_review');

    // 轮次灰字：订阅制口径（不折算金额）
    await expect(win.getByTestId('turn-usage')).toHaveText(
      '170.0k in / 500 out · 订阅制·费用仅供参考',
    );

    // 任务 chip：订阅标注
    await expect(win.getByTestId('task-usage-chip')).toHaveText('170.5k tokens · 订阅·仅供参考');

    // 水位环 >80%：警告态 + 压缩建议文案
    await expect(win.getByTestId('context-ring')).toHaveAttribute('data-warn', 'true');
    await expect(win.getByTestId('context-ring-warning')).toHaveText('建议压缩上下文');
  } finally {
    await app.close();
  }
});
