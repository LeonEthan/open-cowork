import { useEffect, useRef, useState } from 'react';
import type { PermissionMode, Workspace, WorkspaceWorktreeInfo } from '../../../shared/api';
import { agentLabel } from '../lib/taskStatus';
import { useAgentsStore } from '../stores/agents';
import { useAppStore } from '../stores/appStore';
import { errMessage, useDataStore } from '../stores/data';
import { useUiStore } from '../stores/ui';
import { AgentPicker } from './pickers/AgentPicker';
import { PermissionModePicker } from './pickers/PermissionModePicker';
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

/** starter 卡片文案（2–4 张，§4；点击预填 composer 占位文案）
 *  Codex 对齐（附录 B）：卡片补 icon——currentColor inline SVG，白名单色（--ink-2） */
const STARTERS: ReadonlyArray<{
  key: string;
  label: string;
  prefill: string;
  icon: () => React.JSX.Element;
}> = [
  {
    key: 'explore',
    label: '探索并理解代码',
    prefill: '探索这个代码库：梳理整体结构、关键模块与数据流，给我一份导览。',
    icon: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
        <path d="m10.8 5.2-1.4 4.2-4.2 1.4 1.4-4.2 4.2-1.4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'feature',
    label: '构建新功能',
    prefill: '构建一个新功能：',
    icon: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M9.5 2.5 13.5 6.5 6 14H2v-4l7.5-7.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="m8 4 4 4" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
  {
    key: 'fix',
    label: '修复问题',
    prefill: '修复一个问题：',
    icon: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M10.5 2.5a3.5 3.5 0 0 0-4.6 4.3L2.5 10.2a1.6 1.6 0 1 0 2.3 2.3l3.4-3.4a3.5 3.5 0 0 0 4.3-4.6l-2.2 2.2-2-.5-.5-2 2.3-2.2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'free',
    label: '自由任务',
    prefill: '',
    icon: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 3v-11Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function HomeView(): React.JSX.Element {
  const workspaces = useDataStore((s) => s.workspaces);
  const requestComposerFocus = useUiStore((s) => s.requestComposerFocus);
  // Codex 对齐（附录 B）：侧栏 workspace 行选中态 —— hero 与 composer 跟随
  const currentWorkspaceId = useAppStore((s) => s.currentWorkspaceId);
  const [workspaceId, setWorkspaceId] = useState('');
  const [text, setText] = useState('');

  // workspace 列表变化（首个添加/移除）时保持有效选择；侧栏选中的 workspace 优先
  useEffect(() => {
    if (currentWorkspaceId && workspaces.some((w) => w.id === currentWorkspaceId)) {
      if (workspaceId !== currentWorkspaceId) setWorkspaceId(currentWorkspaceId);
      return;
    }
    if (!workspaces.some((w) => w.id === workspaceId)) {
      setWorkspaceId(workspaces[0]?.id ?? '');
    }
  }, [workspaces, workspaceId, currentWorkspaceId]);

  const ws = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? null;

  return (
    <div className="home-view" data-testid="home-view">
      {/* Codex 对齐（附录 B 复核第三轮）：无 workspace 时主页结构不变——hero +
          starter 卡片 + composer 常驻；仅问句与 composer 上下文项退化（选择目录） */}
      <div className="home-hero" data-testid="home-hero">
        <HeroMark />
        {ws ? (
          <h1 className="hero-question">
            想在 <span className="hero-ws">{ws.name}</span> 里做点什么？
          </h1>
        ) : (
          <h1 className="hero-question">想做点什么？</h1>
        )}
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
              <span className="starter-icon" aria-hidden="true">
                <s.icon />
              </span>
              <span className="starter-label">{s.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="composer-dock">
        <HomeComposer
          workspaces={workspaces}
          workspaceId={ws?.id ?? ''}
          onWorkspaceChange={(id) => {
            setWorkspaceId(id);
            // composer 内切换 workspace 同样回写侧栏选中态（附录 B 双向跟随）
            useAppStore.getState().setCurrentWorkspaceId(id);
          }}
          text={text}
          onTextChange={setText}
        />
      </div>
    </div>
  );
}

/** 空态标记（Codex 对齐，附录 B 视觉复核）：rosette 徽章 + 终端字形（❯_），ink-3 单色线稿 */
function HeroMark(): React.JSX.Element {
  return (
    <div className="hero-logo" data-testid="hero-logo">
      <svg width="56" height="56" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path
          d="M59.0 32.0 L58.5 33.7 L57.1 35.3 L55.4 36.7 L54.2 38.0 L54.6 39.7 L55.4 41.7 L55.8 43.7 L55.4 45.5 L54.1 46.7 L52.1 47.4 L49.9 47.7 L48.3 48.3 L47.7 49.9 L47.4 52.1 L46.7 54.1 L45.5 55.4 L43.7 55.8 L41.7 55.4 L39.7 54.6 L38.0 54.2 L36.7 55.4 L35.3 57.1 L33.7 58.5 L32.0 59.0 L30.3 58.5 L28.7 57.1 L27.3 55.4 L26.0 54.2 L24.3 54.6 L22.3 55.4 L20.3 55.8 L18.5 55.4 L17.3 54.1 L16.6 52.1 L16.3 49.9 L15.7 48.3 L14.1 47.7 L11.9 47.4 L9.9 46.7 L8.6 45.5 L8.2 43.7 L8.6 41.7 L9.4 39.7 L9.8 38.0 L8.6 36.7 L6.9 35.3 L5.5 33.7 L5.0 32.0 L5.5 30.3 L6.9 28.7 L8.6 27.3 L9.8 26.0 L9.4 24.3 L8.6 22.3 L8.2 20.3 L8.6 18.5 L9.9 17.3 L11.9 16.6 L14.1 16.3 L15.7 15.7 L16.3 14.1 L16.6 11.9 L17.3 9.9 L18.5 8.6 L20.3 8.2 L22.3 8.6 L24.3 9.4 L26.0 9.8 L27.3 8.6 L28.7 6.9 L30.3 5.5 L32.0 5.0 L33.7 5.5 L35.3 6.9 L36.7 8.6 L38.0 9.8 L39.7 9.4 L41.7 8.6 L43.7 8.2 L45.5 8.6 L46.7 9.9 L47.4 11.9 L47.7 14.1 L48.3 15.7 L49.9 16.3 L52.1 16.6 L54.1 17.3 L55.4 18.5 L55.8 20.3 L55.4 22.3 L54.6 24.3 L54.2 26.0 L55.4 27.3 L57.1 28.7 L58.5 30.3 Z"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {/* 终端字形 ❯_ */}
        <path d="m26 26 6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M35 39h8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** 无 workspace 的退化 hero：添加 workspace 引导（复用侧栏同一桥能力） */
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
  const addWorkspaceViaDialog = useDataStore((s) => s.addWorkspaceViaDialog);
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
  // Codex 对齐（附录 B）：同机拉取当前 git 分支（上下文行分支 chip；非 git 不渲染）
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    const api = window.openCowork;
    if (!api || workspaceId.length === 0) {
      setWtInfo(null);
      setUseWorktree(false);
      setBranch(null);
      return;
    }
    let cancelled = false;
    void api.worktree.workspaceCheck(workspaceId).then((info) => {
      if (cancelled) return;
      setWtInfo(info);
      if (!info.isGitRepo || !info.hasCommits) setUseWorktree(false);
    });
    void api.workspaces.currentBranch(workspaceId).then((info) => {
      if (!cancelled) setBranch(info.isGitRepo ? info.branch : null);
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
        {/* 第一行·上下文行（Codex 对齐，附录 B 视觉复核）：分段条——bg-soft 顶条内
            icon+文字项（workspace / Local / 分支 / 原目录·worktree），无边框 chip */}
        <div className="composer-context">
          {/* Codex「Choose project」位：无 workspace 时上下文项 = 选择目录入口 */}
          {workspaces.length === 0 ? (
            <button
              type="button"
              className="context-item context-btn"
              data-testid="composer-choose-project"
              title="agent 只在你添加的本地目录里工作——本地优先，无云端环境"
              onClick={() => void addWorkspaceViaDialog()}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 5.5 8 2l6 3.5v5L8 14l-6-3.5v-5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M2 5.5 8 9l6-3.5M8 9v5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
              选择目录…
            </button>
          ) : (
            <span className="context-item">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 5.5 8 2l6 3.5v5L8 14l-6-3.5v-5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M2 5.5 8 9l6-3.5M8 9v5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
              <select
                className="context-select"
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
            </span>
          )}
          <span className="context-item" data-testid="composer-env-chip" title="本地运行，无云端环境">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 13.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            Local
          </span>
          {/* Codex 对齐（附录 B）：当前 git 分支 chip（非 git workspace 不渲染） */}
          {branch && (
            <span className="context-item mono" data-testid="composer-branch-chip" title="当前 git 分支">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="4.5" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="11.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
                <path d="M4.5 6v4a3 3 0 0 0 3 3h2" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              {branch}
            </span>
          )}
          {workspaces.length > 0 && (
            <button
              type="button"
              className="context-item context-btn"
              data-testid="composer-worktree-toggle"
              aria-pressed={useWorktree}
              disabled={!worktreeAvailable}
              title={worktreeHint}
              onClick={() => setUseWorktree((v) => !v)}
            >
              {useWorktree ? 'worktree 隔离' : '原目录'}
            </button>
          )}
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
        {/* 第三行·动作行：权限档位 chip（弹层，§4 附录 B）｜ 合并 picker + 发送键（右置） */}
        <div className="composer-actions">
          <PermissionModePicker mode={mode} onChange={setMode} />
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
            className="send-circle"
            data-testid="send-button"
            disabled={!canSend}
            title={busy ? '创建中…' : '发送'}
            onClick={() => void send()}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 13V3m0 0-4 4m4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
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
