import { useEffect, useState } from 'react';
import type { ProviderListItem, ProviderPresetInfo } from '../../../../shared/api';
import { useProvidersStore } from '../../stores/providers';
import type { SettingsSectionDef } from '../registry';
import '../../styles/providers.css';

/**
 * 内置「Provider」设置区块（ticket #21，PRD §4.6）：
 * - 六家预设一键添加（填密钥即建；国内四家可选协议端点——默认 anthropic 兼容免代理直连）；
 * - 自定义 provider 表单（base URL + 协议 + 密钥 + 可选 env 名覆盖）；
 * - 已配置列表：密钥只显固定掩码（密文/明文不出 main）；模型清单展示上下文长度与
 *   价格（models.dev 元数据，快照兜底 + 「刷新」运行时拉取，PRD §4.6 纯展示，折算属 #27）。
 *
 * 红线呈现约束：密钥输入用 password 型；列表永不回显密钥本体（ARCHITECTURE §10）。
 */

/** 上下文长度紧凑格式：200000 → 200k；1_000_000 → 1M */
function formatContext(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 价格格式：$0.28（per 1M tokens）；null → — */
function formatPrice(n: number | null): string {
  if (n === null) return '—';
  return `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 === 0 ? 0 : 2)}`;
}

function protocolLabel(protocol: string): string {
  return protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容';
}

// ── 预设一键添加 ───────────────────────────────────────────────────────────

function PresetRow(props: { preset: ProviderPresetInfo; added: boolean }): React.JSX.Element {
  const addPreset = useProvidersStore((s) => s.addPreset);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<'anthropic' | 'openai'>(props.preset.protocol);
  const [busy, setBusy] = useState(false);
  const dual = Boolean(props.preset.endpoints.anthropic && props.preset.endpoints.openai);

  const submit = async (): Promise<void> => {
    if (apiKey.trim().length === 0 || busy) return;
    setBusy(true);
    const row = await addPreset({ presetId: props.preset.id, apiKey: apiKey.trim(), protocol });
    setBusy(false);
    if (row) {
      setOpen(false);
      setApiKey('');
    }
  };

  return (
    <li className="provider-preset" data-testid={`preset-${props.preset.id}`}>
      <div className="provider-row-main">
        <span className="provider-name">{props.preset.name}</span>
        <span className="muted mono provider-endpoint">
          {props.preset.endpoints[protocol] ?? props.preset.baseUrl}
        </span>
        {props.added && <span className="chip">已添加</span>}
        <button
          type="button"
          className="icon-btn"
          data-testid={`preset-add-${props.preset.id}`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : '添加'}
        </button>
      </div>
      {open && (
        <form
          className="provider-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {dual && (
            <select
              className="provider-protocol-select"
              data-testid={`preset-protocol-${props.preset.id}`}
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as 'anthropic' | 'openai')}
            >
              <option value="anthropic">Anthropic 兼容端点</option>
              <option value="openai">OpenAI 兼容端点</option>
            </select>
          )}
          <input
            type="password"
            data-testid={`preset-key-${props.preset.id}`}
            placeholder="API 密钥（safeStorage 加密落盘）"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            type="submit"
            className="icon-btn"
            data-testid={`preset-confirm-${props.preset.id}`}
            disabled={apiKey.trim().length === 0 || busy}
          >
            {busy ? '保存中…' : '确认'}
          </button>
        </form>
      )}
    </li>
  );
}

// ── 自定义 provider 表单 ───────────────────────────────────────────────────

function CustomProviderForm(): React.JSX.Element {
  const addCustom = useProvidersStore((s) => s.addCustom);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<'anthropic' | 'openai'>('anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyEnv, setKeyEnv] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit =
    name.trim().length > 0 && baseUrl.trim().length > 0 && apiKey.trim().length > 0 && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    const row = await addCustom({
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      ...(keyEnv.trim().length > 0 ? { keyEnv: keyEnv.trim() } : {}),
    });
    setBusy(false);
    if (row) {
      setOpen(false);
      setName('');
      setBaseUrl('');
      setApiKey('');
      setKeyEnv('');
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="icon-btn"
        data-testid="custom-provider-toggle"
        onClick={() => setOpen(true)}
      >
        添加自定义 provider
      </button>
    );
  }
  return (
    <form
      className="provider-custom-form"
      data-testid="custom-provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span className="field-label">名称</span>
        <input
          data-testid="custom-provider-name"
          placeholder="如：公司内部网关"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">协议</span>
        <select
          data-testid="custom-provider-protocol"
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as 'anthropic' | 'openai')}
        >
          <option value="anthropic">Anthropic 兼容（Messages API）</option>
          <option value="openai">OpenAI 兼容</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Base URL</span>
        <input
          data-testid="custom-provider-baseurl"
          placeholder="https://…"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">API 密钥</span>
        <input
          type="password"
          data-testid="custom-provider-key"
          placeholder="safeStorage 加密落盘，仅以 env 注入 agent 进程"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">密钥 env 名（可选）</span>
        <input
          data-testid="custom-provider-keyenv"
          placeholder={protocol === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'}
          value={keyEnv}
          onChange={(e) => setKeyEnv(e.target.value)}
        />
      </label>
      <div className="task-form-actions">
        <button
          type="submit"
          className="icon-btn"
          data-testid="custom-provider-submit"
          disabled={!canSubmit}
        >
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="icon-btn" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </form>
  );
}

