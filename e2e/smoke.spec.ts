import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * 启动冒烟（ticket #17）：build 后启动真实 Electron，断言
 * 三栏骨架 DOM、主题属性、utility MessageChannel demo、SQLite 落盘。
 * 数据目录用 OPEN_COWORK_DATA_DIR 指向临时目录，防污染真实数据。
 * ticket #33（§1.1 窗口 chrome 归零）：自定义顶栏废除——折叠开关在内容区
 * 左上角图标行（testid 不变）；主题切换与 utility 状态折进设置区。
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

    // 三栏骨架（§1）；自定义顶栏已废除（§1.1）
    await expect(win.getByTestId('task-sidebar')).toBeVisible();
    await expect(win.getByTestId('document-flow')).toBeVisible();
    await expect(win.getByTestId('inspector')).toBeVisible();
    await expect(win.locator('.topbar')).toHaveCount(0);

    // 主题属性合法（跟随系统解析为 light 或 dark，§6）
    const theme = await win.evaluate(() => document.documentElement.dataset.theme);
    expect(['light', 'dark']).toContain(theme);

    // 折叠开关居内容区左上角图标行（§1.1，功能不丢）
    await expect(win.getByTestId('toggle-sidebar')).toBeVisible();
    await expect(win.getByTestId('toggle-inspector')).toBeVisible();

    // utility 状态不再常驻主界面：折进设置区诊断区块（ticket #33）
    await win.getByTestId('open-settings').click();
    // renderer ⇄ utility MessageChannel：ping-pong（§架构1；#19 起为真实事件流通道）
    await expect(win.getByTestId('utility-status')).toContainText('pong', { timeout: 15_000 });

    // SQLite 在数据目录初始化
    await expect
      .poll(() => existsSync(join(dataDir, 'open-cowork.db')), { timeout: 10_000 })
      .toBe(true);

    // 主题切换经设置区外观区块（三态单选）：选与解析后主题相反的显式档，立即生效且记忆（§6）
    await win.getByTestId(theme === 'dark' ? 'theme-mode-light' : 'theme-mode-dark').click();
    const flipped = await win.evaluate(() => document.documentElement.dataset.theme);
    expect(flipped).not.toBe(theme);
    const stored = await win.evaluate(() => window.localStorage.getItem('open-cowork:ui'));
    expect(stored).toContain('"themeMode"');

    // 左右栏可折叠（§1；开关行在设置视图同样常驻）
    await win.getByTestId('toggle-sidebar').click();
    await expect(win.getByTestId('task-sidebar')).toHaveClass(/collapsed/);
    await win.getByTestId('toggle-inspector').click();
    await expect(win.getByTestId('inspector')).toHaveClass(/collapsed/);
  } finally {
    await app.close();
  }
});
