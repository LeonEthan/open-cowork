import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDriverDefinition, listDrivers } from './drivers/registry';
// ticket #26（additive 独立行，并行票据零冲突合并约定）：自定义 ACP agent 动态实例
import { createCustomDriverDefinition } from './drivers/registry';
import type { CustomAgentSpec } from './drivers/registry';
import type {
  AgentEvent,
  DriverStartParams,
  PermissionDecision,
  PermissionHandler,
  PermissionRequestPayload,
} from './events';
import { ProcessRegistry } from './processRegistry';

/**
 * utility 进程（agent 适配层宿主）入口（ticket #19，ARCHITECTURE §1/§2）。
 *
 * 职责：
 * 1. 会话治理：按 main 的指令 start/followup/cancel driver 会话（Task 与 session 1:1）；
 * 2. 事件双通道：driver 归一事件 →
 *    a) MessageChannel 端口直连 renderer（实时流式渲染，高频不过 main）；
 *    b) process.parentPort → main（Turn/Message/ToolCall/UsageRecord 持久化 + 状态机迁移）；
 * 3. JSONL 旁路：原始归一事件与入向指令逐行写
 *    <dataDir>/events/<taskId>/<sessionId>.jsonl（排障/回放，ARCHITECTURE §5）；
 * 4. 进程注册表两级清理：运行时 Map + 启动时 sweepStale（见 processRegistry.ts）；
 * 5. 审批中继（ticket #20 替换全允许桩）：driver permissionHandler → permission-ask
 *    转发 main 审批服务（策略引擎/托盘决议），agent-command permission-respond 回执
 *    resolve 挂起的 handler。fail-closed 红线不变：handler 异常/超时 driver 层 deny；
 *    会话终结时本进程内挂起的请求一律立即 deny 结清（不悬挂等 120s 超时）。
 *
 * 与 main 的协议（parentPort）：
 *   in : {type:'init', dataDir}
 *        {type:'agent-command', command: StartCommand | FollowupCommand | CancelCommand | PermissionRespondCommand}
 *        {type:'agent-port'}（附带 MessagePort，见 services/system.ts 接线）
 *   out: {type:'agent-event', taskId, event}  —— main 侧持久化分派
 *        {type:'permission-ask', taskId, request} —— #20 审批询问（main 策略引擎裁决）
 * 与 renderer 的协议（MessagePort）：
 *   in : {type:'ping'}
 *   out: {type:'pong', at} | {type:'agent-event', taskId, event}
 */

interface MinimalPort {
  start: () => void;
  close?: () => void;
  on: (event: 'message', listener: (e: { data: unknown }) => void) => void;
  postMessage: (message: unknown) => void;
}

interface ParentPortLike {
  on: (
    event: 'message',
    listener: (e: { data: unknown; ports: readonly unknown[] }) => void,
  ) => void;
  postMessage: (message: unknown) => void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (!parentPort) {
  console.error('[agent] process.parentPort 不可用——本进程只能由 Electron utilityProcess.fork 启动');
  process.exit(1);
}

// ── 宿主状态 ─────────────────────────────────────────────────────────────

let dataDir: string | null = null;
let rendererPort: MinimalPort | null = null;
let registry: ProcessRegistry = new ProcessRegistry(null);

interface SessionEntry {
  taskId: string;
  sessionId: string | null;
  cancel: () => Promise<void>;
  sendFollowup: (text: string) => Promise<void>;
  /** session_started 到达前缓冲的旁路行（拿到 sessionId 后落到正式文件） */
  jsonlBuffer: string[];
  ended: boolean;
}

const sessions = new Map<string, SessionEntry>();

// ── JSONL 旁路 ───────────────────────────────────────────────────────────

function jsonlPath(taskId: string, sessionId: string | null): string | null {
  if (!dataDir) return null;
  const sid = sessionId ?? 'nosession';
  // sessionId 来自 agent，防御性过滤路径字符
  const safe = sid.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(dataDir, 'events', taskId, `${safe}.jsonl`);
}

/**
 * 写一行旁路（dir: in=入向指令 / out=归一事件）。失败静默——旁路不阻塞主流程。
 * session_started 之前收与发都先进缓冲，拿到 sessionId 后整批落正式文件，
 * 保证一个会话的完整收发在同一 .jsonl（排障/回放不拼文件）。
 */
function bypassWrite(entry: SessionEntry, dir: 'in' | 'out', payload: unknown): void {
  entry.jsonlBuffer.push(`${JSON.stringify({ dir, at: Date.now(), payload })}\n`);
  if (entry.sessionId) flushBypass(entry, false);
}

/** 缓冲落盘：有 sessionId 落正式文件；forceNosession 用于会话未建立即终止的场景 */
function flushBypass(entry: SessionEntry, forceNosession: boolean): void {
  if (entry.jsonlBuffer.length === 0) return;
  const file = jsonlPath(entry.taskId, forceNosession ? null : entry.sessionId);
  if (!file) {
    entry.jsonlBuffer = [];
    return;
  }
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, entry.jsonlBuffer.join(''), 'utf8');
    entry.jsonlBuffer = [];
  } catch {
    // 磁盘满等：忽略
  }
}

