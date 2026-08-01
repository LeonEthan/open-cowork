import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * 内置终端 tab（ticket #28）e2e：开 tab → 等 shell 就绪 → 键入 echo 命令 →
 * 断言 xterm buffer 出现「只有 shell 真执行才会产生」的回显。
 * 命令特意让本地回显与求值结果不同：键入 echo oc$(echo inner)done，
 * 回明显示原始命令，而 ocinnerdone 只会在 shell 执行后出现（zsh/bash/fish 均支持 $(...)）。
 */
test('terminal tab: shell 就绪后键入命令有执行回显', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e-term-'));

  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OPEN_COWORK_DATA_DIR: dataDir },
    timeout: 30_000,
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 打开终端 tab（懒启动：此刻才起 shell）
    await win.getByTestId('inspector-tab-terminal').click();
    const host = win.getByTestId('terminal-host');
    await expect(host).toBeVisible();
    await expect(host).toHaveAttribute('data-session-key', 'global');

    // 等 shell 就绪：登录 shell 打印提示符/banner 后终端出现非空内容
    await expect
      .poll(
        async () => ((await host.locator('.xterm-rows').textContent()) ?? '').trim(),
        { timeout: 20_000 },
      )
      .not.toBe('');

    // 聚焦 xterm（点击命中其隐藏 textarea），键入命令并回车
    await host.click();
    await win.keyboard.type('echo oc$(echo inner)done');
    await win.keyboard.press('Enter');

    // 断言执行结果出现在 buffer 中（非本地回显）
    await expect
      .poll(async () => (await host.locator('.xterm-rows').textContent()) ?? '', {
        timeout: 20_000,
      })
      .toContain('ocinnerdone');

    // tab 可开关：切走再切回，会话与缓冲保活（pty 独立会话不丢）
    await win.getByTestId('inspector-tab-changes').click();
    await expect(win.getByTestId('terminal-host')).toHaveCount(0);
    await win.getByTestId('inspector-tab-terminal').click();
    await expect(host).toBeVisible();
    await expect
      .poll(async () => (await host.locator('.xterm-rows').textContent()) ?? '', {
        timeout: 10_000,
      })
      .toContain('ocinnerdone');

    // 主题切换 → 终端配色重读 CSS 变量（DESIGN.md §6：禁止硬编码色值）。
    // ticket #33（§1.1）：顶栏 theme-toggle 已撤入设置区外观区块（三态单选），
    // 选与当前解析主题相反的显式档；检查栏（终端）不受视图切换影响，会话保活。
    const before = await host.locator('.xterm-viewport').evaluate(
      (el) => (el as HTMLElement).style.backgroundColor,
    );
    await win.getByTestId('open-settings').click();
    const resolvedTheme = await win.evaluate(() => document.documentElement.dataset.theme);
    await win.getByTestId(resolvedTheme === 'dark' ? 'theme-mode-light' : 'theme-mode-dark').click();
    await expect
      .poll(async () =>
        host.locator('.xterm-viewport').evaluate((el) => (el as HTMLElement).style.backgroundColor),
        { timeout: 10_000 },
      )
      .not.toBe(before);
    // 且与解析后的 --bg token 一致（不是别的硬编码色）
    const expectedBg = await win.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      probe.style.color = 'var(--bg)';
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    });
    const after = await host.locator('.xterm-viewport').evaluate(
      (el) => (el as HTMLElement).style.backgroundColor,
    );
    expect(after).toBe(expectedBg);
  } finally {
    await app.close();
  }
});
