import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * Provider 与凭证（ticket #21）端到端：
 * ① 设置页添加预设 provider（填测试 key）→ DB 中无明文（safeStorage 真加密落盘）；
 *    模型清单展示上下文长度与价格（models.dev 内置快照兜底）。
 * ② 用该 provider 建任务（UI picker 实化）→ fake agent 启动 → env 注入闭环：
 *    密钥 + base URL 经 DriverStartParams.env 真实到达 agent 子进程
 *    （fake harness init 白名单回显 + FAKE_AGENT_ENV_DUMP 落盘断言）。
 *
 * 启动 env 剥离宿主的 ANTHROPIC_/OPENAI_ 变量——dump 里只可能见到测试注入值。
 */

const FAKE_CLI = join(process.cwd(), 'tests', 'fake-agent', 'cli.mjs');
const TEST_KEY = 'sk-e2e-provider-test-key-0001';

/** Node ABI 的 better-sqlite3 副本（vitest alias 同源；e2e 跑在 Node 上） */
const nodeRequire = createRequire(import.meta.url);
const Database = nodeRequire(
  join(process.cwd(), 'node_modules', 'better-sqlite3-node', 'lib', 'index.js'),
) as typeof import('better-sqlite3');

/** 剥离宿主 ANTHROPIC_/OPENAI_ 的干净 env（防真实密钥混入断言面） */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('OPENAI_')) continue;
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

async function launch(opts: {
  dataDir: string;
  script?: unknown[];
  envDump?: string;
}): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    ...scrubbedEnv(),
    OPEN_COWORK_DATA_DIR: opts.dataDir,
    OPEN_COWORK_CLAUDE_CLI: FAKE_CLI,
  };
  if (opts.script) {
    const scriptFile = join(opts.dataDir, 'fake-script.jsonl');
    await writeFile(scriptFile, opts.script.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    env.FAKE_AGENT_SCRIPT = scriptFile;
  }
  if (opts.envDump) env.FAKE_AGENT_ENV_DUMP = opts.envDump;
  return electron.launch({ args: ['.'], env, timeout: 30_000 });
}

test('① 添加预设 provider：safeStorage 加密落盘，DB 无明文；模型清单展示上下文与价格', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e21a-'));
  const app = await launch({ dataDir });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();

    // 设置页 → 预设 DeepSeek → 填测试 key 添加
    await win.getByTestId('open-settings').click();
    await expect(win.getByTestId('settings-providers')).toBeVisible();
    await win.getByTestId('preset-add-deepseek').click();
    await win.getByTestId('preset-key-deepseek').fill(TEST_KEY);
    await win.getByTestId('preset-confirm-deepseek').click();

    // 已配置列表出现；密钥只显固定掩码，页面任何位置无明文
    const item = win.getByTestId('provider-item').first();
    await expect(item).toBeVisible();
    await expect(item.getByTestId('provider-key-masked')).toContainText('••••••••');
    await expect(win.locator('body')).not.toContainText(TEST_KEY);

    // 模型清单：静态预设兜底 + models.dev 内置快照元数据（上下文 + 价格）
    await item.getByTestId('provider-models-toggle').click();
    await expect(win.getByTestId('provider-model-row')).toHaveCount(2);
    const table = win.getByTestId('provider-models-table');
    await expect(table).toContainText('deepseek-chat');
    await expect(table).toContainText('128k'); // 上下文长度（快照）
    await expect(table).toContainText('$0.28'); // 输入价 / 1M（快照）

    // DB 断言：加密落盘、明文不出现在任何列
    await expect
      .poll(
        () => {
          const dbFile = join(dataDir, 'open-cowork.db');
          if (!existsSync(dbFile)) return null;
          const db = new Database(dbFile, { readonly: true });
          try {
            return db.prepare('SELECT * FROM providers').all() as Record<string, unknown>[];
          } finally {
            db.close();
          }
        },
        { timeout: 10_000 },
      )
      .toSatisfy((rows: Record<string, unknown>[] | null) => {
        if (!rows || rows.length !== 1) return false;
        const row = rows[0];
        if (row.name !== 'DeepSeek' || row.kind !== 'preset' || row.preset_id !== 'deepseek') {
          return false;
        }
        if (row.protocol !== 'anthropic' || row.base_url !== 'https://api.deepseek.com/anthropic') {
          return false;
        }
        const cipher = row.encrypted_api_key;
        if (typeof cipher !== 'string' || cipher.length === 0) return false; // safeStorage 已加密
        // 明文（及其片段）不出现在行的任何文本列
        for (const value of Object.values(row)) {
          if (typeof value === 'string' && (value.includes(TEST_KEY) || value.includes('sk-e2e'))) {
            return false;
          }
        }
        return true;
      });
  } finally {
    await app.close();
  }
});

