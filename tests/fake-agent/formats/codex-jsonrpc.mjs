/**
 * codex app-server JSON-RPC wire 格式发射器（ticket #22）。
 *
 * 把逻辑事件序列化为 codex app-server 的换行分隔 JSON-RPC stdout 报文；
 * stdin 侧应答 driver 发来的 initialize / thread/start / turn/start / turn/interrupt，
 * 并认领 harness 自己发起的审批反向请求（item/commandExecution|fileChange/requestApproval）
 * 的 client 响应。
 *
 * turn/start 请求行不认领（返回 false）——prompt 文本在请求 params 里，
 * 原样落进 cli.mjs 的 expect_stdin 队列供脚本节奏控制（match 子串命中原文）。
 *
 * 审批回执落账：FAKE_AGENT_PERMISSION_LOG 指向文件时，每次决议追加一行 JSON
 * （contract 测试的 wire 级断言依据）。
 */

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export default function createCodexJsonrpcEmitter(io) {
  const { writeLine } = io;
  /** 审批反向请求：rpc id → resolve(client 响应) */
  const pendingPermissions = new Map();
  /** itemId → 工具类别（tool_result 配对用） */
  const itemKinds = new Map();
  let currentTurnId = null;

  const send = (obj) => writeLine(JSON.stringify(obj));

  const logPermission = (record) => {
    const file = process.env.FAKE_AGENT_PERMISSION_LOG;
    if (!file) return;
    try {
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 旁路断言文件：失败静默
    }
  };

  /** 一轮 agentMessage / reasoning 的 started → delta×N → completed（真实成对形态） */
  function emitStreamingItem(ctx, { itemType, text, deltas, deltaMethod, completeItem }) {
    const itemId = randomUUID();
    const turnId = currentTurnId ?? randomUUID();
    send({
      method: 'item/started',
      params: {
        item:
          itemType === 'reasoning'
            ? { type: 'reasoning', id: itemId, summary: [], content: [] }
            : { type: 'agentMessage', id: itemId, text: '', phase: null, memoryCitation: null },
        threadId: ctx.sessionId,
        turnId,
        startedAtMs: Date.now(),
      },
    });
    for (const d of deltas) {
      send({
        method: deltaMethod,
        params: { threadId: ctx.sessionId, turnId, itemId, delta: d },
      });
    }
    send({
      method: 'item/completed',
      params: { item: completeItem(itemId), threadId: ctx.sessionId, turnId, completedAtMs: Date.now() },
    });
  }

  /** 把 text 切成 chunks 份（与 claude 格式同规则） */
  function splitChunks(text, chunks) {
    const n = Math.max(1, Math.min(chunks ?? 1, Math.max(1, text.length)));
    const size = Math.ceil(text.length / n);
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out.length > 0 ? out : [''];
  }

  /** tool_call 逻辑事件 → codex item 类别（commandExecution / fileChange / mcpToolCall） */
  function toolItemFor(event) {
    const name = event.name ?? 'unknown';
    const input = event.input ?? {};
    if (name === 'Bash') {
      return {
        kind: 'commandExecution',
        item: {
          type: 'commandExecution',
          id: event.id,
          command: typeof input.command === 'string' ? input.command : '',
          cwd: process.cwd(),
          processId: null,
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      };
    }
    if (name === 'Edit' || name === 'Write') {
      return {
        kind: 'fileChange',
        item: {
          type: 'fileChange',
          id: event.id,
          changes: [{ path: input.file_path ?? input.filePath ?? '/tmp/x', kind: 'update' }],
          status: 'inProgress',
        },
      };
    }
    return {
      kind: 'mcpToolCall',
      item: {
        type: 'mcpToolCall',
        id: event.id,
        server: 'fake',
        tool: name,
        status: 'inProgress',
        arguments: input,
        result: null,
        error: null,
        durationMs: null,
      },
    };
  }

  return {
    start(_ctx) {
      // codex app-server 握手由 client（driver）发起：initialize 到达前保持静默
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

      if (hasId && typeof msg.result !== 'undefined') {
        // client → fake 的审批回执
        const resolve = pendingPermissions.get(msg.id);
        if (resolve) {
          pendingPermissions.delete(msg.id);
          resolve(msg.result);
        }
        return true;
      }
      if (hasId && msg.error) {
        const resolve = pendingPermissions.get(msg.id);
        if (resolve) {
          pendingPermissions.delete(msg.id);
          resolve({ __error: msg.error });
        }
        return true;
      }
      if (hasId && hasMethod) {
        switch (msg.method) {
          case 'initialize':
            send({
              id: msg.id,
              result: {
                userAgent: 'fake-codex/0.0.0',
                codexHome: '/tmp/fake-codex-home',
                platformFamily: 'unix',
                platformOs: 'macos',
              },
            });
            return true;
          case 'thread/start':
            send({
              id: msg.id,
              result: {
                thread: {
                  id: ctx.sessionId,
                  sessionId: ctx.sessionId,
                  preview: '',
                  ephemeral: true,
                  cwd: ctx.cwd,
                },
                model: msg.params?.model ?? ctx.model,
                cwd: ctx.cwd,
              },
            });
            return true;
          case 'turn/start': {
            currentTurnId = randomUUID();
            send({
              id: msg.id,
              result: {
                turn: {
                  id: currentTurnId,
                  items: [],
                  itemsView: 'notLoaded',
                  status: 'inProgress',
                  error: null,
                  startedAt: Math.floor(Date.now() / 1000),
                  completedAt: null,
                  durationMs: null,
                },
              },
            });
            send({
              method: 'turn/started',
              params: {
                threadId: ctx.sessionId,
                turn: {
                  id: currentTurnId,
                  items: [],
                  itemsView: 'notLoaded',
                  status: 'inProgress',
                  error: null,
                  startedAt: Math.floor(Date.now() / 1000),
                  completedAt: null,
                  durationMs: null,
                },
              },
            });
            // 不认领：prompt 原文随请求行落进 expect_stdin 队列（节奏控制）
            return false;
          }
          case 'turn/interrupt':
            send({ id: msg.id, result: {} });
            return true;
          default:
            // 协议内其他请求：宽容空 result（真实 server 的兼容性面）
            send({ id: msg.id, result: {} });
            return true;
        }
      }
      if (!hasId && hasMethod) {
        // client 通知（initialized 等）：静默吞掉
        return true;
      }
      return false;
    },

    async emit(event, ctx) {
      switch (event?.kind) {
        case 'text': {
          const deltas = splitChunks(event.text ?? '', event.chunks);
          emitStreamingItem(ctx, {
            itemType: 'agentMessage',
            text: event.text ?? '',
            deltas,
            deltaMethod: 'item/agentMessage/delta',
            completeItem: (itemId) => ({
              type: 'agentMessage',
              id: itemId,
              text: event.text ?? '',
              phase: null,
              memoryCitation: null,
            }),
          });
          return;
        }
        case 'thinking': {
          const deltas = splitChunks(event.text ?? '', event.chunks);
          emitStreamingItem(ctx, {
            itemType: 'reasoning',
            text: event.text ?? '',
            deltas,
            deltaMethod: 'item/reasoning/summaryTextDelta',
            completeItem: (itemId) => ({
              type: 'reasoning',
              id: itemId,
              summary: [event.text ?? ''],
              content: [],
            }),
          });
          return;
        }
        case 'tool_call': {
          const { kind, item } = toolItemFor(event);
          itemKinds.set(event.id, kind);
          send({
            method: 'item/started',
            params: {
              item,
              threadId: ctx.sessionId,
              turnId: currentTurnId ?? randomUUID(),
              startedAtMs: Date.now(),
            },
          });
          return;
        }
        case 'tool_result': {
          const kind = itemKinds.get(event.id) ?? 'commandExecution';
          const isError = Boolean(event.isError);
          const output = String(event.output ?? '');
          let item;
          if (kind === 'commandExecution') {
            item = {
              type: 'commandExecution',
              id: event.id,
              command: '',
              cwd: process.cwd(),
              processId: null,
              status: isError ? 'failed' : 'completed',
              commandActions: [],
              aggregatedOutput: output,
              exitCode: isError ? 1 : 0,
              durationMs: 1,
            };
          } else if (kind === 'fileChange') {
            item = {
              type: 'fileChange',
              id: event.id,
              changes: [],
              status: isError ? 'failed' : 'completed',
            };
          } else {
            item = {
              type: 'mcpToolCall',
              id: event.id,
              server: 'fake',
              tool: 'unknown',
              status: isError ? 'failed' : 'completed',
              arguments: {},
              result: isError ? null : { content: [{ type: 'text', text: output }] },
              error: isError ? { message: output } : null,
              durationMs: 1,
            };
          }
          send({
            method: 'item/completed',
            params: {
              item,
              threadId: ctx.sessionId,
              turnId: currentTurnId ?? randomUUID(),
              completedAtMs: Date.now(),
            },
          });
          return;
        }
        case 'permission_request': {
          const rpcId = `perm_${randomUUID().slice(0, 8)}`;
          const isFileChange = event.toolName === 'Edit' || event.toolName === 'Write';
          const method = isFileChange
            ? 'item/fileChange/requestApproval'
            : 'item/commandExecution/requestApproval';
          const responsePromise = new Promise((resolve) => {
            pendingPermissions.set(rpcId, resolve);
          });
          send({
            id: rpcId,
            method,
            params: isFileChange
              ? {
                  threadId: ctx.sessionId,
                  turnId: currentTurnId ?? randomUUID(),
                  itemId: randomUUID(),
                  startedAtMs: Date.now(),
                  reason: event.reason ?? null,
                  grantRoot: event.input?.file_path ?? event.input?.filePath ?? null,
                }
              : {
                  threadId: ctx.sessionId,
                  turnId: currentTurnId ?? randomUUID(),
                  itemId: randomUUID(),
                  startedAtMs: Date.now(),
                  reason: event.reason ?? null,
                  command: event.input?.command ?? JSON.stringify(event.input ?? {}),
                  cwd: process.cwd(),
                },
          });
          const response = await responsePromise; // 等 driver 的 JSON-RPC 回执再继续脚本
          io.log(`permission ${rpcId} 回执: ${JSON.stringify(response)}`);
          logPermission({
            requestId: event.id ?? rpcId,
            rpcId,
            via: 'jsonrpc',
            response,
          });
          return;
        }
        case 'turn_end': {
          const status = event.status ?? 'completed';
          const isError = status !== 'completed' || Boolean(event.isError);
          const input = event.usage?.inputTokens ?? 3;
          const output = event.usage?.outputTokens ?? 5;
          send({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: ctx.sessionId,
              turnId: currentTurnId ?? randomUUID(),
              tokenUsage: {
                total: {
                  totalTokens: input + output,
                  inputTokens: input,
                  cachedInputTokens: event.usage?.cacheReadTokens ?? 0,
                  cacheWriteInputTokens: event.usage?.cacheWriteTokens ?? 0,
                  outputTokens: output,
                  reasoningOutputTokens: 0,
                },
                last: {
                  totalTokens: input + output,
                  inputTokens: input,
                  cachedInputTokens: event.usage?.cacheReadTokens ?? 0,
                  cacheWriteInputTokens: event.usage?.cacheWriteTokens ?? 0,
                  outputTokens: output,
                  reasoningOutputTokens: 0,
                },
                modelContextWindow: null,
              },
            },
          });
          send({
            method: 'turn/completed',
            params: {
              threadId: ctx.sessionId,
              turn: {
                id: currentTurnId ?? randomUUID(),
                items: [],
                itemsView: 'notLoaded',
                status: isError ? 'failed' : 'completed',
                error: isError
                  ? {
                      message: event.result ?? 'turn failed',
                      codexErrorInfo: null,
                      additionalDetails: null,
                    }
                  : null,
                startedAt: Math.floor(Date.now() / 1000),
                completedAt: Math.floor(Date.now() / 1000),
                durationMs: 1,
              },
            },
          });
          return;
        }
        case 'error': {
          send({
            method: 'turn/completed',
            params: {
              threadId: ctx.sessionId,
              turn: {
                id: currentTurnId ?? randomUUID(),
                items: [],
                itemsView: 'notLoaded',
                status: 'failed',
                error: {
                  message: event.message ?? 'error',
                  codexErrorInfo: null,
                  additionalDetails: null,
                },
                startedAt: Math.floor(Date.now() / 1000),
                completedAt: Math.floor(Date.now() / 1000),
                durationMs: 1,
              },
            },
          });
          return;
        }
        default:
          throw new Error(`codex-jsonrpc 不支持逻辑事件: ${JSON.stringify(event)}`);
      }
    },
  };
}