// ── 事件分派 ─────────────────────────────────────────────────────────────

function dispatchEvent(entry: SessionEntry, event: AgentEvent): void {
  if (event.type === 'session_started' && !entry.sessionId) {
    entry.sessionId = event.sessionId;
  }
  bypassWrite(entry, 'out', event);
  if (event.type === 'session_ended') flushBypass(entry, !entry.sessionId);
  // 通道 a：MessageChannel 直连 renderer（实时渲染）
  try {
    rendererPort?.postMessage({ type: 'agent-event', taskId: entry.taskId, event });
  } catch {
    // 端口已关闭（窗口先退）：静默
  }
  // 通道 b：parentPort → main（持久化 + 状态机）
  parentPort?.postMessage({ type: 'agent-event', taskId: entry.taskId, event });
}

// ── 审批中继（ticket #20：替换全允许桩；fail-closed 语义不变） ──────────────
//
// 链路：driver permissionHandler → permission-ask（parentPort）→ main 审批服务
// （策略引擎：三档 + 「总是允许」规则）→ agent-command permission-respond →
// resolve 本进程挂起的 handler → driver 补发 permission_response 回事件流。
// 会话终结（done 结算）时挂起请求一律立即 deny 结清——fail-closed，不等超时兜底。

interface PendingPermission {
  taskId: string;
  resolve: (decision: PermissionDecision) => void;
}

const pendingPermissions = new Map<string, PendingPermission>();

function createPermissionRelay(entry: SessionEntry): PermissionHandler {
  return (req) =>
    new Promise<PermissionDecision>((resolve) => {
      pendingPermissions.set(req.id, { taskId: entry.taskId, resolve });
      bypassWrite(entry, 'in', { kind: 'permission-ask', request: req });
      try {
        parentPort?.postMessage({ type: 'permission-ask', taskId: entry.taskId, request: req });
      } catch (err) {
        // parentPort 不可用（main 已退）：立即 fail-closed，不悬挂
        pendingPermissions.delete(req.id);
        resolve({
          behavior: 'deny',
          message: `审批链路不可用（fail-closed）: ${err instanceof Error ? err.message : err}`,
        });
      }
    });
}

function handlePermissionRespond(cmd: PermissionRespondCommand): void {
  const pending = pendingPermissions.get(cmd.requestId);
  if (!pending) {
    // 幂等：重复/陌生回执（会话已清账后补到）一律 no-op
    console.warn(`[agent] permission-respond 找不到挂起请求: ${cmd.requestId}`);
    return;
  }
  pendingPermissions.delete(cmd.requestId);
  const entry = sessions.get(pending.taskId);
  if (entry) bypassWrite(entry, 'in', cmd);
  pending.resolve(cmd.decision);
}

/** 会话终结清账：该任务全部挂起请求立即 deny（fail-closed 快速结清） */
function settlePendingPermissions(taskId: string, message: string): void {
  for (const [id, p] of [...pendingPermissions]) {
    if (p.taskId !== taskId) continue;
    pendingPermissions.delete(id);
    p.resolve({ behavior: 'deny', message });
  }
}

// ── 会话命令 ─────────────────────────────────────────────────────────────

