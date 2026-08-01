import { useEffect, useRef, useState } from 'react';
import type { PermissionMode, Workspace, WorkspaceWorktreeInfo } from '../../../shared/api';
import { agentLabel } from '../lib/taskStatus';
import { MODE_LABELS, MODE_NEXT, MODE_TITLES } from '../lib/permissionMode';
import { useAgentsStore } from '../stores/agents';
import { useAppStore } from '../stores/appStore';
import { errMessage, useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { AgentPicker } from './pickers/AgentPicker';
import { ProviderModelPicker } from './pickers/ProviderModelPicker';

/**
 * 首页空态（ticket #36，DESIGN.md §1/§3/§4）：
 * 未选中任务时中区 = hero（克制文字标记 + 带 workspace 名的问句 + starter 卡片）
 * + 底部居中悬浮 composer 卡片（760px、16px 圆角档、边框分层零阴影，§3/§4）。
 *
 * - 创建内联化：composer 输入并发送 = createTask →（非默认档位先 setPermissionMode）→
 *   agent.start 连调，一步到位；create 成功而 start 失败时任务留 ready（状态机允许），
 *   错误经 ui store composerNotice 跨视图提示，任务内 composer「开始」可重试。
 * - composer 三行结构：上下文行（workspace chip 切换 / Local 环境 chip / 原目录·worktree
 *   chip，#25 语义——git workspace 可切换，非 git 置灰提示）→ 输入区 → 动作行
 *   （权限三档 chip 视觉对齐 Codex "Approve for me" 位、agent+provider+model 合并 picker
 *   右置、发送键）。
 * - starter 卡片（§4 功能件，16px 圆角 + 1px 边框）：点击 = 预填 composer 并聚焦。
 * - 无 workspace 时整区退化为「添加 workspace」引导（复用侧栏同一桥能力），不渲染 composer。
 *
 * testid 面：home-view / home-hero / hero-logo / starter-card / hero-add-workspace /
 * composer / composer-workspace-select / composer-env-chip / composer-worktree-toggle /
 * agent-model-picker-toggle / agent-model-popover / composer-input / send-button /
 * permission-mode-chip / composer-error；picker 内复用既有 task-agent-select /
 * task-provider-select / task-model-select（弹出层内，e2e 经 picker-toggle 开启后访问）。
 */

/** starter 卡片文案（2–4 张，§4；点击预填 composer 占位文案） */
const STARTERS: ReadonlyArray<{ key: string; label: string; hint: string; prefill: string }> = [
  {
    key: 'explore',
    label: '探索并理解代码',
    hint: '梳理结构、关键模块与数据流',
    prefill: '探索这个代码库：梳理整体结构、关键模块与数据流，给我一份导览。',
  },
  {
    key: 'feature',
    label: '构建新功能',
    hint: '从需求描述到落地实现',
    prefill: '构建一个新功能：',
  },
  {
    key: 'fix',
    label: '修复问题',
    hint: '定位根因并修复',
    prefill: '修复一个问题：',
  },
  {
    key: 'free',
    label: '自由任务',
    hint: '直接描述你想做的事',
    prefill: '',
  },
];

export function HomeView(): React.JSX.Element {
  const workspaces = useDataStore((s) => s.workspaces);
  const requestComposerFocus = useUiStore((s) => s.requestComposerFocus);
  const [workspaceId, setWorkspaceId] = useState('');
  const [text, setText] = useState('');

  // workspace 列表变化（首个添加/移除）时保持有效选择
  useEffect(() => {
    if (!workspaces.some((w) => w.id === workspaceId)) {
      setWorkspaceId(workspaces[0]?.id ?? '');
    }
  }, [workspaces, workspaceId]);

  const ws = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? null;

  return (
    <div className="home-view" data-testid="home-view">
      {workspaces.length === 0 || !ws ? (
        <NoWorkspaceHero />
      ) : (
        <>
          <div className="home-hero" data-testid="home-hero">
            <div className="hero-logo" data-testid="hero-logo">
              open-cowork
            </div>
            <h1 className="hero-question">想在「{ws.name}」里做点什么？</h1>
            <div className="starter-grid">
              {STARTERS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="starter-card"
                  data-testid="starter-card"
                  data-starter={s.key}
                  onClick={() => {
                    setText(s.prefill);
                    requestComposerFocus();
                  }}
                >
                  <span className="starter-label">{s.label}</span>
                  <span className="starter-hint">{s.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="composer-dock">
            <HomeComposer
              workspaces={workspaces}
              workspaceId={ws.id}
              onWorkspaceChange={setWorkspaceId}
              text={text}
              onTextChange={setText}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** 无 workspace 的退化 hero：添加 workspace 引导（复用侧栏同一桥能力） */
function NoWorkspaceHero(): React.JSX.Element {
  const addWorkspaceViaDialog = useDataStore((s) => s.addWorkspaceViaDialog);
  return (
    <div className="home-hero" data-testid="home-hero">
      <div className="hero-logo" data-testid="hero-logo">
        open-cowork
      </div>
      <h1 className="hero-question">先添加一个本地目录作为 workspace</h1>
      <p className="muted">agent 只在你添加的本地目录里工作——本地优先，无云端环境。</p>
      <button
        type="button"
        className="icon-btn hero-add"
        data-testid="hero-add-workspace"
        onClick={() => void addWorkspaceViaDialog()}
      >
        添加 Workspace…
      </button>
    </div>
  );
}

// ── 首页 composer（创建入口，create+start 一步到位） ──────────────────────

function HomeComposer(props: {
  workspaces: Workspace[];
  workspaceId: string;
  onWorkspaceChange: (id: string) => void;
  text: string;
  onTextChange: (text: string) => void;
}): React.JSX.Element {
  const { workspaces, workspaceId, text } = props;
  const refreshAll = useDataStore((s) => s.refreshAll);
  const setComposerNotice = useUiStore((s) => s.setComposerNotice);
  const composerFocusNonce = useUiStore((s) => s.composerFocusNonce);

  const [agentType, setAgentType] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mode, setMode] = useState<PermissionMode>('auto');
  const [useWorktree, setUseWorktree] = useState(false);
  const [wtInfo, setWtInfo] = useState<WorkspaceWorktreeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // agent 探测：挂载即拉取（合并 picker 的 toggle 文案与默认回填都依赖它）
  const agents = useAgentsStore((s) => s.agents);
  const agentsLoaded = useAgentsStore((s) => s.loaded);
  const loadAgents = useAgentsStore((s) => s.load);
  useEffect(() => {
    if (!agentsLoaded) void loadAgents();
  }, [agentsLoaded, loadAgents]);

  // 默认回填：当前值不可选时选第一个可用 agent（与 AgentPicker 内逻辑同口径；
  // 不打开 picker 也能直接发送）
  useEffect(() => {
    if (!agentsLoaded) return;
    const selectable = (a: { installed: boolean; driverAvailable: boolean }): boolean =>
      a.installed && a.driverAvailable;
    const current = agents.find((a) => a.id === agentType);
    if (current && selectable(current)) return;
    const first = agents.find(selectable);
    if (first && first.id !== agentType) setAgentType(first.id);
  }, [agentsLoaded, agents, agentType]);

  // 选中 workspace 变化 → 探测 worktree 可用性（#25 同口径）；不可用时收回勾选
  useEffect(() => {
    const api = window.openCowork;
    if (!api || workspaceId.length === 0) {
      setWtInfo(null);
      setUseWorktree(false);
      return;
    }
    let cancelled = false;
    void api.worktree.workspaceCheck(workspaceId).then((info) => {
      if (cancelled) return;
      setWtInfo(info);
      if (!info.isGitRepo || !info.hasCommits) setUseWorktree(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // 侧栏「新建任务」功能行 / starter 卡片 → 聚焦输入框
  useEffect(() => {
    if (composerFocusNonce > 0) inputRef.current?.focus();
  }, [composerFocusNonce]);

  // Escape 关闭合并 picker 弹出层
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen]);

  const worktreeAvailable = wtInfo?.isGitRepo === true && wtInfo.hasCommits;
  const worktreeHint = !wtInfo
    ? '检测 workspace 是否为 git 仓库…'
    : !wtInfo.isGitRepo
      ? '仅 git workspace 可用 worktree 隔离（当前目录不在 git 工作树内）'
      : !wtInfo.hasCommits
        ? '仓库尚无提交，请先完成首次提交后再启用 worktree 隔离'
        : useWorktree
          ? '任务将在独立 worktree 目录运行，原目录零改动；点击切回原目录'
          : '在原目录直接运行；点击切换为 worktree 隔离（改动与原目录隔离）';

  const canSend =
    !busy && text.trim().length > 0 && workspaceId.length > 0 && agentType.length > 0;

  /** 创建内联化：createTask →（非默认档位先落档位）→ agent.start 连调 */
  const send = async (): Promise<void> => {
    const api = window.openCowork;
    if (!api || !canSend) return;
    const prompt = text.trim();
    setBusy(true);
    setErr(null);
    try {
      const task = await api.tasks.create({
        workspaceId,
        prompt,
        agentType,
        providerId: providerId || null,
        model: model || null,
        useWorktree: useWorktree && worktreeAvailable,
      });
      // 权限档位是 per-task 持久化字段：创建后开跑前落档（默认 auto 无需调用）
      if (mode !== 'auto') await api.approvals.setPermissionMode(task.id, mode);
      // start 失败不吞：任务留 ready（状态机允许），选中后任务内 composer 可重试
      let notice: { taskId: string; message: string } | null = null;
      try {
        await api.agent.start(task.id);
      } catch (e) {
        notice = {
          taskId: task.id,
          message: `任务已创建，但首轮启动失败：${errMessage(e)}——点下方「开始」重试`,
        };
      }
      await refreshAll();
      setComposerNotice(notice);
      useAppStore.getState().setCurrentTaskId(task.id);
      props.onTextChange('');
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer" data-testid="composer">
      <div className="composer-box">
        {/* 第一行·上下文行：workspace 切换 / Local 环境 / 原目录·worktree 切换 */}
        <div className="composer-context">
          <select
            className="chip chip-select"
            data-testid="composer-workspace-select"
            value={workspaceId}
            onChange={(e) => props.onWorkspaceChange(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id} title={w.path}>
                {w.name}
              </option>
            ))}
          </select>
          <span className="chip" data-testid="composer-env-chip" title="本地运行，无云端环境">
            Local
          </span>
          <button
            type="button"
            className="chip chip-btn"
            data-testid="composer-worktree-toggle"
            aria-pressed={useWorktree}
            disabled={!worktreeAvailable}
            title={worktreeHint}
            onClick={() => setUseWorktree((v) => !v)}
          >
            {useWorktree ? 'worktree 隔离' : '原目录'}
          </button>
        </div>
        {/* 第二行·输入区 */}
        <textarea
          ref={inputRef}
          className="composer-input"
          data-testid="composer-input"
          rows={3}
          placeholder="描述这个任务要做什么…（Enter 发送，Shift+Enter 换行）"
          value={text}
          disabled={busy}
          onChange={(e) => props.onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {/* 第三行·动作行：权限档位 chip ｜ 合并 picker + 发送键（右置） */}
        <div className="composer-actions">
          <button
            type="button"
            className="chip chip-btn"
            data-testid="permission-mode-chip"
            data-mode={mode}
            title={MODE_TITLES[mode]}
            onClick={() => setMode(MODE_NEXT[mode])}
          >
            ⚙ {MODE_LABELS[mode]}
          </button>
          <span className="composer-actions-flex" />
          <div className="agent-model-picker">
            <button
              type="button"
              className="chip chip-btn"
              data-testid="agent-model-picker-toggle"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}
            >
              {agentLabel(agentType) || '选择 agent'} ▾
            </button>
            {pickerOpen && (
              <div className="picker-popover" data-testid="agent-model-popover">
                <AgentPicker value={agentType} onChange={setAgentType} />
                <ProviderModelPicker
                  providerId={providerId}
                  model={model}
                  onProviderChange={setProviderId}
                  onModelChange={setModel}
                />
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-btn"
            data-testid="send-button"
            disabled={!canSend}
            onClick={() => void send()}
          >
            {busy ? '创建中…' : '发送'}
          </button>
        </div>
      </div>
      {err && (
        <p className="form-error" role="alert" data-testid="composer-error">
          {err}
        </p>
      )}
    </div>
  );
}
