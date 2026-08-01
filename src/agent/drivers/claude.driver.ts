import { randomUUID } from 'node:crypto';
import type {
  AgentDriver,
  AgentEvent,
  DriverSession,
  DriverStartParams,
  NormalizedToolCall,
  PermissionDecision,
  PermissionRequestPayload,
  SessionEndReason,
} from '../events';
import { matchesAlwaysAllowRule } from '../events';
import type { AgentDriverDefinition } from './registry';
import type {
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Claude Code driver（ticket #19）：Agent SDK 进程内 query()，跑在 utility 进程
 * （contract 测试在纯 Node 下经同一接口驱动，不起 Electron）。
 *
 * 归一规则（claude stream-json → AgentEvent，events.ts 为唯一权威）：
 * - system/init          → session_started（session_id / model / cwd）；
 * - stream_event 的 text/thinking content_block_delta → text_delta / thinking_delta
 *   （includePartialMessages: true；assistant 完整消息里的 text/thinking 块跳过防重）；
 * - assistant 的 tool_use 块 → tool_call(running)；user 的 tool_result 块 → tool_call(done|error)；
 * - canUseTool 回调       → permission_request → permissionHandler → permission_response
 *   （fail-closed：handler 异常/超时一律 deny，ARCHITECTURE §10；
 *     「总是允许」规则命中直接放行——规则形状见 events.ts，#20 注入）；
 * - result               → usage（#27 消费）+ turn_end（success→completed，error_*→failed）；
 * - 进程异常退出/生成器抛错 → error(fatal) + turn_end(failed)。
 *
 * 约定（全 driver 适用）：session_ended 不由 driver 发——宿主在 done 结算时补发，
 * 单一事实源防双发（见 events.ts）。
 *
 * 注入点（DriverStartParams）：executablePath（缺省读 OPEN_COWORK_CLAUDE_CLI，
 * e2e/contract 用 fake CLI 覆盖）/ env（#21 provider 密钥）/ cwd / model
 * （task.model 快照，null 用 SDK 默认）。
 */

/** SDK 为 ESM 单文件——动态 import 避开 main 进程 CJS 打包的 require(esm) 依赖 */
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

/** 多轮输入的可推队列：query({prompt: AsyncIterable}) 的 streaming input 模式 */
function createUserMessageInbox(): {
  iterable: AsyncIterable<SDKUserMessage>;
  push: (text: string) => void;
  close: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let waiter: ((msg: SDKUserMessage | null) => void) | null = null;
  let closed = false;
  return {
    iterable: (async function* () {
      for (;;) {
        const next = await new Promise<SDKUserMessage | null>((resolve) => {
          const queued = queue.shift();
          if (queued) resolve(queued);
          else if (closed) resolve(null);
          else waiter = resolve;
        });
        if (next === null) return;
        yield next;
      }
    })(),
    push: (text) => {
      const msg: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      };
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(msg);
      } else {
        queue.push(msg);
      }
    },
    close: () => {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    },
  };
}

/** 极简工具行的「目标」归纳（icon + 名称 + 目标 + 状态，DESIGN.md §4） */
export function deriveToolTarget(name: string, input: unknown, blockedPath?: string): string | null {
  const obj = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  let target: string | null = null;
  switch (name) {
    case 'Bash':
      target = str(obj.command)?.split('\n')[0] ?? null;
      break;
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      target = str(obj.file_path);
      break;
    case 'Glob':
    case 'Grep':
      target = str(obj.pattern);
      break;
    case 'LS':
      target = str(obj.path);
      break;
    case 'WebFetch':
      target = str(obj.url);
      break;
    case 'WebSearch':
      target = str(obj.query);
      break;
    case 'Task':
    case 'Agent':
      target = str(obj.description) ?? str(obj.prompt);
      break;
    default:
      target = null;
  }
  target = target ?? (blockedPath ?? null);
  if (!target) return null;
  return target.length > 120 ? `${target.slice(0, 120)}…` : target;
}

/** tool_result 内容转纯文本摘要（截断 2000 字符，排障够用即可） */
function toolResultText(content: unknown): string {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
  } else text = JSON.stringify(content ?? '');
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

interface DriverState {
  /** 工具调用 id → 开始时的快照（tool_result 到达时补 status/output） */
  toolCalls: Map<string, NormalizedToolCall>;
  /** 是否有进行中的轮次（取消/异常退出时决定是否补 turn_end） */
  turnActive: boolean;
  cancelled: boolean;
}

