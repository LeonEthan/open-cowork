import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentDriver,
  AgentEvent,
  AlwaysAllowRule,
  DriverSession,
  DriverStartParams,
  NormalizedToolCall,
  SessionEndReason,
} from '../events';
import { createLineSplitter } from './jsonRpcPeer';
import type { AgentDriverDefinition } from './registry';

/**
 * pi driver（ticket #23）：spawn `pi --mode rpc`，stdio 上跑 JSONL 命令/事件协议。
 * 协议形状以本机 pi 0.83.0 实测 + 官方 docs/rpc.md 为准：
 *
 *   client → pi（命令，id 关联响应）：
 *     {"id","type":"prompt","message"}      → {"id","type":"response","command":"prompt","success":bool,"error?}
 *     {"type":"follow_up","message"}        → 同上（本 driver 追问统一用 prompt，空闲期语义等价）
 *     {"type":"abort"}                      → 取消当前轮次（尽力而为，kill 为权威路径）
 *     {"type":"get_state"}                  → data:{model,sessionId,…}（握手兼存活探测）
 *   pi → client（事件流）：
 *     agent_start / agent_end{willRetry} / agent_settled   一轮 run 的生命周期（settled=权威完结）
 *     turn_start / turn_end{message,toolResults}           一次 LLM 往返；message.usage 为用量源
 *     message_update{assistantMessageEvent}                text_delta/thinking_delta 流式增量
 *     tool_execution_start/update/end{toolCallId,toolName,args,result,isError}
 *     extension_ui_request（仅扩展发出）                   对话框一律立即回 cancelled（fail-closed）
 *
 * ── 审批：降级接入（ARCHITECTURE §2：pi 无内建工具审批模型）──
 * pi 的 trust 模型只管项目资源加载（--approve），不管工具调用；RPC 协议没有任何
 * 审批/权限交互原语（Extension UI Protocol 是扩展专用 UI 子协议，非内建审批）。
 * 因此审批走**静态策略兜底**：会话启动时把（任务权限档位 + 「总是允许」规则快照）
 * 按 #20 策略引擎语义翻译成 pi 原生 `--tools` 允许清单（translatePiStaticPolicy 纯函数）：
 *   只读档 → 仅读类工具（read/grep/find/ls），写类与 bash 禁用；
 *   自动档 → 读类 + 规则覆盖的工具（目标模式无法用启动旗标表达——有规则的工具
 *            整体放行，这是降级的固有近似，rules 为全局表跨 agent 共享）；
 *   放权档 → 不加 --tools 限制。
 * 运行期纵深防御（fail-closed §10）：tool_execution_start 出现清单外工具
 * （版本漂移/扩展注入绕过旗标）→ 立即终止会话并 turn_end(failed)。
 *
 * 注入点（DriverStartParams）：executablePath（缺省 OPEN_COWORK_PI_CLI，再缺省 'pi'）/
 * env（#21 provider：PI_CODING_AGENT_DIR 指向生成的 models.json + 密钥 env 名）/ cwd / model
 * （--model 旗标）。permissionMode 无 DriverStartParams 字段（events.ts 冻结）——
 * utility 宿主以结构化附加字段透传（见 index.ts #23 注释），本 driver 以
 * PiDriverStartParams 收窄读取；缺省 'auto'（无规则时等价只读面，fail-closed 保守）。
 * 约定同其他 driver：session_ended 由宿主在 done 结算时补发，driver 不发。
 */

const KILL_GRACE_MS = 2_000;

/** 权限档位（与 main/db/entities.ts 的 PermissionMode 同构；适配层不反向依赖 main，字面量复刻） */
export type PiPermissionMode = 'readonly' | 'auto' | 'full';

/** pi driver 的扩展启动参数（utility 透传的附加字段；events.ts 冻结期的合法缝隙） */
export interface PiDriverStartParams extends DriverStartParams {
  permissionMode?: PiPermissionMode;
}

// ── 静态审批翻译（#20 策略引擎语义 → pi 启动旗标；纯函数，表驱动测试） ──────

/** pi 内建工具全集（0.83.0 实测：dist/core/tools 七件） */
export const PI_BUILTIN_TOOLS = ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'] as const;

