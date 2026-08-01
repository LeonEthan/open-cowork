import type { SettingsSectionDef } from '../registry';
import { useUiStore } from '../../stores/ui';

/**
 * ticket #33（DESIGN.md §1.1）：内置「诊断」设置区块——utility 直连状态
 * （MessageChannel ping-pong）从已废除的顶栏迁入设置区，主界面不再常驻调试信息。
 * 保留 data-testid="utility-status"（e2e smoke 经设置视图断言 pong）。
 */
function DiagnosticsSection(): React.JSX.Element {
  const utilityPong = useUiStore((s) => s.utilityPong);
  return (
    <section className="settings-section" data-testid="settings-diagnostics">
      <h2 className="pane-title">诊断</h2>
      <div className="row">
        <span className="utility-status" data-testid="utility-status">
          {utilityPong ? 'utility ⇄ renderer · pong' : 'utility: connecting…'}
        </span>
      </div>
    </section>
  );
}

const def: SettingsSectionDef = {
  id: 'diagnostics',
  title: '诊断',
  order: 90,
  component: DiagnosticsSection,
};

export default def;
