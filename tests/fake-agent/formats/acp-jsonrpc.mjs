/**
 * ACP（Agent Client Protocol）stdio JSON-RPC wire 格式发射器（ticket #26）。
 *
 * 把逻辑事件序列化为 ACP stdout 报文（jsonrpc:'2.0' 逐帧补齐）；
 * stdin 侧应答 driver 发来的 initialize / session/new / session/cancel，
 * 并认领 harness 自己发起的审批反向请求（session/request_permission）的 client 响应。
 *
 * ACP 轮次语义：session/prompt 的响应在整轮 session/update 之后到达——
 * 本发射器扣住 prompt 请求 id，脚本 emit turn_end（stopReason='end_turn'/'refusal'）或
 * error（JSON-RPC error 答复）时才回；session/cancel 到达即回 stopReason='cancelled'。
 *
 * session/prompt 请求行不认领（返回 false）——prompt 文本在请求 params 里，
 * 原样落进 cli.mjs 的 expect_stdin 队列供脚本节奏控制（match 子串命中原文）。
 *
 * expectResponse（脚本级 wire 断言）在本格式的解读：
 *   {behavior:'allow', updatedPermissions:null}  → 期望 outcome selected optionId='allow'（allow_once）
 *   {behavior:'allow', updatedPermissions:[...]} → 期望 optionId='always'（allow_always 回写语义）
 *   {behavior:'deny'}                             → 期望 optionId='reject'
 * 审批回执落账：FAKE_AGENT_PERMISSION_LOG 指向文件时逐行追加 JSON（contract wire 级断言依据）。
 */

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** 逻辑工具名 → ACP ToolCallKind */
function acpKindOf(name) {
  if (name === 'Bash') return 'execute';
  if (name === 'Edit' || name === 'Write') return 'edit';
  if (name === 'Read') return 'read';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'WebFetch') return 'fetch';
  return 'other';
}

/** 把 text 切成 chunks 份（与其他格式同规则） */
function splitChunks(text, chunks) {
  const n = Math.max(1, Math.min(chunks ?? 1, Math.max(1, text.length)));
  const size = Math.ceil(text.length / n);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length > 0 ? out : [''];
}

