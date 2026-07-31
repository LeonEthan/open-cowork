/**
 * pi --mode rpc wire 格式发射器（ticket #23）。
 *
 * 把逻辑事件序列化为 pi RPC 的 JSONL stdout 报文；stdin 侧应答 driver 发来的
 * get_state / prompt / follow_up / abort 命令（{"id","type":"response","command","success"} 关联）。
 * 协议形状对齐本机 pi 0.83.0 实测（见 src/agent/drivers/pi.driver.ts 文件头）。
 *
 * prompt/follow_up 命令行不认领（返回 false）——message 原文在命令里，
 * 原样落进 cli.mjs 的 expect_stdin 队列供脚本节奏控制（match 子串命中原文）。
 * 认领时同步补发真实时序：agent_start → turn_start → user 消息回声（message_start/end）。
 *
 * pi 无任何审批 wire（降级接入）——permission_request 逻辑事件直接抛错；
 * 审批覆盖走静态策略路径（pi.contract.test.ts 的翻译用例 + 启动旗标断言）。
 *
 * 启动回显（e2e #23 只读档断言点）：FAKE_AGENT_STARTUP_LOG 指向文件时，
 * start() 追加一行 JSON {args, env:{...}}——记录 driver 实际 spawn 的旗标与关键 env。
 */

import { appendFileSync } from 'node:fs';

/** claude 风格逻辑工具名 → pi 原生 wire 工具名（脚本沿用全家统一的 Bash/Edit/… 命名） */
const TOOL_NAME_TO_PI = {
  Bash: 'bash',
  Edit: 'edit',
  Write: 'write',
  Read: 'read',
  Grep: 'grep',
  Glob: 'find',
  LS: 'ls',
};

/** 把 text 切成 chunks 份（与其他格式同规则） */
function splitChunks(text, chunks) {
  const n = Math.max(1, Math.min(chunks ?? 1, Math.max(1, text.length)));
  const size = Math.ceil(text.length / n);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length > 0 ? out : [''];
}