/**
 * 读类工具（只读档放行面）：本地只读，无写、无命令执行、无联网。
 * 与 #20 policy.ts 的 READ_ONLY_TOOLS（Read/Glob/Grep/LS/NotebookRead）语义对齐的 pi 侧映射。
 */
export const PI_READ_ONLY_TOOLS: readonly string[] = ['find', 'grep', 'ls', 'read'];

/**
 * 「总是允许」规则工具名 → pi 原生工具名。规则为全局表（跨 agent 共享），
 * 名字以 claude 风格为主（托盘来源）；小写原名直通（pi 自身工具名）。
 * 白名单外一律 null（fail-closed 保守映射：不认得的工具不构成放行依据）。
 */
const RULE_TOOL_TO_PI: Record<string, string> = {
  Bash: 'bash',
  Edit: 'edit',
  Write: 'write',
  Read: 'read',
  Glob: 'find',
  Grep: 'grep',
  LS: 'ls',
  NotebookRead: 'read',
  bash: 'bash',
  edit: 'edit',
  write: 'write',
  read: 'read',
  find: 'find',
  grep: 'grep',
  ls: 'ls',
};

/** 规则工具名 → pi 原生工具名（未映射返回 null） */
export function mapRuleToolToPi(tool: string): string | null {
  return RULE_TOOL_TO_PI[tool] ?? null;
}

/** 静态策略翻译结果 */
export interface PiStaticPolicy {
  mode: PiPermissionMode;
  /**
   * 传给 `--tools` 的允许清单（pi 原生工具名，升序去重）；
   * null = 不附加 --tools 旗标（完全放权，pi 全工具可用）。
   */
  allowedTools: string[] | null;
  /** 人类可读摘要（stderr 日志 / 排障） */
  summary: string;
}

/**
 * 静态策略翻译（纯函数）：权限档位 + 规则快照 → pi `--tools` 允许清单。
 * 语义对齐 #20 decidePermission 的三档裁决，差异只在表达力：
 * pi 启动旗标是工具粒度，规则的目标模式（如 `Bash: npm *`）无法静态表达——
 * 自动档下有任一规则命中的工具整体进允许清单（降级固有近似，见文件头注释）。
 *
 * ticket #31 核实：本翻译**不消费** target 投影也不做文本匹配（只读 rule.tool），
 * #31 的有损投影缺陷不涉及 pi 路径；pi 侧授权粒度由 pi 自身 --tools 配置语义
 * + 运行期 guardStaticPolicy 纵深防御决定。
 */
export function translatePiStaticPolicy(
  mode: PiPermissionMode,
  rules: readonly AlwaysAllowRule[],
): PiStaticPolicy {
  if (mode === 'full') {
    return { mode, allowedTools: null, summary: '完全放权：不附加 --tools 限制，pi 全工具可用' };
  }
  if (mode === 'readonly') {
    return {
      mode,
      allowedTools: [...PI_READ_ONLY_TOOLS],
      summary: `只读：仅放行读类工具（${PI_READ_ONLY_TOOLS.join('/')}），写类与 bash 禁用`,
    };
  }
  // auto：读类 + 规则覆盖的工具
  const allowed = new Set<string>(PI_READ_ONLY_TOOLS);
  for (const rule of rules) {
    const piTool = mapRuleToolToPi(rule.tool);
    if (piTool) allowed.add(piTool);
  }
  const list = [...allowed].sort();
  const extra = list.filter((t) => !PI_READ_ONLY_TOOLS.includes(t));
  return {
    mode,
    allowedTools: list,
    summary:
      extra.length > 0
        ? `自动：读类工具 + 规则放行 ${extra.join('/')}（目标模式无法静态表达，工具整体放行）`
        : '自动：无命中规则——仅放行读类工具（等价只读面）',
  };
}

/** pi 启动参数组装（纯函数；e2e 经 fake 启动回显断言 --tools 禁写语义） */
export function buildPiArgs(input: {
  model?: string | null;
  policy: PiStaticPolicy;
}): string[] {
  const args = ['--mode', 'rpc', '--no-session'];
  if (input.model) args.push('--model', input.model);
  if (input.policy.allowedTools) args.push('--tools', input.policy.allowedTools.join(','));
  return args;
}

// ── 事件归一 ─────────────────────────────────────────────────────────────