test('② 用该 provider 建任务跑通一轮：env 注入到达 agent 进程（密钥 + base URL）', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e21b-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-ws-'));
  const envDump = join(dataDir, 'env-dump.json');

  const script = [
    { action: 'expect_stdin', match: 'ping' },
    { action: 'emit', event: { kind: 'text', text: 'pong：provider 注入链路应答' } },
    { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
    { action: 'exit', code: 0 },
  ];

  const app = await launch({ dataDir, script, envDump });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.getByTestId('task-sidebar')).toBeVisible();

    // 桥接添加 workspace + deepseek 预设 provider（UI 添加路径已被 ① 覆盖）
    const providerId = await win.evaluate(async (key) => {
      const row = await window.openCowork!.providers.addPreset({ presetId: 'deepseek', apiKey: key });
      return row.id;
    }, TEST_KEY);
    await win.evaluate(async (p) => {
      await window.openCowork!.workspaces.addByPath(p);
    }, wsDir);
    await win.reload();
    await expect(win.getByTestId('workspace-item')).toHaveCount(1);

    // 新建任务表单：picker 实化——provider 下拉选中 DeepSeek，model 下拉加载其清单
    await win.getByTestId('new-task-toggle').click();
    await win.getByTestId('task-prompt-input').fill('ping 一轮对话');
    await win.getByTestId('task-agent-select').selectOption('claude-code');
    await win.getByTestId('task-provider-select').selectOption(providerId);
    await expect(win.getByTestId('task-model-select').locator('option')).toHaveCount(3, {
      timeout: 10_000,
    }); // 默认项 + deepseek-chat/reasoner
    await win.getByTestId('task-model-select').selectOption('deepseek-chat');
    await win.getByTestId('task-create-submit').click();
    await expect(win.getByTestId('task-item')).toHaveCount(1);

    // 输入区 chip 联动真实值（provider + model）
    await expect(win.getByTestId('composer-provider-chip')).toContainText('DeepSeek');
    await expect(win.getByTestId('composer-model-chip')).toContainText('deepseek-chat');

    // 开跑一轮：fake agent 应答 → 待复查
    await win.getByTestId('send-button').click();
    await expect(win.getByTestId('msg-assistant').first()).toContainText('pong', {
      timeout: 15_000,
    });
    await expect(win.getByTestId('detail-status-label')).toHaveText('待复查', {
      timeout: 15_000,
    });

    // env 注入闭环断言：密钥 + base URL 真实到达 agent 子进程
    await expect
      .poll(
        () => {
          if (!existsSync(envDump)) return null;
          try {
            return JSON.parse(readFileSync(envDump, 'utf8')) as Record<string, string>;
          } catch {
            return null;
          }
        },
        { timeout: 10_000 },
      )
      .toEqual({
        ANTHROPIC_AUTH_TOKEN: TEST_KEY,
        ANTHROPIC_API_KEY: TEST_KEY,
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      });

    // 密钥不泄漏进持久化面：DB 消息与 JSONL 旁路里无测试密钥
    const db = new Database(join(dataDir, 'open-cowork.db'), { readonly: true });
    try {
      const msgs = db.prepare('SELECT content FROM messages').all() as { content: string }[];
      for (const m of msgs) expect(m.content).not.toContain(TEST_KEY);
    } finally {
      db.close();
    }
  } finally {
    await app.close();
  }
});
