import { useEffect, useState } from 'react';
import type { AgentEnvironmentInfo, CustomAgentInfo } from '../../../../shared/api';
import { useAgentEnvironmentStore } from '../../stores/agentEnvironment';
import type { SettingsSectionDef } from '../registry';
import '../../styles/agents.css';

/**
 * 「Agent 管理」设置区块（ticket #26，prototype/agent-onboarding 变体 B 定稿）：
 * - 内置四家卡片：状态徽标（已装/未装/未认证，语义色）+ 能力徽标 + 安装命令 chip
 *   （一键复制）+ 自定义路径修复（绝对路径 → 验证并保存 → 恢复自动探测）+
 *   探测日志折叠区（左边线样式，DESIGN.md §4 思考过程同款）；
 * - 自定义 ACP agent：注册表单（名称 + 命令 + 参数 + 可选环境变量）→ 落库即探测；
 *   已注册卡片（状态/命令/重测/删除）。
 *
 * 视觉纪律：只用 tokens.css 变量、零阴影、徽标 pill 圆角（§2/§3/§7）。
 */

// ── 徽标 ─────────────────────────────────────────────────────────────────

function StatusBadge(props: { agent: AgentEnvironmentInfo }): React.JSX.Element {
  const a = props.agent;
  if (!a.installed) {
    return (
      <span className="agent-badge miss" data-testid={`agent-status-${a.id}`}>
        未安装
      </span>
    );
  }
  if (a.authenticated === false) {
    return (
      <span className="agent-badge warn" data-testid={`agent-status-${a.id}`}>
        未认证
      </span>
    );
  }
  return (
    <span
      className="agent-badge ok"
      data-testid={`agent-status-${a.id}`}
      title={a.version ?? undefined}
    >
      已安装{a.version ? ` · ${a.version}` : ''}
    </span>
  );
}

function CapabilityBadges(props: { agent: AgentEnvironmentInfo }): React.JSX.Element {
  const caps = props.agent.capabilities;
  const cap = (on: boolean, label: string, title?: string): React.JSX.Element => (
    <span key={label} className={`agent-cap${on ? '' : ' no'}`} title={title}>
      {label}
    </span>
  );
  return (
    <span className="agent-caps">
      {caps.approval === 'native'
        ? cap(true, '审批', '原生审批：请求路由回 open-cowork 审批流')
        : caps.approval === 'degraded'
          ? cap(true, '审批·降级', '无内建审批——适配层静态策略兜底')
          : cap(false, '审批')}
      {cap(caps.streaming, '流式')}
      {cap(caps.usage, '用量')}
      {cap(caps.mcp, 'MCP')}
    </span>
  );
}

// ── 安装命令 chip（一键复制） ──────────────────────────────────────────────

function InstallCommandChip(props: { agentId: string; command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.command);
    } catch {
      // clipboard API 不可用（权限/焦点）——退化为不可复制提示
      setCopied(false);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="agent-cmd-chip" data-testid={`agent-install-cmd-${props.agentId}`}>
      <code>{props.command}</code>
      <button
        type="button"
        className="agent-copy"
        data-testid={`agent-install-copy-${props.agentId}`}
        onClick={() => void copy()}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </span>
  );
}

// ── 路径修复 ───────────────────────────────────────────────────────────────

function RepairRow(props: { agent: AgentEnvironmentInfo }): React.JSX.Element {
  const setOverridePath = useAgentEnvironmentStore((s) => s.setOverridePath);
  const clearOverride = useAgentEnvironmentStore((s) => s.clearOverride);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const a = props.agent;

  const submit = async (): Promise<void> => {
    if (path.trim().length === 0 || busy) return;
    setBusy(true);
    setFeedback(null);
    const ok = await setOverridePath(a.id, path.trim());
    setBusy(false);
    setFeedback(
      ok
        ? { ok: true, text: '验证通过，已保存为该 agent 的可执行路径' }
        : { ok: false, text: useAgentEnvironmentStore.getState().lastError ?? '验证失败' },
    );
    if (ok) setPath('');
  };

  return (
    <div className="agent-repair">
      {a.overridePath && (
        <div className="agent-repair-row">
          <span className="muted">
            自定义路径生效中：<code>{a.overridePath}</code>
          </span>
          <button
            type="button"
            className="icon-btn"
            data-testid={`agent-repair-clear-${a.id}`}
            onClick={() => void clearOverride(a.id)}
          >
            恢复自动探测
          </button>
        </div>
      )}
      <div className="agent-repair-row">
        <input
          data-testid={`agent-repair-input-${a.id}`}
          placeholder={`可执行文件绝对路径（如 /usr/local/bin/${a.executable}）`}
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          data-testid={`agent-repair-save-${a.id}`}
          disabled={path.trim().length === 0 || busy}
          onClick={() => void submit()}
        >
          {busy ? '验证中…' : '验证并保存'}
        </button>
      </div>
      {feedback && (
        <div
          className={`agent-repair-feedback${feedback.ok ? ' ok' : ''}`}
          role={feedback.ok ? 'status' : 'alert'}
          data-testid={`agent-repair-feedback-${a.id}`}
        >
          {feedback.text}
        </div>
      )}
    </div>
  );
}

