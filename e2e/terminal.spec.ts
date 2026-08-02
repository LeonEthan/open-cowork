import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * 底部终端抽屉（§1.2 修订，ticket #28 会话能力不变）e2e：
 * ⌘T 唤起抽屉 → terminal-host 出现（懒启动起 shell）→ 等 shell 就绪 →
 * 键入 echo 命令 → 断言 xterm buffer 出现「只有 shell 真执行才会产生」的回显 →
 * ⌘T 隐藏（host 消失，会话 detach 保活）→ ⌘T 重开（缓冲不丢）→ 主题切换重读 CSS 变量。
 * 命令特意让本地回显与求值结果不同：键入 echo oc$(echo inner)done，
 * 回明显示原始命令，而 ocinnerdone 只会在 shell 执行后出现（zsh/bash/fish 均支持 $(...)）。
 */
test('终端抽屉：⌘T 唤起 → echo 回显 → 隐藏/重开缓冲保活 → 主题跟随', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'open-cowork-e2e-term-'));

  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, OPEN_COWORK_DATA_DIR: dataDir },
    timeout: 30_000,
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    // 等 React 首屏挂载（⌘T 全局监听在 App useEffect 注册；拿到 document-flow 即已生效）
    await expect(win.getByTestId('document-flow')).toBeVisible();

    // ⌘T 手动唤起抽屉（首次唤起且无存活会话 → 自动为当前上下文建 tab，懒启动：此刻才起 shell）
    await win.keyboard.press('ControlOrMeta+T');
    await expect(win.getByTestId('terminal-drawer')).toBeVisible();
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

    // ⌘T 隐藏抽屉：焦点仍在 xterm 隐藏 textarea 内——快捷键不受输入焦点守卫
    // （附录 B 审计：旧守卫会让键盘被困在终端里关不掉抽屉）
    await win.keyboard.press('ControlOrMeta+T');
    await expect(win.getByTestId('terminal-drawer')).toHaveCount(0);
    await expect(win.getByTestId('terminal-host')).toHaveCount(0);

    // ⌘T 重开：会话与缓冲保活（detach 不丢 pty/xterm 缓冲，重开即复原）
    await win.keyboard.press('ControlOrMeta+T');
    await expect(win.getByTestId('terminal-drawer')).toBeVisible();
    await expect(host).toBeVisible();
    await expect
      .poll(async () => (await host.locator('.xterm-rows').textContent()) ?? '', {
        timeout: 10_000,
      })
      .toContain('ocinnerdone');

    // 主题切换 → 终端配色重读 CSS 变量（DESIGN.md §6：禁止硬编码色值）。
    // ticket #33（§1.1）：顶栏 theme-toggle 已撤入设置区外观区块（三态单选），
    // 选与当前解析主题相反的显式档；附录 B 审计 P2：设置视图不渲染抽屉——
    // 会话 detach 保活，返回文档视图重挂时配色对齐新主题（TerminalHost attach 重读）。
    const before = await host.locator('.xterm-viewport').evaluate(
      (el) => (el as HTMLElement).style.backgroundColor,
    );
    await win.getByTestId('open-settings').click();
    await expect(win.getByTestId('terminal-drawer')).toHaveCount(0);
    const resolvedTheme = await win.evaluate(() => document.documentElement.dataset.theme);
    await win.getByTestId(resolvedTheme === 'dark' ? 'theme-mode-light' : 'theme-mode-dark').click();
    // 返回文档视图 → 抽屉重挂 → xterm 配色 = 新主题 token
    await win.getByTestId('new-task-toggle').click();
    await expect(win.getByTestId('terminal-drawer')).toBeVisible();
    await expect(win.getByTestId('terminal-host')).toBeVisible();
    const expectedBg = await win.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      probe.style.color = 'var(--bg)';
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    });
    await expect
      .poll(async () =>
        host.locator('.xterm-viewport').evaluate((el) => (el as HTMLElement).style.backgroundColor),
        { timeout: 10_000 },
      )
      .not.toBe(before);
    const after = await host.locator('.xterm-viewport').evaluate(
      (el) => (el as HTMLElement).style.backgroundColor,
    );
    expect(after).toBe(expectedBg);
  } finally {
    await app.close();
  }
});