/** pi 原生工具名 → 归一工具名（与 claude 风格对齐，UI/规则口径一致；未知工具原名直通） */
function normalizeToolName(piTool: string): string {
  switch (piTool) {
    case 'bash':
      return 'Bash';
    case 'edit':
      return 'Edit';
    case 'write':
      return 'Write';
    case 'read':
      return 'Read';
    case 'grep':
      return 'Grep';
    case 'find':
      return 'Glob';
    case 'ls':
      return 'LS';
    default:
      return piTool;
  }
}

/** 极简工具行的目标归纳（兼容 pi 原生键 path/command 与 claude 风格键 file_path） */
function derivePiToolTarget(piTool: string, args: unknown): string | null {
  const obj = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  switch (piTool) {
    case 'bash':
      return str(obj.command)?.split('\n')[0] ?? null;
    case 'read':
    case 'write':
    case 'edit':
      return str(obj.path) ?? str(obj.file_path) ?? str(obj.filePath);
    case 'grep':
    case 'find':
      return str(obj.pattern);
    case 'ls':
      return str(obj.path);
    default:
      return str(obj.path) ?? str(obj.command) ?? null;
  }
}

/** tool_execution_end.result.content[] → 输出文本（截断与 codex 同口径 2000） */
function resultText(result: unknown): string | null {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((c): c is { type: string; text: string } =>
      Boolean(c) &&
      typeof c === 'object' &&
      (c as { type?: unknown }).type === 'text' &&
      typeof (c as { text?: unknown }).text === 'string',
    )
    .map((c) => c.text)
    .join('');
  if (text.length === 0) return null;
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

interface TurnUsageAcc {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 本轮见到的 turn_end 数（>0 才发 usage 事件） */
  turns: number;
  /** 最近一次 turn_end 的 message.model */
  model: string | null;
}

interface PiState {
  child: ChildProcess;
  sessionId: string | null;
  model: string | null;
  cwd: string;
  policy: PiStaticPolicy;
  turnActive: boolean;
  cancelled: boolean;
  /** fail-closed 终止原因（静态策略违反等）；exit 结算优先消费 */
  failureReason: string | null;
  toolCalls: Map<string, NormalizedToolCall>;
  /** wire toolCallId → pi 原生工具名（tool_execution_end 归一用） */
  toolRawNames: Map<string, string>;
  usageAcc: TurnUsageAcc;
  /** 本轮最近一次 turn_end 的 stopReason / 错误消息（agent_settled 终态映射） */
  lastStopReason: string | null;
  lastErrorMessage: string | null;
  stderrTail: string;
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }, KILL_GRACE_MS);
  child.once('exit', () => clearTimeout(timer));
}

class PiDriverSession implements DriverSession {
  readonly done: Promise<{ reason: SessionEndReason; error?: string }>;
  private readonly state: PiState;
  private alive = true;
  private nextCmdId = 1;
  private readonly pendingCommands = new Map<string, PendingCommand>();