// ── 探测日志（左边线折叠区，§4 思考过程同款） ───────────────────────────────

function ProbeLogDetails(props: { agentId: string }): React.JSX.Element {
  const probeLogs = useAgentEnvironmentStore((s) => s.probeLogs);
  const loadProbeLogs = useAgentEnvironmentStore((s) => s.loadProbeLogs);
  const lines = probeLogs?.[props.agentId] ?? [];
  return (
    <details
      className="agent-probe-log"
      data-testid={`agent-probe-log-${props.agentId}`}
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) void loadProbeLogs();
      }}
    >
      <summary>探测日志</summary>
      {lines.length === 0 ? (
        <p className="muted">（尚无日志——点「重新检测」产生新记录）</p>
      ) : (
        <pre>{lines.join('\n')}</pre>
      )}
    </details>
  );
}

// ── 内置 agent 卡片 ────────────────────────────────────────────────────────

function BuiltinAgentCard(props: { agent: AgentEnvironmentInfo }): React.JSX.Element {
  const reprobeAll = useAgentEnvironmentStore((s) => s.reprobeAll);
  const reprobing = useAgentEnvironmentStore((s) => s.reprobing);
  const a = props.agent;
  return (
    <li className="agent-card" data-testid={`agent-card-${a.id}`}>
      <div className="agent-card-head">
        <span className="agent-name">{a.displayName}</span>
        <StatusBadge agent={a} />
        <span className="agent-head-spacer" />
        <button
          type="button"
          className="icon-btn"
          data-testid={`agent-reprobe-${a.id}`}
          disabled={reprobing}
          onClick={() => void reprobeAll()}
        >
          {reprobing ? '检测中…' : '重新检测'}
        </button>
      </div>
      {a.resolvedPath && <div className="agent-path">{a.resolvedPath}</div>}
      <div className="agent-card-sub">
        <CapabilityBadges agent={a} />
        {!a.driverAvailable && <span className="muted">driver 接入中（即将支持）</span>}
        {a.homepage && <span className="muted agent-homepage">{a.homepage}</span>}
      </div>
      {a.authenticated === false && a.installed && (
        <div className="agent-auth-note">
          未发现本机认证配置——可在 agent 自有渠道登录，或为任务配置 provider 密钥（env 注入）。
        </div>
      )}
      {!a.installed && a.installCommand && (
        <div className="agent-install-row">
          <span className="muted">安装后点「重新检测」：</span>
          <InstallCommandChip agentId={a.id} command={a.installCommand} />
        </div>
      )}
      <RepairRow agent={a} />
      <ProbeLogDetails agentId={a.id} />
    </li>
  );
}

// ── 自定义 ACP agent 注册表单 ──────────────────────────────────────────────

/** 环境变量输入解析：`KEY=value, K2=v2` → Record；非法项抛错（表单内联提示） */
function parseEnvInput(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (p.length === 0) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) throw new Error(`环境变量项缺少「=」：${p}`);
    env[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return env;
}

function CustomAgentForm(): React.JSX.Element {
  const createCustom = useAgentEnvironmentStore((s) => s.createCustom);
  const lastError = useAgentEnvironmentStore((s) => s.lastError);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && command.trim().length > 0 && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    let parsedEnv: Record<string, string>;
    try {
      parsedEnv = parseEnvInput(env);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    setFormError(null);
    const ok = await createCustom({
      name: name.trim(),
      command: command.trim(),
      args: args.trim().length > 0 ? args.trim().split(/\s+/) : [],
      ...(Object.keys(parsedEnv).length > 0 ? { env: parsedEnv } : {}),
    });
    setBusy(false);
    if (ok) {
      setOpen(false);
      setName('');
      setCommand('');
      setArgs('');
      setEnv('');
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="agent-add-custom"
        data-testid="custom-agent-form-toggle"
        onClick={() => setOpen(true)}
      >
        ＋ 添加自定义 ACP agent…
      </button>
    );
  }
  return (
    <form
      className="agent-custom-form"
      data-testid="custom-agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span className="field-label">名称</span>
        <input
          data-testid="custom-agent-name"
          placeholder="my-agent"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">命令</span>
        <input
          data-testid="custom-agent-command"
          placeholder="可执行文件绝对路径或 PATH 上的命令（如 npx）"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">参数（空格分隔，可空）</span>
        <input
          data-testid="custom-agent-args"
          placeholder="my-acp-agent --stdio"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">环境变量（KEY=value，逗号分隔，可空）</span>
        <input
          data-testid="custom-agent-env"
          placeholder="MY_AGENT_TOKEN=xxx"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
        />
      </label>
      {(formError ?? lastError) && (
        <p className="form-error" role="alert" data-testid="custom-agent-error">
          {formError ?? lastError}
        </p>
      )}
      <div className="task-form-actions">
        <button type="submit" className="icon-btn" data-testid="custom-agent-submit" disabled={!canSubmit}>
          {busy ? '注册并探测中…' : '保存'}
        </button>
        <button type="button" className="icon-btn" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </form>
  );
}