interface StartCommand {
  kind: 'start';
  taskId: string;
  agentType: string;
  prompt: string;
  cwd: string;
  model: string | null;
  env?: Record<string, string>;
  /** 审批等待超时（毫秒，超时=deny fail-closed）；缺省 driver 默认 120s */
  permissionTimeoutMs?: number;
  // ── ticket #26（additive）──
  /** 内置 agent 的可执行路径覆盖（main 侧路径修复持久化的解析结果） */
  executablePath?: string | null;
  /** 自定义 ACP agent 注册 spec（agentType='custom:<id>' 时由 main 从 DB 解析随附） */
  customAgent?: CustomAgentSpec;
}

interface FollowupCommand {
  kind: 'followup';
  taskId: string;
  text: string;
}

interface CancelCommand {
  kind: 'cancel';
  taskId: string;
}

/** ticket #20：main 审批服务回执（托盘决议 / 策略自动裁决 / 终止清账 deny） */
interface PermissionRespondCommand {
  kind: 'permission-respond';
  taskId: string;
  requestId: string;
  decision: PermissionDecision;
}

type AgentCommand = StartCommand | FollowupCommand | CancelCommand | PermissionRespondCommand;

function handleStart(cmd: StartCommand): void {
  if (sessions.has(cmd.taskId)) {
    console.warn(`[agent] 任务 ${cmd.taskId} 已有活跃会话，忽略重复 start`);
    return;
  }
  // ── ticket #26（additive）：自定义 ACP agent 经注册 spec 动态实例化（utility 无 DB，
  // spec 由 main 随 start 指令传入）；内置四家维持注册表 glob 查找 ──
  const def = cmd.customAgent
    ? createCustomDriverDefinition(cmd.customAgent)
    : getDriverDefinition(cmd.agentType);
  const entry: SessionEntry = {
    taskId: cmd.taskId,
    sessionId: null,
    cancel: async () => {},
    sendFollowup: async () => {
      throw new Error('会话尚未建立');
    },
    jsonlBuffer: [],
    ended: false,
  };
  sessions.set(cmd.taskId, entry);
  bypassWrite(entry, 'in', cmd);

  if (!def) {
    dispatchEvent(entry, {
      type: 'error',
      message: `未知 agent 类型: ${cmd.agentType}（可用: ${listDrivers().map((d) => d.id).join(', ') || '无'}）`,
      fatal: true,
    });
    dispatchEvent(entry, { type: 'turn_end', status: 'failed', reason: `未知 agent 类型: ${cmd.agentType}` });
    dispatchEvent(entry, { type: 'session_ended', reason: 'failed', error: '未知 agent 类型' });
    sessions.delete(cmd.taskId);
    return;
  }

  const params: DriverStartParams = {
    taskId: cmd.taskId,
    prompt: cmd.prompt,
    cwd: cmd.cwd,
    model: cmd.model,
    env: cmd.env,
    permissionHandler: createPermissionRelay(entry),
    ...(typeof cmd.permissionTimeoutMs === 'number'
      ? { permissionTimeoutMs: cmd.permissionTimeoutMs }
      : {}),
    // ticket #26（additive）：main 侧路径修复解析出的可执行覆盖（无则 driver 默认解析链）
    ...(typeof cmd.executablePath === 'string' ? { executablePath: cmd.executablePath } : {}),
    // executablePath 缺省——claude driver 读 OPEN_COWORK_CLAUDE_CLI（e2e 覆盖点）
    // alwaysAllowRules 缺省——#20 规则匹配收敛在 main 策略引擎层（单一口径，
    // 中途新增的规则即时生效；driver 预过滤参数留给降级 driver 用）
  };

  let driver;
  try {
    driver = def.create().start(params, (event) => dispatchEvent(entry, event));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dispatchEvent(entry, { type: 'error', message: `agent 启动失败: ${message}`, fatal: true });
    dispatchEvent(entry, { type: 'turn_end', status: 'failed', reason: message });
    dispatchEvent(entry, { type: 'session_ended', reason: 'failed', error: message });
    sessions.delete(cmd.taskId);
    return;
  }

  entry.cancel = () => driver.cancel();
  entry.sendFollowup = (text) => driver.sendFollowup(text);
  registry.register(cmd.taskId, {
    kill: () => {
      void driver.cancel();
    },
  });

  void driver.done
    .then(({ reason, error }) => {
      if (entry.ended) return;
      entry.ended = true;
      // #20：会话终结清账——挂起审批一律立即 deny（fail-closed 快速结清，不等 120s 超时）
      settlePendingPermissions(cmd.taskId, 'agent 会话已结束，待审批请求已取消');
      // driver 自身未显式发 session_ended 时宿主兜底（事件流对消费者保持完备）
      dispatchEvent(entry, { type: 'session_ended', reason, ...(error ? { error } : {}) });
    })
    .catch((err: unknown) => {
      if (entry.ended) return;
      entry.ended = true;
      settlePendingPermissions(cmd.taskId, 'agent 会话异常结束，待审批请求已取消');
      const message = err instanceof Error ? err.message : String(err);
      dispatchEvent(entry, { type: 'session_ended', reason: 'failed', error: message });
    })
    .finally(() => {
      sessions.delete(cmd.taskId);
      registry.unregister(cmd.taskId);
    });
}

