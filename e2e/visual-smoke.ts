import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';

/**
 * 视觉冒烟脚本（非测试）：启动真实应用，逐屏截图 Codex 对齐改造的关键面——
 * 首页（品牌行/hero/starter icon/composer 分支 chip）、权限弹层、终端抽屉。
 * 用法：npx playwright test e2e/visual-smoke.spec.ts --config playwright.visual.config.ts
 * 本文件直接以 ts 经 tsx 运行：npx tsx e2e/visual-smoke.ts
 */
const main = async (): Promise<void> => {
const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-visual-'));
const wsDir = await mkdtemp(join(tmpdir(), 'open-cowork-visual-ws-'));

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, OPEN_COWORK_DATA_DIR: dataDir },
  timeout: 30_000,
});

try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(800);

  // 无 workspace 首屏（Codex「What should we build?」+ Choose project 对照面）
  await win.screenshot({ path: '/tmp/oc-0-empty.png' });

  // 加一个 git workspace（分支 chip 需要）
  await win.evaluate(async (p) => {
    await window.openCowork?.workspaces.addByPath(p);
  }, process.cwd());
  await win.reload();
  await win.waitForTimeout(1200);
  await win.screenshot({ path: '/tmp/oc-1-home.png' });

  // 权限弹层
  await win.getByTestId('permission-mode-chip').click();
  await win.waitForTimeout(300);
  await win.screenshot({ path: '/tmp/oc-2-permission.png' });
  await win.keyboard.press('Escape');

  // 终端抽屉
  await win.keyboard.press('ControlOrMeta+T');
  await win.waitForTimeout(2500);
  await win.screenshot({ path: '/tmp/oc-3-terminal.png' });

  console.log('screenshots: /tmp/oc-1-home.png /tmp/oc-2-permission.png /tmp/oc-3-terminal.png');
  console.log('ws unused:', wsDir);
} finally {
  await app.close();
}
};

void main();
