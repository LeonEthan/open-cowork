import { useEffect } from 'react';
import { resolveTheme, useUiStore } from '../stores/ui';

/**
 * 主题应用（DESIGN.md §6）：
 * - 默认跟随系统（prefers-color-scheme），手动切换记忆偏好；
 * - 通过 <html data-theme> 切换 token 组，瞬间切换、无过渡动画；
 * - system 模式下监听系统主题变化。
 */

/**
 * 同步把当前解析主题写到 <html data-theme>。
 * 首帧防闪（main.tsx 模块顶层、render 之前调用）与 effect 内切换共用一条路径；
 * persist store 的 localStorage 再水合是同步的，此时 themeMode 已是记忆偏好。
 */
export function applyTheme(): void {
  const themeMode = useUiStore.getState().themeMode;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = resolveTheme(themeMode, systemDark);
}

export function useTheme(): void {
  const themeMode = useUiStore((s) => s.themeMode);

  useEffect(() => {
    applyTheme();
    if (themeMode === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      mql.addEventListener('change', applyTheme);
      return () => mql.removeEventListener('change', applyTheme);
    }
  }, [themeMode]);
}