/** SDK 消息 → 归一事件（纯函数式分派，便于单测） */
function normalizeMessage(msg: SDKMessage, state: DriverState, emit: (e: AgentEvent) => void): void {
  switch (msg.type) {
    case 'system':
      if ((msg as SDKSystemMessage).subtype === 'init') {
        const init = msg as SDKSystemMessage;
        emit({
          type: 'session_started',
          sessionId: init.session_id,
          model: init.model ?? null,
          cwd: init.cwd ?? '',
        });
      }
      // 其余 system 子类型（task_*、status…）本票不归一
      break;

    case 'stream_event': {
      const ev = msg.event;
      if (ev.type === 'content_block_delta') {
        const delta = ev.delta;
        if (delta.type === 'text_delta') {
          state.turnActive = true;
          emit({ type: 'text_delta', delta: delta.text });
        } else if (delta.type === 'thinking_delta') {
          state.turnActive = true;
          emit({ type: 'thinking_delta', delta: delta.thinking });
        }
      }
      break;
    }

    case 'assistant': {
      const m = msg as SDKAssistantMessage;
      if (m.error) {
        emit({ type: 'error', message: `assistant 消息错误: ${m.error}`, fatal: false });
      }
      for (const block of m.message.content) {
        if (block.type === 'tool_use') {
          state.turnActive = true;
          const call: NormalizedToolCall = {
            id: block.id,
            name: block.name,
            target: deriveToolTarget(block.name, block.input),
            status: 'running',
            input: block.input,
          };
          state.toolCalls.set(block.id, call);
          emit({ type: 'tool_call', call });
        }
        // text / thinking 完整块跳过——流式增量已经 stream_event 发过（防双份）
      }
      break;
    }

    case 'user': {
      const content = (msg as SDKUserMessage).message.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'tool_result') {
          const prev = state.toolCalls.get(block.tool_use_id);
          const isError = Boolean(block.is_error);
          const call: NormalizedToolCall = {
            id: block.tool_use_id,
            name: prev?.name ?? 'unknown',
            target: prev?.target ?? null,
            status: isError ? 'error' : 'done',
            input: prev?.input,
            output: toolResultText(block.content),
            ...(isError ? { error: toolResultText(block.content) } : {}),
          };
          emit({ type: 'tool_call', call });
        }
      }
      break;
    }

    case 'result': {
      const r = msg as SDKResultMessage;
      state.turnActive = false;
      emit({
        type: 'usage',
        usage: {
          inputTokens: r.usage.input_tokens,
          outputTokens: r.usage.output_tokens,
          cacheReadTokens: r.usage.cache_read_input_tokens,
          cacheWriteTokens: r.usage.cache_creation_input_tokens,
          model: Object.keys(r.modelUsage ?? {})[0] ?? null,
          raw: r.usage,
        },
      });
      if (r.subtype === 'success') {
        emit({ type: 'turn_end', status: 'completed' });
      } else {
        const reason =
          'errors' in r && Array.isArray(r.errors) && r.errors.length > 0
            ? r.errors.join('; ')
            : `agent 轮次失败 (${r.subtype})`;
        emit({ type: 'turn_end', status: 'failed', reason });
      }
      break;
    }

    default:
      // 其余 SDK 消息（hook/task/rate_limit 等）本票不归一，静默忽略
      break;
  }
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

/**
 * permission suggestions 的 destination 白名单（audit phase-g）：仅放行 'session'。
 * 其余目的地（userSettings/projectSettings/localSettings/cliArg）会让 CLI 把放行
 * 规则写入用户全局 ~/.claude/settings.json 等持久配置——违反「不碰全局」红线
 * （ARCHITECTURE §10），一律丢弃并记 warn。应用侧规则记忆由 alwaysAllowRules
 * 承担，不依赖 agent 侧持久化。
 */
function filterSessionPermissionUpdates(suggestions: unknown[]): unknown[] {
  return suggestions.filter((s) => {
    const dest = (s as { destination?: unknown } | null)?.destination;
    if (dest === 'session') return true;
    console.warn(
      `[claude-driver] 丢弃非 session 目的地的 permission suggestion (destination=${String(dest)})`,
    );
    return false;
  });
}

class ClaudeDriverSession implements DriverSession {
  readonly done: Promise<{ reason: SessionEndReason; error?: string }>;
  private readonly inbox = createUserMessageInbox();
  private readonly abortController = new AbortController();
  private readonly state: DriverState = { toolCalls: new Map(), turnActive: true, cancelled: false };
  private query: Query | null = null;
  private alive = true;