// ── 自定义 agent 卡片 ──────────────────────────────────────────────────────

function CustomAgentCard(props: { agent: CustomAgentInfo }): React.JSX.Element {
  const removeCustom = useAgentEnvironmentStore((s) => s.removeCustom);
  const reprobeCustom = useAgentEnvironmentStore((s) => s.reprobeCustom);
  const [busy, setBusy] = useState(false);
  const a = props.agent;
  return (
    <li className="agent-card" data-testid={`custom-agent-card`} data-custom-id={a.id}>
      <div className="agent-card-head">
        <span className="agent-name">{a.name}</span>
        <span className="agent-cap">自定义 ACP</span>
        {a.installed ? (
          <span
            className="agent-badge ok"
            data-testid={`custom-agent-status-${a.id}`}
            title={a.version ?? undefined}
          >
            已安装{a.version ? ` · ${a.version}` : ''}
          </span>
        ) : (
          <span className="agent-badge miss" data-testid={`custom-agent-status-${a.id}`}>
            未安装
          </span>
        )}
        <span className="agent-head-spacer" />
        <button
          type="button"
          className="icon-btn"
          data-testid={`custom-agent-reprobe-${a.id}`}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void reprobeCustom(a.id).finally(() => setBusy(false));
          }}
        >
          {busy ? '检测中…' : '重新检测'}
        </button>
        <button
          type="button"
          className="icon-btn"
          data-testid={`custom-agent-remove-${a.id}`}
          onClick={() => void removeCustom(a.id)}
        >
          删除
        </button>
      </div>
      <div className="agent-path">
        {a.command}
        {a.args.length > 0 ? ` ${a.args.join(' ')}` : ''}
      </div>
      {a.probeError && (
        <div className="agent-repair-feedback" role="alert">
          {a.probeError}
        </div>
      )}
      <ProbeLogDetails agentId={`custom:${a.id}`} />
    </li>
  );
}

// ── 区块本体 ───────────────────────────────────────────────────────────────

function AgentsSection(): React.JSX.Element {
  const agents = useAgentEnvironmentStore((s) => s.agents);
  const customAgents = useAgentEnvironmentStore((s) => s.customAgents);
  const loaded = useAgentEnvironmentStore((s) => s.loaded);
  const load = useAgentEnvironmentStore((s) => s.load);
  const lastError = useAgentEnvironmentStore((s) => s.lastError);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const builtins = agents.filter((a) => a.source === 'builtin');

  return (
    <section className="settings-section" data-testid="settings-agents">
      <h2 className="pane-title">Agent 管理</h2>
      <p className="muted agents-hint">
        自动探测已安装的 CLI；异常时可手动修复路径或查看探测日志。自定义 ACP agent 经命令注册，
        会话 picker 中未安装的 agent 一律置灰不可选。
      </p>
      {!loaded ? (
        <p className="muted">探测中…</p>
      ) : (
        <>
          <ul className="agents-list">
            {builtins.map((a) => (
              <BuiltinAgentCard key={a.id} agent={a} />
            ))}
          </ul>

          <h3 className="agents-sub-title">自定义 ACP agent</h3>
          {customAgents.length > 0 && (
            <ul className="agents-list">
              {customAgents.map((a) => (
                <CustomAgentCard key={a.id} agent={a} />
              ))}
            </ul>
          )}
          <CustomAgentForm />
        </>
      )}
      {lastError && (
        <p className="form-error" role="alert" data-testid="agents-error">
          {lastError}
        </p>
      )}
    </section>
  );
}

const def: SettingsSectionDef = {
  id: 'agents',
  title: 'Agent 管理',
  order: 15, // appearance=10 / providers=20 之间
  component: AgentsSection,
};

export default def;
