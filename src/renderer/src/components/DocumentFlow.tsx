import { settingsSections } from '../extensions/registry';
import { useUiStore } from '../stores/ui';

/**
 * 内容栏（文档流，§1 的主角）：max-width 860px 居中。
 * 本票为「空任务态」占位——文案克制（§7：无营销性/装饰性元素）；
 * 设置视图复用同一文档栏呈现，区块经 extensions/settings-sections/ 自动注册。
 */
export function DocumentFlow(): React.JSX.Element {
  const view = useUiStore((s) => s.view);

  return (
    <main className="content" data-testid="document-flow">
      <div className="content-inner">
        {view === 'settings' ? (
          <>
            <h1 className="doc-title">设置</h1>
            {settingsSections.map((s) => (
              <s.component key={s.id} />
            ))}
            {settingsSections.length === 0 && <p className="muted">（无已注册设置区块）</p>}
          </>
        ) : (
          <>
            <h1 className="doc-title">开始</h1>
            <p className="muted">还没有进行中的任务。</p>
            <p className="muted">创建任务后，对话将以文档流呈现在这里。</p>
          </>
        )}
      </div>
    </main>
  );
}
