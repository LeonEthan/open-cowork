import { useEffect } from 'react';
import { useProvidersStore } from '../../stores/providers';
import '../../styles/providers.css';

/**
 * Provider / Model 选择器（ticket #21）：任务创建表单的实化 picker
 * （#18 占位实现见 task-list.tsx 顶部历史注释）。
 *
 * - provider 下拉来自 providers 表（无配置时给「去设置页添加」提示项）；
 * - model 下拉来自该 provider 的模型清单（providers:models——缓存/预设静态兜底，
 *   同步无网络）；选择落库 task.provider_id / task.model。
 * - 空值 = agent 默认（provider_id/model 落 NULL）。
 *
 * 独立组件文件 + import 级接线（与 #22 AgentPicker 并行合并零冲突）。
 */
export function ProviderModelPicker(props: {
  providerId: string;
  model: string;
  onProviderChange: (id: string) => void;
  onModelChange: (model: string) => void;
}): React.JSX.Element {
  const providers = useProvidersStore((s) => s.providers);
  const loaded = useProvidersStore((s) => s.loaded);
  const refresh = useProvidersStore((s) => s.refresh);
  const loadModels = useProvidersStore((s) => s.loadModels);
  const models = useProvidersStore((s) =>
    props.providerId ? (s.modelsByProvider[props.providerId] ?? null) : null,
  );

  // 挂载刷新 provider 目录；选中变化时拉该 provider 的模型清单
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);
  useEffect(() => {
    if (props.providerId) void loadModels(props.providerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.providerId]);

  const provider = providers.find((p) => p.id === props.providerId) ?? null;

  return (
    <>
      <label className="field">
        <span className="field-label">Provider</span>
        <select
          data-testid="task-provider-select"
          value={props.providerId}
          onChange={(e) => {
            props.onProviderChange(e.target.value);
            props.onModelChange(''); // provider 切换后模型清单随之换——回落默认
          }}
        >
          <option value="">默认 provider（agent 自带配置）</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {loaded && providers.length === 0 && (
            <option value="" disabled>
              （尚无已配置 provider——去设置页添加）
            </option>
          )}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Model</span>
        <select
          data-testid="task-model-select"
          value={props.model}
          disabled={!provider}
          onChange={(e) => props.onModelChange(e.target.value)}
        >
          <option value="">
            {provider ? `默认 model（${provider.name} 缺省）` : '默认 model（agent 缺省）'}
          </option>
          {(models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