  constructor(
    sdkPromise: Promise<SdkModule>,
    params: DriverStartParams,
    emit: (e: AgentEvent) => void,
  ) {
    const state = this.state;

    const permissionHandler = params.permissionHandler;
    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: { suggestions?: unknown; blockedPath?: string; decisionReason?: string; title?: string },
    ) => {
      const request: PermissionRequestPayload = {
        id: `perm_${randomUUID()}`,
        toolName,
        target: deriveToolTarget(toolName, input, opts.blockedPath),
        reason: opts.decisionReason ?? opts.title ?? null,
        options: ['allow_once', 'allow_always', 'deny'],
        input,
        suggestions: opts.suggestions ?? null,
      };
      emit({ type: 'permission_request', request });

      // 「总是允许」规则命中直接放行（#20 注入规则集；本票为空）
      const rules = params.alwaysAllowRules ?? [];
      const ruleHit = rules.some((r) => matchesAlwaysAllowRule(r, toolName, request.target));
      let decision: PermissionDecision;
      if (ruleHit) {
        decision = { behavior: 'allow', always: true };
      } else if (!permissionHandler) {
        decision = { behavior: 'deny', message: '未配置审批链路（fail-closed）' };
      } else {
        const timeoutMs = params.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
        try {
          decision = await Promise.race([
            permissionHandler(request),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`审批超时（${timeoutMs}ms）`)), timeoutMs),
            ),
          ]);
        } catch (err) {
          // fail-closed 红线：异常/超时一律 deny（ARCHITECTURE §10）
          decision = {
            behavior: 'deny',
            message: err instanceof Error ? err.message : '审批链路异常（fail-closed）',
          };
        }
      }
      // 决议回执进事件流（全 driver 约定：driver 发，宿主不代发）
      emit({ type: 'permission_response', requestId: request.id, decision });
      if (decision.behavior === 'allow') {
        // 「总是允许」回写 agent 侧规则（ARCHITECTURE §6）——destination 白名单
        // 仅 session；其余目的地丢弃（不碰全局红线，见 filterSessionPermissionUpdates）
        const sessionUpdates =
          decision.always && Array.isArray(opts.suggestions)
            ? filterSessionPermissionUpdates(opts.suggestions)
            : [];
        return {
          behavior: 'allow' as const,
          updatedInput: input,
          ...(sessionUpdates.length > 0 ? { updatedPermissions: sessionUpdates as never } : {}),
        };
      }
      return { behavior: 'deny' as const, message: decision.message ?? '已拒绝' };
    };

    this.done = (async () => {
      let sdk: SdkModule;
      try {
        sdk = await sdkPromise;
      } catch (err) {
        emit({ type: 'error', message: `Agent SDK 加载失败: ${errMsg(err)}`, fatal: true });
        emit({ type: 'turn_end', status: 'failed', reason: 'Agent SDK 加载失败' });
        return { reason: 'failed' as const, error: errMsg(err) };
      }
      const executablePath =
        params.executablePath ?? process.env.OPEN_COWORK_CLAUDE_CLI ?? undefined;
      try {
        this.query = sdk.query({
          prompt: this.inbox.iterable,
          options: {
            cwd: params.cwd,
            ...(params.model ? { model: params.model } : {}),
            // SDK 语义：env 整体替换子进程环境——必须自行并入 process.env（§3 不碰全局，仅注入）
            env: { ...process.env, ...(params.env ?? {}) },
            ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
            abortController: this.abortController,
            includePartialMessages: true,
            canUseTool,
          },
        });
        this.inbox.push(params.prompt);
        for await (const msg of this.query) {
          normalizeMessage(msg, state, emit);
        }
        // 生成器正常结束 = CLI 进程退出
        this.alive = false;
        if (state.turnActive) {
          state.turnActive = false;
          if (state.cancelled) {
            emit({ type: 'turn_end', status: 'cancelled' });
          } else {
            // 进程在轮次中途退出且未抛错（如 fake 脚本 exit 0 但漏发 result）
            emit({ type: 'turn_end', status: 'failed', reason: 'agent 进程在轮次中途退出' });
            return { reason: 'failed' as const, error: 'agent 进程在轮次中途退出' };
          }
        }
        return state.cancelled
          ? { reason: 'cancelled' as const }
          : { reason: 'completed' as const };
      } catch (err) {
        this.alive = false;
        if (state.cancelled || this.abortController.signal.aborted) {
          if (state.turnActive) {
            state.turnActive = false;
            emit({ type: 'turn_end', status: 'cancelled' });
          }
          return { reason: 'cancelled' as const };
        }
        const message = errMsg(err);
        emit({ type: 'error', message, fatal: true });
        if (state.turnActive) {
          state.turnActive = false;
          emit({ type: 'turn_end', status: 'failed', reason: message });
        }
        return { reason: 'failed' as const, error: message };
      } finally {
        this.inbox.close();
      }
    })();
  }

  async sendFollowup(text: string): Promise<void> {
    if (!this.alive) throw new Error('会话已结束，无法追问');
    this.inbox.push(text);
    // turnActive 由后续事件流置位（normalizeMessage 内）
  }

  async cancel(): Promise<void> {
    if (!this.alive) return; // 幂等
    this.alive = false;
    this.state.cancelled = true;
    this.abortController.abort();
    try {
      this.query?.close();
    } catch {
      // 进程已退出竞态：忽略
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class ClaudeDriver implements AgentDriver {
  readonly id = 'claude-code';
  start(params: DriverStartParams, emit: (e: AgentEvent) => void): DriverSession {
    // 注意：cancel() 依赖 turnActive 状态——放在 session 内部（见上）。
    // cancel 时 turn_end(cancelled) 的发射：cancel() 后生成器抛 AbortError，
    // done 包装里补发；这里无需额外处理。
    return new ClaudeDriverSession(import('@anthropic-ai/claude-agent-sdk'), params, emit);
  }
}

const definition: AgentDriverDefinition = {
  id: 'claude-code',
  displayName: 'Claude Code',
  approval: 'native',
  create: () => new ClaudeDriver(),
};

export default definition;