function handleFollowup(cmd: FollowupCommand): void {
  const entry = sessions.get(cmd.taskId);
  if (!entry) {
    console.warn(`[agent] followup 找不到会话: ${cmd.taskId}`);
    return;
  }
  bypassWrite(entry, 'in', cmd);
  entry.sendFollowup(cmd.text).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    dispatchEvent(entry, { type: 'error', message: `追问失败: ${message}`, fatal: false });
  });
}

function handleCancel(cmd: CancelCommand): void {
  const entry = sessions.get(cmd.taskId);
  if (!entry) return; // 无会话（如重启后残留 running）：main 会直接落 cancelled
  bypassWrite(entry, 'in', cmd);
  registry.kill(cmd.taskId); // 幂等；driver 随后发 turn_end/session_ended cancelled
}

function shutdown(): void {
  // 进程退出前清账：全部挂起审批立即 deny（fail-closed，不等 driver 超时兜底）
  for (const taskId of sessions.keys()) {
    settlePendingPermissions(taskId, 'agent 适配层正在关闭，待审批请求已取消');
  }
  registry.killAll();
  sessions.clear();
  try {
    rendererPort?.close?.();
  } catch {
    // 忽略
  }
}

// ── 端口接线（renderer ⇄ utility 直连） ───────────────────────────────────

function wirePort(port: MinimalPort): void {
  rendererPort = port;
  port.on('message', ({ data }) => {
    const msg = data as { type?: string } | null;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      port.postMessage({ type: 'pong', at: Date.now() });
    }
  });
  port.start();
  // renderer 后连上时把进行中会话的当前状态同步过去（重连/晚连兜底：
  // 事件增量已由 renderer 侧历史重拉覆盖，这里只保证 pong 可用）
}

parentPort.on('message', (e) => {
  const data = e.data as
    | { type?: string; dataDir?: string; command?: AgentCommand }
    | null;
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case 'init':
      dataDir = typeof data.dataDir === 'string' ? data.dataDir : null;
      registry = new ProcessRegistry(dataDir ? join(dataDir, 'events', 'agent-processes.json') : null);
      // 第二级清理：杀上次运行残留的 agent 子进程
      registry.sweepStale();
      console.log(`[agent] 初始化完成 (dataDir=${dataDir ?? 'null'})`);
      break;
    case 'agent-port':
      if (e.ports.length > 0) {
        wirePort(e.ports[0] as MinimalPort);
        console.log('[agent] MessageChannel 端口已接通');
      }
      break;
    case 'agent-command': {
      const cmd = data.command;
      if (!cmd || typeof cmd !== 'object') return;
      if (cmd.kind === 'start') handleStart(cmd);
      else if (cmd.kind === 'followup') handleFollowup(cmd);
      else if (cmd.kind === 'cancel') handleCancel(cmd);
      else if (cmd.kind === 'permission-respond') handlePermissionRespond(cmd);
      break;
    }
    case 'shutdown':
      shutdown();
      break;
  }
});

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());

const drivers = listDrivers();
console.log(
  `[agent] utility 已启动 (pid=${process.pid})，已注册 driver: ${drivers.map((d) => d.id).join(', ') || '(无)'}`,
);