export default function createAcpJsonrpcEmitter(io) {
  const { writeLine } = io;
  let nextServerId = 1;
  /** 审批反向请求：rpc id → resolve(client 响应) */
  const pendingPermissions = new Map();
  /** 扣住的 session/prompt 请求 id（turn_end/error/cancel 时答复） */
  let pendingPromptId = null;
  /** toolCallId → {kind, title}（tool_result 配对用） */
  const toolCalls = new Map();

  const send = (obj) => writeLine(JSON.stringify({ jsonrpc: '2.0', ...obj }));

  const respondPrompt = (result) => {
    if (pendingPromptId === null) return;
    send({ id: pendingPromptId, result });
    pendingPromptId = null;
  };

  const failPrompt = (message) => {
    if (pendingPromptId === null) return;
    send({ id: pendingPromptId, error: { code: -32000, message: String(message) } });
    pendingPromptId = null;
  };

  const sessionUpdate = (ctx, update) =>
    send({ method: 'session/update', params: { sessionId: ctx.sessionId, update } });

  const logPermission = (record) => {
    const file = process.env.FAKE_AGENT_PERMISSION_LOG;
    if (!file) return;
    try {
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 旁路断言文件：失败静默
    }
  };

  /** 脚本级 wire 断言（expectResponse 的 ACP 解读，见文件头注释） */
  const assertExpectResponse = (expectResponse, response) => {
    if (!expectResponse) return;
    const outcome = response?.outcome ?? {};
    const selected = outcome.outcome === 'selected' ? outcome.optionId : null;
    let expected;
    if (expectResponse.behavior === 'deny') expected = 'reject';
    else if (expectResponse.updatedPermissions != null) expected = 'always';
    else expected = 'allow';
    if (selected !== expected) {
      throw new Error(
        `expectResponse 断言失败：期望 optionId=${expected}，实际回执 ${JSON.stringify(response)}`,
      );
    }
  };

  return {
    start(_ctx) {
      // ACP 握手由 client（driver）发起：initialize 到达前保持静默
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
      if (!msg || typeof msg !== 'object') return false;
      const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
      const hasMethod = typeof msg.method === 'string';

      if (hasId && !hasMethod) {
        // client → fake 的审批回执（session/request_permission 的响应）
        const resolve = pendingPermissions.get(msg.id);
        if (resolve) {
          pendingPermissions.delete(msg.id);
          resolve(msg.error ? { __error: msg.error } : (msg.result ?? null));
        }
        return true;
      }
      if (hasId && hasMethod) {
        switch (msg.method) {
          case 'initialize':
            send({
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: false,
                  promptCapabilities: { image: false, audio: false, embeddedContext: false },
                },
                agentInfo: { name: 'fake-acp-agent', title: null, version: '0.0.1' },
                authMethods: [],
              },
            });
            return true;
          case 'session/new':
            send({ id: msg.id, result: { sessionId: ctx.sessionId } });
            return true;
          case 'session/prompt':
            // 扣住 id（turn_end/error/cancel 时答复）；不认领——prompt 原文落 expect_stdin 队列
            pendingPromptId = msg.id;
            return false;
          default:
            // 协议内其他请求（session/load 等）：宽容空 result
            send({ id: msg.id, result: {} });
            return true;
        }
      }
      if (!hasId && hasMethod) {
        if (msg.method === 'session/cancel') {
          respondPrompt({ stopReason: 'cancelled' });
        }
        // client 通知一律吞掉
        return true;
      }
      return false;
    },

    async emit(event, ctx) {
      switch (event?.kind) {
        case 'text': {
          for (const d of splitChunks(event.text ?? '', event.chunks)) {
            sessionUpdate(ctx, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: d },
            });
          }
          return;
        }
        case 'thinking': {
          for (const d of splitChunks(event.text ?? '', event.chunks)) {
            sessionUpdate(ctx, {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: d },
            });
          }
          return;
        }
        case 'tool_call': {
          const input = event.input ?? {};
          const filePath = input.file_path ?? input.filePath ?? null;
          const title =
            (typeof input.command === 'string' && input.command) ||
            (typeof filePath === 'string' && filePath) ||
            event.name ||
            'tool';
          const kind = acpKindOf(event.name);
          toolCalls.set(event.id, { kind, title });
          sessionUpdate(ctx, {
            sessionUpdate: 'tool_call',
            toolCallId: event.id,
            title,
            kind,
            status: 'in_progress',
            rawInput: input,
            locations: filePath ? [{ path: filePath }] : [],
          });
          return;
        }
        case 'tool_result': {
          const prev = toolCalls.get(event.id) ?? { kind: 'other', title: 'tool' };
          const output = String(event.output ?? '');
          sessionUpdate(ctx, {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.id,
            title: prev.title,
            kind: prev.kind,
            status: event.isError ? 'failed' : 'completed',
            rawOutput: output,
          });
          return;
        }
        case 'permission_request': {
          const rpcId = `srv_${nextServerId++}`;
          const input = event.input ?? {};
          const filePath = input.file_path ?? input.filePath ?? null;
          const kind = acpKindOf(event.toolName);
          const responsePromise = new Promise((resolve) => {
            pendingPermissions.set(rpcId, resolve);
          });
          send({
            id: rpcId,
            method: 'session/request_permission',
            params: {
              sessionId: ctx.sessionId,
              toolCall: {
                toolCallId: event.id ?? `toolu_${randomUUID().slice(0, 8)}`,
                title:
                  (typeof input.command === 'string' && input.command) ||
                  (typeof filePath === 'string' && filePath) ||
                  event.toolName ||
                  'tool',
                kind,
                status: 'pending',
                rawInput: input,
                locations: filePath ? [{ path: filePath }] : [],
              },
              options: [
                { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ],
              // 非标准扩展：ACP 无 reason 字段，经 _meta 透传（driver 侧宽容读取，真实 agent 缺省为 null）
              _meta: { reason: event.reason ?? null },
            },
          });
          const response = await responsePromise; // 等 driver 的 JSON-RPC 回执再继续脚本
          io.log(`permission ${rpcId} 回执: ${JSON.stringify(response)}`);
          assertExpectResponse(event.expectResponse, response);
          logPermission({ requestId: event.id ?? rpcId, rpcId, via: 'acp-jsonrpc', response });
          return;
        }
        case 'turn_end': {
          const status = event.status ?? 'completed';
          const input = event.usage?.inputTokens ?? 3;
          const output = event.usage?.outputTokens ?? 5;
          sessionUpdate(ctx, {
            sessionUpdate: 'usage_update',
            used: input + output,
            size: 200000,
            // 非标准扩展：input/output 分账（真实 ACP 只有 used/size；driver 侧宽容读取）
            _meta: { inputTokens: input, outputTokens: output },
          });
          respondPrompt({ stopReason: status === 'completed' ? 'end_turn' : 'refusal' });
          return;
        }
        case 'error': {
          // agent 轮次级错误：JSON-RPC error 答复在途 prompt（driver → turn_end(failed)）
          failPrompt(event.message ?? 'agent error');
          return;
        }
        default:
          throw new Error(`acp-jsonrpc 不支持逻辑事件: ${JSON.stringify(event)}`);
      }
    },
  };
}
