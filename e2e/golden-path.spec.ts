import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { addWorkspaceViaBridge, createTaskViaComposer } from './helpers';

/**
 * E2E 黄金路径 smoke（ticket #29，第三道测试接缝收口）：
 * Playwright + Electron 起真实应用，一条用例走通主链路——
 * 添加 workspace → 创建任务（fake agent）→ 审批放行 → 复查 diff → 回滚。
 *
 * ① 主链路完整版（git workspace）：
 *    bridge 加 workspace（临时目录 git init）→ UI 建任务（claude + fake 脚本：
 *    text → permission_request(Write) → 批准后 write_file + tool_result →
 *    turn_end 带 usage）→ 文档流渲染断言 → 审批托盘 → ⌘1 放行（键盘）→
 *    fake 收到 allow（expectResponse wire 断言 + JSONL 旁路）→
 *    状态机 running→awaiting_approval→running→awaiting_review 沿途断言（状态点文案）→
 *    变更 tab 列表 + 内嵌 diff → 文件级回滚（工作区还原）→ 恢复 →
 *    任务级全部接受 → done；全程红线：不自动 commit。
 * ② 非 git workspace 快照路径简版：write_file → awaiting_review →
 *    快照 diff → 全部回滚 → done → 工作区还原。
 *
 * 防 flake：用例数个位数；等待全部 expect 自动等待 / expect.poll，测试侧无裸 sleep。
 * 「运行中」这类过渡态的断言窗口由 fake 脚本侧 sleep 节拍撑开（断言起点必是
 * 测试自己的动作：send 点击 / ⌘1 按键，窗口结束由脚本节拍决定，与渲染快慢无关）。
 * 数据目录 mkdtemp 隔离；fake 脚本为本 spec 内置夹具。
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

/** 添加 workspace（bridge 直给路径，原生 dialog 不可驱动）+ 经首页 composer 建任务并开跑（ticket #36） */
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

/** JSONL 旁路 events/<taskId>/<sessionId>.jsonl 全文（未落盘返回 ''） */
function readJsonlBypass(dataDir: string): string {
  const eventsRoot = join(dataDir, 'events');
  if (!existsSync(eventsRoot)) return '';
  const taskDirs = readdirSync(eventsRoot).filter((d) => d !== 'agent-processes.json');
  if (taskDirs.length === 0) return '';
  const files = readdirSync(join(eventsRoot, taskDirs[0])).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) return '';
  return readFileSync(join(eventsRoot, taskDirs[0], files[0]), 'utf8');
}