  constructor(
    private readonly params: PiDriverStartParams,
    private readonly emit: (e: AgentEvent) => void,
  ) {
    const executable = params.executablePath ?? process.env.OPEN_COWORK_PI_CLI ?? 'pi';
    const mode: PiPermissionMode = params.permissionMode ?? 'auto';
    const policy = translatePiStaticPolicy(mode, params.alwaysAllowRules ?? []);
    const args = buildPiArgs({ model: params.model ?? null, policy });
    const child = spawn(executable, args, {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.state = {
      child,
      sessionId: null,
      model: params.model ?? null,
      cwd: params.cwd,
      policy,
      turnActive: false,
      cancelled: false,
      failureReason: null,
      toolCalls: new Map(),
      toolRawNames: new Map(),
      usageAcc: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, model: null },
      lastStopReason: null,
      lastErrorMessage: null,
      stderrTail: `静态审批策略[${mode}]: ${policy.summary}`,
    };

    child.stdout.setEncoding('utf8');
    const feed = createLineSplitter((line) => this.onLine(line));
    child.stdout.on('data', (chunk: string) => feed(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.state.stderrTail = (this.state.stderrTail + chunk).slice(-2000);
    });

    let resolveDone!: (v: { reason: SessionEndReason; error?: string }) => void;
    this.done = new Promise((r) => {
      resolveDone = r;
    });

    child.once('error', (err) => {
      // spawn 失败（ENOENT 等）：exit 不一定触发，这里兜底
      this.alive = false;
      const message = `pi 启动失败: ${err.message}`;
      emit({ type: 'error', message, fatal: true });
      emit({ type: 'turn_end', status: 'failed', reason: message });
      resolveDone({ reason: 'failed', error: message });
    });

    child.once('exit', (code, signal) => {
      this.alive = false;
      this.rejectPendingCommands(new Error('pi 进程已退出'));
      const s = this.state;
      if (s.cancelled) {
        if (s.turnActive) {
          s.turnActive = false;
          emit({ type: 'turn_end', status: 'cancelled' });
        }
        resolveDone({ reason: 'cancelled' });
        return;
      }
      if (s.failureReason) {
        // fail-closed 终止（静态策略违反）：turn_end 已在触发点发出
        resolveDone({ reason: 'failed', error: s.failureReason });
        return;
      }
      if (s.turnActive || (code !== 0 && code !== null) || signal) {
        const detail =
          s.stderrTail.trim() || `pi 进程退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        const message = `pi 会话异常终止: ${detail}`;
        emit({ type: 'error', message, fatal: true });
        if (s.turnActive) {
          s.turnActive = false;
          emit({ type: 'turn_end', status: 'failed', reason: message });
        }
        resolveDone({ reason: 'failed', error: message });
        return;
      }
      resolveDone({ reason: 'completed' });
    });

    void this.handshake(params).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (this.alive) {
        this.alive = false;
        emit({ type: 'error', message, fatal: true });
        emit({ type: 'turn_end', status: 'failed', reason: message });
        killChild(child);
        resolveDone({ reason: 'failed', error: message });
      }
    });
  }

  /** get_state（握手兼存活探测）→ session_started → 首轮 prompt */
  private async handshake(params: PiDriverStartParams): Promise<void> {
    const s = this.state;
    const data = (await this.call('get_state')) as {
      sessionId?: unknown;
      model?: { id?: unknown } | null;
    } | null;
    if (typeof data?.sessionId === 'string' && data.sessionId.length > 0) {
      s.sessionId = data.sessionId;
    }
    const stateModel = data?.model && typeof data.model.id === 'string' ? data.model.id : null;
    if (stateModel) s.model = stateModel;
    this.emit({
      type: 'session_started',
      sessionId: s.sessionId ?? `pi-${randomUUID()}`,
      model: s.model,
      cwd: s.cwd,
    });
    await this.startTurn(params.prompt);
  }

  private startTurn(text: string): Promise<void> {
    const s = this.state;
    s.turnActive = true;
    return this.call('prompt', { message: text }).then(
      () => undefined,
      (err: unknown) => {
        s.turnActive = false;
        throw err;
      },
    );
  }

  /** 发命令并等 id 关联的 response；success:false → reject（fail-closed 交调用方归一） */
  private call(type: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const s = this.state;
    if (!this.alive) return Promise.reject(new Error('pi 会话已结束'));
    const id = `oc-${this.nextCmdId++}`;
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });
      try {
        s.child.stdin?.write(`${JSON.stringify({ id, type, ...extra })}\n`);
      } catch (err) {
        this.pendingCommands.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private rejectPendingCommands(err: Error): void {
    for (const p of this.pendingCommands.values()) p.reject(err);
    this.pendingCommands.clear();
  }

  // ── stdout 帧分派 ────────────────────────────────────────────────────────

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit({ type: 'error', message: `pi 协议帧解析失败: ${line.slice(0, 200)}`, fatal: false });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.type === 'response') {
      this.onResponse(msg);
      return;
    }
    this.onEvent(msg);
  }

  private onResponse(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' ? msg.id : null;
    if (!id) return; // 无 id 响应（不应出现——我方命令一律带 id）：忽略
    const pending = this.pendingCommands.get(id);
    if (!pending) return; // 迟到/陌生响应：吞掉
    this.pendingCommands.delete(id);
    if (msg.success === false) {
      const detail = typeof msg.error === 'string' ? msg.error : '未知错误';
      pending.reject(new Error(`pi ${String(msg.command ?? '命令')} 被拒绝: ${detail}`));
      return;
    }
    pending.resolve(msg.data ?? null);
  }

  private onEvent(msg: Record<string, unknown>): void {
    const s = this.state;
    switch (msg.type) {
      case 'agent_start': {
        s.turnActive = true;
        s.usageAcc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, model: null };
        s.lastStopReason = null;
        s.lastErrorMessage = null;
        break;
      }

      case 'message_update': {
        const ev = msg.assistantMessageEvent as { type?: unknown; delta?: unknown; reason?: unknown; errorMessage?: unknown } | undefined;
        if (!ev || typeof ev.type !== 'string') break;
        if (ev.type === 'text_delta' && typeof ev.delta === 'string' && ev.delta.length > 0) {
          this.emit({ type: 'text_delta', delta: ev.delta });
        } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string' && ev.delta.length > 0) {
          this.emit({ type: 'thinking_delta', delta: ev.delta });
        } else if (ev.type === 'error' && ev.reason !== 'aborted') {
          // 消息流错误（终态经 turn_end/agent_settled 映射，这里只留原因）
          s.lastErrorMessage =
            typeof ev.errorMessage === 'string' ? ev.errorMessage : 'pi 消息流错误';
        }
        break;
      }

      case 'tool_execution_start': {
        const call = this.toolCallFromWire(msg);
        if (!call) break;
        s.toolCalls.set(call.id, call);
        const raw = typeof msg.toolName === 'string' ? msg.toolName : 'unknown';
        s.toolRawNames.set(call.id, raw);
        this.emit({ type: 'tool_call', call });
        this.guardStaticPolicy(call.id, raw);
        break;
      }

      case 'tool_execution_update':
        // 进度帧不归一（与 codex 同口径——end 帧携带最终结果）
        break;

      case 'tool_execution_end': {
        const id = typeof msg.toolCallId === 'string' ? msg.toolCallId : null;
        if (!id) break;
        const prev = s.toolCalls.get(id);
        const raw = s.toolRawNames.get(id) ?? (typeof msg.toolName === 'string' ? msg.toolName : 'unknown');
        const isError = msg.isError === true;
        const output = resultText(msg.result);
        const call: NormalizedToolCall = {
          ...(prev ?? {
            id,
            name: normalizeToolName(raw),
            target: derivePiToolTarget(raw, msg.args),
            status: 'running' as const,
          }),
          status: isError ? 'error' : 'done',
          output,
          ...(isError ? { error: output ?? 'pi 工具执行失败' } : {}),
        };
        s.toolCalls.set(id, call);
        this.emit({ type: 'tool_call', call });
        break;
      }

      case 'turn_end': {
        // pi 一轮 run 可含多个 wire turn（工具循环）；usage 逐 turn 累计，agent_settled 一次性归一
        const message = msg.message as
          | { usage?: Record<string, unknown>; model?: unknown; stopReason?: unknown; errorMessage?: unknown }
          | undefined;
        const usage = message?.usage;
        if (usage) {
          s.usageAcc.inputTokens += typeof usage.input === 'number' ? usage.input : 0;
          s.usageAcc.outputTokens += typeof usage.output === 'number' ? usage.output : 0;
          s.usageAcc.cacheReadTokens += typeof usage.cacheRead === 'number' ? usage.cacheRead : 0;
          s.usageAcc.cacheWriteTokens += typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0;
          s.usageAcc.turns += 1;
        }
        if (typeof message?.model === 'string') s.usageAcc.model = message.model;
        if (typeof message?.stopReason === 'string') s.lastStopReason = message.stopReason;
        if (typeof message?.errorMessage === 'string') s.lastErrorMessage = message.errorMessage;
        break;
      }

      case 'agent_end':
        // willRetry=true 时随后还有自动重试——run 未完结，什么都不做
        break;

      case 'agent_settled': {
        // 一轮 run 权威完结：usage 归一（ARCHITECTURE §9：pi turn_end 归一而来）+ turn_end 终态
        s.turnActive = false;
        const u = s.usageAcc;
        if (u.turns > 0) {
          this.emit({
            type: 'usage',
            usage: {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
              model: u.model ?? s.model,
              raw: { source: 'pi turn_end 累计', turns: u.turns },
            },
          });
        }
        if (s.cancelled || s.lastStopReason === 'aborted') {
          this.emit({ type: 'turn_end', status: 'cancelled' });
        } else if (s.lastStopReason === 'error') {
          this.emit({
            type: 'turn_end',
            status: 'failed',
            reason: s.lastErrorMessage ?? 'pi 轮次失败',
          });
        } else {
          this.emit({ type: 'turn_end', status: 'completed' });
        }
        break;
      }

      case 'extension_ui_request': {
        // 扩展 UI 子协议（非内建审批）：对话框一律立即回 cancelled——fail-closed，
        // 绝不让扩展挂起等用户（本应用的用户交互不走 pi 扩展通道）
        const id = typeof msg.id === 'string' ? msg.id : null;
        const method = typeof msg.method === 'string' ? msg.method : '';
        if (id && ['select', 'confirm', 'input', 'editor'].includes(method)) {
          try {
            s.child.stdin?.write(
              `${JSON.stringify({ type: 'extension_ui_response', id, cancelled: true })}\n`,
            );
          } catch {
            // 进程已死：exit 流程收尾
          }
          this.emit({
            type: 'error',
            message: `pi 扩展请求对话框（${method}），已按 fail-closed 自动取消`,
            fatal: false,
          });
        }
        // fire-and-forget（notify/setStatus/…）：忽略
        break;
      }

      case 'extension_error': {
        const detail = typeof msg.error === 'string' ? msg.error : 'pi 扩展错误';
        this.emit({ type: 'error', message: detail, fatal: false });
        break;
      }

      default:
        // turn_start / message_start / message_end / queue_update / compaction_* /
        // auto_retry_* / summarization_* / bash_execution_update：不归一
        break;
    }
  }

  private toolCallFromWire(msg: Record<string, unknown>): NormalizedToolCall | null {
    const id = typeof msg.toolCallId === 'string' ? msg.toolCallId : null;
    if (!id) return null;
    const raw = typeof msg.toolName === 'string' ? msg.toolName : 'unknown';
    return {
      id,
      name: normalizeToolName(raw),
      target: derivePiToolTarget(raw, msg.args),
      status: 'running',
      input: msg.args ?? null,
    };
  }

  /**
   * 静态策略纵深防御（fail-closed §10）：清单外工具开始执行 =
   * --tools 旗标语义被绕过（版本漂移/扩展注入）——工具已在跑无法拦截，
   * 立即终止会话并标 failed，绝不容忍继续执行。
   */
  private guardStaticPolicy(callId: string, rawToolName: string): void {
    const s = this.state;
    const allowed = s.policy.allowedTools;
    if (!allowed || allowed.includes(rawToolName)) return;
    const message = `pi 执行了静态策略禁止的工具「${rawToolName}」（档位 ${s.policy.mode}，允许清单 ${allowed.join(',')}），会话已 fail-closed 终止`;
    this.emit({ type: 'error', message, fatal: true });
    s.failureReason = message;
    if (s.turnActive) {
      s.turnActive = false;
      this.emit({ type: 'turn_end', status: 'failed', reason: message });
    }
    killChild(s.child);
  }

  async sendFollowup(text: string): Promise<void> {
    if (!this.alive) throw new Error('会话已结束，无法追问');
    if (this.state.turnActive) throw new Error('上一轮尚未结束');
    await this.startTurn(text);
  }

  async cancel(): Promise<void> {
    if (!this.alive) return; // 幂等
    this.state.cancelled = true;
    // 尽力 abort（轮次语义），随后杀进程（权威路径）；exit 流程补 turn_end(cancelled)
    try {
      await Promise.race([
        this.call('abort'),
        new Promise((r) => setTimeout(r, 1_000)),
      ]);
    } catch {
      // 进程已死/对端不应答：忽略，kill 兜底
    }
    killChild(this.state.child);
  }
}

class PiDriver implements AgentDriver {
  readonly id = 'pi';
  start(params: DriverStartParams, emit: (e: AgentEvent) => void): DriverSession {
    return new PiDriverSession(params as PiDriverStartParams, emit);
  }
}

const definition: AgentDriverDefinition = {
  id: 'pi',
  displayName: 'pi',
  // 降级接入：pi 无内建审批，适配层静态策略兜底（ARCHITECTURE §2）
  approval: 'degraded',
  create: () => new PiDriver(),
};

export default definition;
