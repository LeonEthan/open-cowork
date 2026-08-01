import type { SettingsSectionDef } from '../registry';
import { useUiStore } from '../../stores/ui';
import type { ThemeMode } from '../../stores/ui';

/**
 * 内置「外观」设置区块（设置页扩展示例 + 主题手动切换的完整入口）：
 * 跟随系统 / 浅色 / 深色 三选，选择即记忆（DESIGN.md §6）。
 * ticket #33（§1.1）：顶栏 theme-toggle 撤入本区块（无功能损失）；
 * 各档加 data-testid 供 e2e 稳定定位。
 */
function AppearanceSection(): React.JSX.Element {
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const options: { value: ThemeMode; label: string }[] = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色' },
  ];
  return (
    <section className="settings-section" data-testid="settings-appearance">
      <h2 className="pane-title">外观</h2>
      <div className="row" role="radiogroup" aria-label="主题">
        {options.map((opt) => (
          <label key={opt.value} data-testid={`theme-mode-${opt.value}`}>
            <input
              type="radio"
              name="theme-mode"
              value={opt.value}
              checked={themeMode === opt.value}
              onChange={() => setThemeMode(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </section>
  );
}

const def: SettingsSectionDef = {
  id: 'appearance',
  title: '外观',
  order: 10,
  component: AppearanceSection,
};

export default def;
