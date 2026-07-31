import { useEffect } from 'react';
import { resolveTheme, useUiStore } from '../stores/ui';

/**
 * 主题应用（DESIGN.md §6）：
 * - 默认跟随系统（prefers-color-scheme），手动切换记忆偏好；
 * - 通过 <html data-theme> 切换 token 组，瞬间切换、无过渡动画；
 * - system 模式下监听系统主题变化。
 */
export function useTheme(): void {
  const themeMode = useUiStore((s) => s.themeMode);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(themeMode, mql.matches);
    };
    apply();
    if (themeMode === 'system') {
      mql.addEventListener('change', apply);
      return () => mql.removeEventListener('change', apply);
    }
  }, [themeMode]);
}
