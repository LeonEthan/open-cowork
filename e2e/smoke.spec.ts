import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * 启动冒烟（ticket #17）：build 后启动真实 Electron，断言
 * 三栏骨架 DOM、主题属性、utility MessageChannel demo、SQLite 落盘。
 * 数据目录用 OPEN_COWORK_DATA_DIR 指向临时目录，防污染真实数据。
 */
test('smoke: 三栏骨架 + 主题 + utility 直连 + DB 初始化', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e-'));

  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OPEN_COWORK_DATA_DIR: dataDir },
    timeout: 30_000,
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 三栏骨架（§1）
    await expect(win.getByTestId('task-sidebar')).toBeVisible();
    await expect(win.getByTestId('document-flow')).toBeVisible();
    await expect(win.getByTestId('inspector')).toBeVisible();

    // 主题属性合法（跟随系统解析为 light 或 dark，§6）
    const theme = await win.evaluate(() => document.documentElement.dataset.theme);
    expect(['light', 'dark']).toContain(theme);

    // renderer ⇄ utility MessageChannel：ping-pong + 流式计数（§架构1）
    await expect(win.getByTestId('utility-status')).toContainText('pong', { timeout: 15_000 });
    await expect(win.getByTestId('utility-status')).toContainText('tick', { timeout: 15_000 });

    // SQLite 在数据目录初始化
    await expect
      .poll(() => existsSync(join(dataDir, 'open-cowork.db')), { timeout: 10_000 })
      .toBe(true);

    // 手动切换主题立即生效且被记忆（§6）
    await win.getByTestId('theme-toggle').click();
    const flipped = await win.evaluate(() => document.documentElement.dataset.theme);
    expect(flipped).not.toBe(theme);
    const stored = await win.evaluate(() => window.localStorage.getItem('open-cowork:ui'));
    expect(stored).toContain('"themeMode"');

    // 左右栏可折叠（§1）
    await win.getByTestId('toggle-sidebar').click();
    await expect(win.getByTestId('task-sidebar')).toHaveClass(/collapsed/);
    await win.getByTestId('toggle-inspector').click();
    await expect(win.getByTestId('inspector')).toHaveClass(/collapsed/);
  } finally {
    await app.close();
  }
});
