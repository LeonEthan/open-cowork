/**
 * claude stream-json wire 格式发射器（Agent SDK `--output-format stream-json
 * --input-format stream-json --verbose [--include-partial-messages]` 协议）。
 *
 * 把逻辑事件序列化为 claude CLI 的 NDJSON stdout 报文；stdin 侧自动应答
 * SDK 发来的 control_request（initialize / interrupt / set_permission_mode 等协议噪音），
 * 并认领 harness 自己发起的 can_use_tool 请求的 control_response。
 * user 消息不认领（交回 cli.mjs 的 expect_stdin 队列）。
 */

import { randomUUID } from 'node:crypto';

export default function createClaudeStreamJsonEmitter(io) {
  const { writeLine } = io;
  const pendingPermissions = new Map(); // request_id → resolve(response)

  const send = (obj) => writeLine(JSON.stringify(obj));

  /** 一轮 Anthropic API 流式事件 + 完整 assistant 消息（真实 CLI 的成对形态） */
  function emitAssistantBlock(ctx, block, deltas) {
    const msgId = `msg_${randomUUID().slice(0, 8)}`;
    const uuid = randomUUID();
    const index = 0;
    const isThinking = block.type === 'thinking';
    send({
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: ctx.sessionId,
      parent_tool_use_id: null,
      event: {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model: ctx.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    });
    send({
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: ctx.sessionId,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index,
        content_block: isThinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
      },
    });
    for (const d of deltas) {
      send({
        type: 'stream_event',
        uuid: randomUUID(),
        session_id: ctx.sessionId,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index,
          delta: isThinking ? { type: 'thinking_delta', thinking: d } : { type: 'text_delta', text: d },
        },
      });
    }
    send({
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: ctx.sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_stop', index },
    });
    send({
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: ctx.sessionId,
      parent_tool_use_id: null,
      event: {
        type: 'message_delta',
        delta: { stop_reason: isThinking ? 'thinking' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: deltas.length },
      },
    });
    send({
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: ctx.sessionId,
      parent_tool_use_id: null,
      event: { type: 'message_stop' },
    });
    send({
      type: 'assistant',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: ctx.model,
        content: [block],
        stop_reason: null,
      },
      parent_tool_use_id: null,
      session_id: ctx.sessionId,
      uuid,
    });
  }

  /** 把 text 切成 chunks 份（保持顺序；边界用例：chunks > text.length 时逐字符） */
  function splitChunks(text, chunks) {
    const n = Math.max(1, Math.min(chunks ?? 1, Math.max(1, text.length)));
    const size = Math.ceil(text.length / n);
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out.length > 0 ? out : [''];
  }

  return {
    start(ctx) {
      send({
        type: 'system',
        subtype: 'init',
        cwd: ctx.cwd,
        session_id: ctx.sessionId,
        tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'],
        mcp_servers: [],
        model: ctx.model,
        permissionMode: 'default',
        slash_commands: [],
        apiKeySource: 'none',
        claude_code_version: 'fake-0.0.0',
        output_style: 'default',
        agents: [],
        skills: [],
        plugins: [],
        uuid: randomUUID(),
      });
    },

    raw(line) {
      send(line);
    },

    onStdinLine(line, ctx) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return false;
      }
      if (msg?.type === 'control_request' && typeof msg.request_id === 'string') {
        // SDK → CLI 的协议控制报文：一律成功应答（initialize/interrupt/set_permission_mode…）
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: msg.request_id,
            response: { commands: [], output_styles: [] },
          },
        });
        return true;
      }
      if (msg?.type === 'control_response') {
        const requestId = msg.response?.request_id;
        const resolve = pendingPermissions.get(requestId);
        if (resolve) {
          pendingPermissions.delete(requestId);
          resolve(msg.response);
          return true;
        }
        return true; // 陌生 control_response 也认领地吞掉（协议层）
      }
      return false; // user 消息等：交给 expect_stdin
    },

    async emit(event, ctx) {
      switch (event?.kind) {
        case 'text': {
          const deltas = splitChunks(event.text ?? '', event.chunks);
          emitAssistantBlock(ctx, { type: 'text', text: event.text ?? '' }, deltas);
          return;
        }
        case 'thinking': {
          const deltas = splitChunks(event.text ?? '', event.chunks);
          emitAssistantBlock(ctx, { type: 'thinking', thinking: event.text ?? '' }, deltas);
          return;
        }
        case 'tool_call': {
          send({
            type: 'assistant',
            message: {
              id: `msg_${randomUUID().slice(0, 8)}`,
              type: 'message',
              role: 'assistant',
              model: ctx.model,
              content: [
                { type: 'tool_use', id: event.id, name: event.name, input: event.input ?? {} },
              ],
              stop_reason: 'tool_use',
            },
            parent_tool_use_id: null,
            session_id: ctx.sessionId,
            uuid: randomUUID(),
          });
          return;
        }
        case 'tool_result': {
          send({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: event.id,
                  content: event.isError
                    ? [{ type: 'text', text: String(event.output ?? '') }]
                    : String(event.output ?? ''),
                  is_error: Boolean(event.isError),
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: ctx.sessionId,
            uuid: randomUUID(),
          });
          return;
        }
        case 'permission_request': {
          const requestId = event.id ?? `perm_${randomUUID().slice(0, 8)}`;
          const responsePromise = new Promise((resolve) => {
            pendingPermissions.set(requestId, resolve);
          });
          send({
            type: 'control_request',
            request_id: requestId,
            request: {
              subtype: 'can_use_tool',
              tool_name: event.toolName,
              input: event.input ?? {},
              // ticket #20：脚本可携带 permission_suggestions（「总是允许」回写 contract 用）
              permission_suggestions: event.suggestions ?? null,
              blocked_path: null,
              decision_reason: event.reason ?? null,
            },
          });
          const response = await responsePromise; // 等 SDK 回 control_response 再继续脚本
          io.log(`permission ${requestId} 决议: ${JSON.stringify(response)}`);
          // ticket #20：可选回执断言——对 control_response 内层载荷做键级 JSON 相等校验
          // （期望值 null 可断言键缺失，如 allow_once 不得带 updatedPermissions）；
          // 未命中抛错 → 脚本失败非零退出 → driver 呈现 failed（contract 断言失败信号）
          if (event.expectResponse && typeof event.expectResponse === 'object') {
            const payload = response?.response ?? {};
            for (const [key, want] of Object.entries(event.expectResponse)) {
              const got = payload[key];
              if (JSON.stringify(got ?? null) !== JSON.stringify(want)) {
                throw new Error(
                  `permission 回执断言失败: ${key} 期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`,
                );
              }
            }
          }
          return;
        }
        case 'turn_end': {
          const status = event.status ?? 'completed';
          const isError = status !== 'completed' || Boolean(event.isError);
          send({
            type: 'result',
            subtype: isError ? 'error_during_execution' : 'success',
            is_error: isError,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            result: event.result ?? '',
            stop_reason: isError ? null : 'end_turn',
            session_id: ctx.sessionId,
            total_cost_usd: 0,
            usage: {
              input_tokens: event.usage?.inputTokens ?? 3,
              cache_creation_input_tokens: event.usage?.cacheWriteTokens ?? 0,
              cache_read_input_tokens: event.usage?.cacheReadTokens ?? 0,
              output_tokens: event.usage?.outputTokens ?? 5,
              server_tool_use: { web_search_requests: 0 },
              service_tier: 'standard',
            },
            modelUsage: {},
            permission_denials: [],
            errors: isError ? [event.result ?? 'turn failed'] : [],
            uuid: randomUUID(),
          });
          return;
        }
        case 'error': {
          send({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            result: event.message ?? 'error',
            stop_reason: null,
            session_id: ctx.sessionId,
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
              server_tool_use: { web_search_requests: 0 },
              service_tier: 'standard',
            },
            modelUsage: {},
            permission_denials: [],
            errors: [event.message ?? 'error'],
            uuid: randomUUID(),
          });
          return;
        }
        default:
          throw new Error(`claude-stream-json 不支持逻辑事件: ${JSON.stringify(event)}`);
      }
    },
  };
}