export default function createPiRpcEmitter(io) {
  const { writeLine } = io;
  /** toolCallId → wire 工具名（tool_result 配对用） */
  const toolNames = new Map();
  let turnSeq = 0;

  const send = (obj) => writeLine(JSON.stringify(obj));

  /** 真实形状的 AssistantMessage（usage/stopReason 是 driver 归一的关键字段） */
  function assistantMessage(ctx, { text, thinking, usage, stopReason, errorMessage }) {
    const content = [];
    if (thinking) content.push({ type: 'thinking', thinking });
    if (text != null) content.push({ type: 'text', text });
    const u = usage ?? {};
    const input = u.input ?? 3;
    const output = u.output ?? 5;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    return {
      role: 'assistant',
      content,
      api: 'anthropic-messages',
      provider: 'fake',
      model: ctx.model,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: stopReason ?? 'stop',
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: Date.now(),
    };
  }

  /** 一段 text/thinking 的真实流式序列：message_start → delta×N → message_end */
  function emitStreamingBlock(ctx, blockKind, text, chunks) {
    send({ type: 'message_start', message: assistantMessage(ctx, { usage: { input: 0, output: 0 } }) });
    send({
      type: 'message_update',
      assistantMessageEvent: { type: `${blockKind}_start`, contentIndex: 0 },
    });
    for (const d of splitChunks(text ?? '', chunks)) {
      send({
        type: 'message_update',
        assistantMessageEvent: { type: `${blockKind}_delta`, contentIndex: 0, delta: d },
      });
    }
    send({
      type: 'message_update',
      assistantMessageEvent: { type: `${blockKind}_end`, contentIndex: 0, content: text ?? '' },
    });
    send({
      type: 'message_end',
      message: assistantMessage(ctx, {
        ...(blockKind === 'text' ? { text: text ?? '' } : { thinking: text ?? '' }),
      }),
    });
  }

  /** 一轮 run 的收尾：turn_end → agent_end → agent_settled（真实三联） */
  function emitRunCompletion(ctx, { status, usage, result, errorMessage }) {
    const isError = status === 'failed' || Boolean(errorMessage);
    const wireUsage = usage
      ? {
          input: usage.inputTokens ?? 3,
          output: usage.outputTokens ?? 5,
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
        }
      : undefined;
    send({
      type: 'turn_end',
      message: assistantMessage(ctx, {
        text: result ?? '',
        usage: wireUsage,
        stopReason: isError ? 'error' : 'stop',
        errorMessage: isError ? errorMessage ?? result ?? 'turn failed' : undefined,
      }),
      toolResults: [],
    });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  }

  return {
    start(ctx) {
      // 真实 pi：启动静默（首条输出是命令响应）——这里只写启动回显旁路
      const logFile = process.env.FAKE_AGENT_STARTUP_LOG;
      if (logFile) {
        try {
          appendFileSync(
            logFile,
            `${JSON.stringify({
              args: ctx.args,
              env: {
                FAKE_AGENT_SCRIPT: process.env.FAKE_AGENT_SCRIPT ?? null,
                PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
              },
            })}\n`,
            'utf8',
          );
        } catch {
          // 旁路断言文件：失败静默
        }
      }
    },

    raw(line) {
      send(line); // emit_raw 逃生舱：原样一行 wire 报文
    },

    onStdinLine(line, ctx) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return false;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return false;
      if (msg.type === 'extension_ui_response') return true; // driver 的自动取消回执：宽容吞掉

      const id = typeof msg.id === 'string' ? msg.id : undefined;
      const respond = (success, extra = {}) =>
        send({ ...(id !== undefined ? { id } : {}), type: 'response', command: msg.type, success, ...extra });

      switch (msg.type) {
        case 'get_state':
          respond(true, {
            data: {
              model: {
                id: ctx.model,
                name: ctx.model,
                api: 'anthropic-messages',
                provider: 'fake',
                baseUrl: 'http://fake.invalid',
                reasoning: true,
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 8192,
              },
              thinkingLevel: 'medium',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'one-at-a-time',
              followUpMode: 'one-at-a-time',
              sessionFile: null,
              sessionId: ctx.sessionId,
              messageCount: 0,
              pendingMessageCount: 0,
            },
          });
          return true;
        case 'prompt':
        case 'follow_up': {
          respond(true);
          // 真实时序：命令受理后 agent_start → turn_start → user 消息回声
          turnSeq += 1;
          send({ type: 'agent_start' });
          send({ type: 'turn_start' });
          const userMessage = {
            role: 'user',
            content: [{ type: 'text', text: typeof msg.message === 'string' ? msg.message : '' }],
            timestamp: Date.now(),
          };
          send({ type: 'message_start', message: userMessage });
          send({ type: 'message_end', message: userMessage });
          // 不认领：message 原文随命令行落进 expect_stdin 队列（节奏控制）
          return false;
        }
        case 'abort':
          respond(true);
          return true;
        default:
          respond(false, { error: `Unknown command: ${msg.type}` });
          return true;
      }
    },

    async emit(event, ctx) {
      switch (event?.kind) {
        case 'text': {
          emitStreamingBlock(ctx, 'text', event.text ?? '', event.chunks);
          return;
        }
        case 'thinking': {
          emitStreamingBlock(ctx, 'thinking', event.text ?? '', event.chunks);
          return;
        }
        case 'tool_call': {
          const wireName = TOOL_NAME_TO_PI[event.name] ?? String(event.name ?? 'unknown').toLowerCase();
          toolNames.set(event.id, wireName);
          send({
            type: 'tool_execution_start',
            toolCallId: event.id,
            toolName: wireName,
            args: event.input ?? {},
          });
          return;
        }
        case 'tool_result': {
          const isError = Boolean(event.isError);
          const output = String(event.output ?? '');
          send({
            type: 'tool_execution_end',
            toolCallId: event.id,
            toolName: toolNames.get(event.id) ?? 'bash',
            result: { content: [{ type: 'text', text: output }] },
            isError,
          });
          return;
        }
        case 'turn_end': {
          emitRunCompletion(ctx, {
            status: event.status ?? 'completed',
            usage: event.usage,
            result: event.result,
          });
          return;
        }
        case 'error': {
          // agent 报 error 轮次：stopReason=error 的 turn_end + 正常收尾（进程仍 exit 0）
          emitRunCompletion(ctx, { status: 'failed', errorMessage: event.message ?? 'error' });
          return;
        }
        case 'permission_request':
          // pi 无审批 wire（降级接入）——审批覆盖走静态策略路径，见 pi.contract.test.ts
          throw new Error('pi-rpc 不支持 permission_request 逻辑事件（pi 无内建审批 wire）');
        default:
          throw new Error(`pi-rpc 不支持逻辑事件: ${JSON.stringify(event)}`);
      }
    },
  };
}