// ── 已配置 provider 行（含模型清单） ───────────────────────────────────────

function ProviderRow(props: { provider: ProviderListItem }): React.JSX.Element {
  const remove = useProvidersStore((s) => s.remove);
  const refreshModels = useProvidersStore((s) => s.refreshModels);
  const loadModels = useProvidersStore((s) => s.loadModels);
  const models = useProvidersStore((s) => s.modelsByProvider[props.provider.id] ?? null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (expanded && models === null) void loadModels(props.provider.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, props.provider.id]);

  const doRefresh = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await refreshModels(props.provider.id);
    setBusy(false);
    setExpanded(true);
  };

  return (
    <li className="provider-item" data-testid="provider-item" data-provider-id={props.provider.id}>
      <div className="provider-row-main">
        <span className="provider-name">{props.provider.name}</span>
        <span className="chip">{props.provider.kind === 'preset' ? '预设' : '自定义'}</span>
        <span className="chip">{protocolLabel(props.provider.protocol)}</span>
        <span className="muted mono provider-endpoint">{props.provider.base_url}</span>
      </div>
      <div className="provider-row-sub">
        <span className="muted" data-testid="provider-key-masked">
          密钥 {props.provider.key_masked}
        </span>
        <span className="muted">
          {props.provider.models_fetched_at
            ? `清单已拉取 ${new Date(props.provider.models_fetched_at).toLocaleDateString()}`
            : '清单：静态预设兜底'}
        </span>
        <button
          type="button"
          className="icon-btn"
          data-testid="provider-models-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起模型' : '模型清单'}
        </button>
        <button
          type="button"
          className="icon-btn"
          data-testid="provider-refresh-models"
          disabled={busy}
          onClick={() => void doRefresh()}
          title="从 /models 拉取并合并 models.dev 元数据"
        >
          {busy ? '拉取中…' : '刷新模型'}
        </button>
        <button
          type="button"
          className="icon-btn"
          data-testid="provider-remove"
          onClick={() => void remove(props.provider.id)}
        >
          删除
        </button>
      </div>
      {expanded && (
        <table className="provider-models" data-testid="provider-models-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>上下文</th>
              <th>输入价 / 1M</th>
              <th>输出价 / 1M</th>
            </tr>
          </thead>
          <tbody>
            {(models ?? []).map((m) => (
              <tr key={m.id} data-testid="provider-model-row">
                <td className="mono">{m.id}</td>
                <td>{formatContext(m.contextLength)}</td>
                <td>{formatPrice(m.inputPrice)}</td>
                <td>{formatPrice(m.outputPrice)}</td>
              </tr>
            ))}
            {models !== null && models.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  （无清单——点「刷新模型」从 /models 拉取）
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </li>
  );
}

// ── 区块本体 ───────────────────────────────────────────────────────────────

function ProvidersSection(): React.JSX.Element {
  const providers = useProvidersStore((s) => s.providers);
  const presets = useProvidersStore((s) => s.presets);
  const loaded = useProvidersStore((s) => s.loaded);
  const lastError = useProvidersStore((s) => s.lastError);
  const refresh = useProvidersStore((s) => s.refresh);

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const addedPresetIds = new Set(
    providers.filter((p) => p.preset_id !== null).map((p) => p.preset_id),
  );

  return (
    <section className="settings-section" data-testid="settings-providers">
      <h2 className="pane-title">Provider 与凭证</h2>
      <p className="muted providers-hint">
        密钥经 safeStorage 加密落盘、仅以环境变量注入 agent 进程；不触碰各家全局配置。
      </p>

      <h3 className="providers-sub-title">预设</h3>
      <ul className="providers-presets">
        {presets.map((p) => (
          <PresetRow key={p.id} preset={p} added={addedPresetIds.has(p.id)} />
        ))}
      </ul>

      <h3 className="providers-sub-title">自定义 provider</h3>
      <CustomProviderForm />

      <h3 className="providers-sub-title">已配置</h3>
      {providers.length === 0 ? (
        <p className="muted" data-testid="providers-empty">
          {loaded ? '（尚未配置 provider——任务将使用 agent 自带默认配置）' : '加载中…'}
        </p>
      ) : (
        <ul className="providers-list">
          {providers.map((p) => (
            <ProviderRow key={p.id} provider={p} />
          ))}
        </ul>
      )}

      {lastError && (
        <p className="form-error" role="alert" data-testid="providers-error">
          {lastError}
        </p>
      )}
    </section>
  );
}

const def: SettingsSectionDef = {
  id: 'providers',
  title: 'Provider 与凭证',
  order: 20,
  component: ProvidersSection,
};

export default def;