test('黄金路径：添加 workspace → 建任务 → ⌘1 放行 → diff 复查 → 回滚/恢复 → 全部接受 → done', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e29-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-wsg-'));

  // git 仓打底：hello.txt 已提交（黄金路径要求真实 git workspace）
  git(wsDir, ['init', '-q']);
  git(wsDir, ['config', 'user.email', 'e2e@example.com']);
  git(wsDir, ['config', 'user.name', 'e2e']);
  git(wsDir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(wsDir, 'hello.txt'), 'v1\n');
  git(wsDir, ['add', '-A']);
  git(wsDir, ['commit', '-q', '-m', 'base']);
  const headBefore = git(wsDir, ['rev-parse', 'HEAD']).trim();

  const script = [
    { action: 'expect_stdin', match: '打招呼' },
    { action: 'emit', event: { kind: 'text', text: '好的，我来更新 **hello.txt**。', chunks: 2 } },
    // 脚本侧节拍：撑开「运行中」断言窗口（审批请求晚 900ms 才发，与渲染快慢无关）
    { action: 'sleep', ms: 900 },
    { action: 'emit', event: { kind: 'tool_call', id: 'toolu_1', name: 'Write', input: { file_path: 'hello.txt' } } },
    {
      action: 'emit',
      event: {
        kind: 'permission_request',
        id: 'perm_1',
        toolName: 'Write',
        input: { file_path: 'hello.txt' },
        reason: '更新打招呼文件',
        // wire 级断言：⌘1 必须回 allow 且不回写权限（未命中脚本非零退出 → 任务 failed → 本用例失败）
        expectResponse: { behavior: 'allow', updatedPermissions: null },
      },
    },
    // 批准后同样撑开「运行中」窗口，再落盘真实变更
    { action: 'sleep', ms: 900 },
    { action: 'write_file', path: 'hello.txt', content: 'v1\nv2 golden\n' },
    { action: 'emit', event: { kind: 'tool_result', id: 'toolu_1', output: 'written' } },
    { action: 'emit', event: { kind: 'text', text: '文件已更新。' } },
    {
      action: 'emit',
      event: {
        kind: 'turn_end',
        status: 'completed',
        usage: { inputTokens: 1200, outputTokens: 300 },
      },
    },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript(dataDir, script);
  try {
    await setupWorkspaceAndTask(app, wsDir, '更新打招呼文件');
    const win = (await app.windows())[0];

    // ticket #36：composer 发送 = create+start 一步到位——创建后直接进 running
    // 状态机 ①：ready → running（断言起点 = composer 发送；脚本 900ms 节拍内状态不会翻走）
    await expect(win.getByTestId('detail-status-label')).toHaveText('运行中', {
      timeout: 15_000,
    });

    // 文档流渲染：流式 markdown（**hello.txt** → <strong>）
    const firstAssistant = win.getByTestId('msg-assistant').first();
    await expect(firstAssistant).toContainText('好的，我来更新', { timeout: 15_000 });
    await expect(firstAssistant.locator('strong')).toContainText('hello.txt');

    // 审批托盘出现：逐条聚焦 Write / 目标 / 理由
    const tray = win.getByTestId('approval-tray');
    await expect(tray).toBeVisible({ timeout: 15_000 });
    await expect(win.getByTestId('approval-current')).toContainText('Write');
    await expect(win.getByTestId('approval-target')).toContainText('hello.txt');
    await expect(win.getByTestId('approval-current')).toContainText('更新打招呼文件');

    // 状态机 ②：running → awaiting_approval（侧栏与详情行一致）
    await expect(win.getByTestId('detail-status-label')).toHaveText('待审批');
    await expect(win.getByTestId('task-item').first()).toHaveAttribute(
      'data-status',
      'awaiting_approval',
    );

    // ⌘1 放行（键盘事件；焦点在按钮上不在输入控件）
    await win.keyboard.press('Meta+1');

    // 状态机 ③：awaiting_approval → running（⌘1 后脚本还有 900ms 节拍才收尾）
    await expect(win.getByTestId('detail-status-label')).toHaveText('运行中', {
      timeout: 15_000,
    });

    // 托盘消失；决议回执落时间线；工具继续到完成
    await expect(tray).toHaveCount(0, { timeout: 15_000 });
    await expect(win.getByTestId('permission-row').first()).toContainText('已允许');
    await expect(win.getByTestId('tool-row').first()).toHaveAttribute('data-status', 'done', {
      timeout: 15_000,
    });

    // 状态机 ④：running → awaiting_review（turn_end 到达）
    await expect(win.getByTestId('msg-assistant').last()).toContainText('文件已更新。', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('task-item').first()).toHaveAttribute(
      'data-status',
      'awaiting_review',
    );

    // fake 确实收到 allow（JSONL 旁路双重断言；wire 级已由脚本 expectResponse 断言）
    await expect.poll(() => readJsonlBypass(dataDir), { timeout: 10_000 }).toContain('"behavior":"allow"');

    // 用量顺带断言（精确口径已由 #27 覆盖，这里只验链路呈现）
    await expect(win.getByTestId('turn-usage')).toContainText('in /');
    await expect(win.getByTestId('task-usage-chip')).toContainText('tokens');

    // 「变更」tab：hello.txt 入列（path + pending + +1/-0）
    await win.getByTestId('inspector-tab-changes').click();
    await expect(win.getByTestId('change-row')).toHaveCount(1, { timeout: 10_000 });
    const helloRow = win.locator('[data-testid="change-row"][data-path="hello.txt"]');
    await expect(helloRow).toBeVisible();
    await expect(helloRow).toHaveAttribute('data-status', 'pending');
    await expect(helloRow.getByTestId('change-stats')).toContainText('+1');
    await expect(helloRow.getByTestId('change-stats')).toContainText('-0');

    // 内嵌 diff：+ 行 / 上下文行逐行呈现
    await helloRow.click();
    const diff = win.locator('[data-testid="change-diff"][data-path="hello.txt"]');
    await expect(diff).toBeVisible();
    await expect(diff.locator('[data-sign="add"]')).toHaveCount(1);
    await expect(diff.locator('[data-sign="add"]')).toContainText('v2 golden');
    await expect(diff.locator('[data-sign="ctx"]').first()).toContainText('v1');

    // 文件级回滚 → 工作区还原 + 行变「已回滚」+ 出现「恢复」
    await helloRow.getByTestId('change-rollback').click();
    await expect(helloRow).toHaveAttribute('data-status', 'reverted', { timeout: 10_000 });
    expect(readFileSync(join(wsDir, 'hello.txt'), 'utf8')).toBe('v1\n');
    await expect(
      win.locator('[data-testid="change-restore"][data-path="hello.txt"]'),
    ).toBeVisible();

    // 恢复 → 改动回到工作区 + 行回「待复查」
    await win.locator('[data-testid="change-restore"][data-path="hello.txt"]').click();
    await expect(helloRow).toHaveAttribute('data-status', 'pending', { timeout: 10_000 });
    expect(readFileSync(join(wsDir, 'hello.txt'), 'utf8')).toBe('v1\nv2 golden\n');

    // 任务级全部接受 → done（状态机 awaiting_review → done）
    await win.getByTestId('changes-accept-all').click();
    await expect(win.getByTestId('detail-status-label')).toHaveText('完成', {
      timeout: 10_000,
    });
    await expect(helloRow).toHaveAttribute('data-status', 'accepted');
    await expect(win.getByTestId('task-item').first()).toHaveAttribute('data-status', 'done');

    // 红线：不自动 commit、index 不变；改动留工作区（未提交形态）
    expect(git(wsDir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    git(wsDir, ['diff', '--cached', '--quiet']); // 非零退出即失败
    expect(git(wsDir, ['status', '--porcelain'])).toContain(' M hello.txt');
  } finally {
    await app.close();
  }
});

test('黄金路径（非 git 简版）：快照兜底复查 → 全部回滚 → done → 工作区还原', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e29n-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-wsn-'));

  const script = [
    { action: 'expect_stdin', match: '记笔记' },
    { action: 'emit', event: { kind: 'text', text: '已写入笔记。' } },
    { action: 'write_file', path: 'notes.md', content: '# 黄金路径\n快照兜底\n' },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launchWithScript(dataDir, script);
  try {
    await setupWorkspaceAndTask(app, wsDir, '记笔记到文件');
    const win = (await app.windows())[0];

    // ticket #36：composer 发送即开跑——直接等 turn_end → 待复查
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });

    // 快照来源同样自合成 unified diff（+ 行呈现）
    await win.getByTestId('inspector-tab-changes').click();
    await expect(win.getByTestId('change-row')).toHaveCount(1, { timeout: 10_000 });
    const row = win.locator('[data-testid="change-row"][data-path="notes.md"]');
    await expect(row).toHaveAttribute('data-status', 'pending');
    await row.click();
    await expect(
      win.locator('[data-testid="change-diff"][data-path="notes.md"] [data-sign="add"]').first(),
    ).toContainText('# 黄金路径');

    // 任务级全部回滚 → 新增文件从工作区消失 → done
    await win.getByTestId('changes-rollback-all').click();
    await expect(win.getByTestId('detail-status-label')).toHaveText('完成', {
      timeout: 10_000,
    });
    expect(existsSync(join(wsDir, 'notes.md'))).toBe(false);
    await expect(row).toHaveAttribute('data-status', 'reverted');
  } finally {
    await app.close();
  }
});
