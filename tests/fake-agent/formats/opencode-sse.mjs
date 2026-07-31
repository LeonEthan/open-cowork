/**
 * opencode serve REST + SSE wire 格式发射器（ticket #22）。
 *
 * 与真实 `opencode serve --port 0 --hostname 127.0.0.1` 行为对齐：
 * - 进程内起本地 HTTP+SSE server（ephemeral 端口），stdout 打印监听行
 *   `opencode server listening on http://127.0.0.1:<port>`（driver 解析此行）；
 * - GET /event → SSE：`data: {json}\n\n` 帧（事件类型在载荷 type 字段，与真实一致）；
 * - POST /session → 建会话；POST /session/{id}/message|prompt_async → 接收 prompt；
 * - POST /permission/{id}/reply → 审批回执（once|always|reject）；
 * - POST /session/{id}/abort → 200 true。
 *
 * expect_stdin 桥接：harness 的 expect_stdin 只认 stdin 行（cli.mjs），而 opencode 的
 * prompt 走 HTTP。本格式在 prompt POST 到达时把 {type:'opencode-user-prompt',text}
 * 经 process.stdin.unshift 注入一行——readline 随即派发到 cli.mjs 的 stdin 队列
 * （onStdinLine 不认领，返回 false）。真实 server 不读 stdin，driver 也从不写，
 * 管道常开，unshift 安全。
 *
 * 审批回执落账：FAKE_AGENT_PERMISSION_LOG 指向文件时追加 JSON 行（contract 断言依据）。
 */

import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export default function createOpencodeSseEmitter(io) {
  const { writeLine } = io;
  /** SSE 客户端 res 集合 */
  const sseClients = new Set();
  /** 审批：permissionId → resolve(reply) */
  const pendingPermissions = new Map();
  /** callID → tool 名（tool_result 配对用） */
  const toolCalls = new Map();
  /** 当前 assistant 消息上下文（text/thinking 共享） */
  let currentMessageId = null;
  let partSeq = 0;

  const nextId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  const logPermission = (record) => {
    const file = process.env.FAKE_AGENT_PERMISSION_LOG;
    if (!file) return;
    try {
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 旁路断言文件：失败静默
    }
  };

  /** 广播一帧 SSE（真实 server 只有 data: 字段） */
  const broadcast = (eventObj) => {
    const frame = `data: ${JSON.stringify({ id: nextId('evt'), ...eventObj })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          resolve({});
        }
      });
    });

  /** prompt POST → 注入 stdin 行，接通 expect_stdin */
  const feedPromptToStdin = (ctx, text) => {
    try {
      process.stdin.unshift(`${JSON.stringify({ type: 'opencode-user-prompt', sessionID: ctx.sessionId, text })}\n`);
    } catch (err) {
      io.log(`stdin 注入失败: ${err?.message ?? err}`);
    }
  };

  const ensureAssistantMessage = (ctx) => {
    if (currentMessageId) return currentMessageId;
    currentMessageId = nextId('msg');
    broadcast({
      type: 'message.updated',
      properties: {
        sessionID: ctx.sessionId,
        info: {
          id: currentMessageId,
          sessionID: ctx.sessionId,
          role: 'assistant',
          time: { created: Date.now() },
          parentID: nextId('msg'),
          modelID: ctx.model,
          providerID: 'fake',
          mode: 'build',
          agent: 'build',
          path: { cwd: ctx.cwd, root: ctx.cwd },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });
    return currentMessageId;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const ctx = serverCtx;
      if (req.method === 'GET' && url.pathname === '/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ id: nextId('evt'), type: 'server.connected', properties: {} })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/session') {
        const body = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: ctx.sessionId,
            slug: 'fake-session',
            projectID: 'fake-project',
            directory: ctx.cwd,
            title: body?.title ?? '',
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now(), updated: Date.now() },
          }),
        );
        return;
      }
      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/(message|prompt_async)$/);
      if (req.method === 'POST' && promptMatch) {
        const body = await readBody(req);
        const text = Array.isArray(body?.parts)
          ? body.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
          : '';
        currentMessageId = null; // 新一轮：重置 assistant 消息上下文
        if (promptMatch[2] === 'prompt_async') {
          res.writeHead(204);
          res.end();
        } else {
          // 真实 /message 阻塞到轮次结束；fake 立即返回最小响应（driver 用 prompt_async）
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ info: { role: 'assistant' }, parts: [] }));
        }
        feedPromptToStdin(ctx, text);
        return;
      }
      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (req.method === 'POST' && abortMatch) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('true');
        return;
      }
      const replyMatch = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (req.method === 'POST' && replyMatch) {
        const body = await readBody(req);
        const permissionId = replyMatch[1];
        const resolve = pendingPermissions.get(permissionId);
        if (resolve) {
          pendingPermissions.delete(permissionId);
          resolve({ reply: body?.reply ?? 'reject', message: body?.message ?? null });
        }
        logPermission({ requestId: permissionId, via: 'http', reply: body?.reply ?? null, message: body?.message ?? null });
        broadcast({
          type: 'permission.replied',
          properties: { sessionID: ctx.sessionId, requestID: permissionId, reply: body?.reply ?? 'reject' },
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('true');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    })().catch((err) => {
      io.log(`http 处理异常: ${err?.message ?? err}`);
      try {
        res.writeHead(500);
        res.end();
      } catch {
        // 已写头：忽略
      }
    });
  });

  /** start(ctx) 时缓存 ctx 供 HTTP 路由用 */
  let serverCtx = { sessionId: 'pending', model: 'fake-model-1', cwd: process.cwd() };

  /** 把 text 切成 chunks 份（与 claude 格式同规则） */
  function splitChunks(text, chunks) {
    const n = Math.max(1, Math.min(chunks ?? 1, Math.max(1, text.length)));
    const size = Math.ceil(text.length / n);
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out.length > 0 ? out : [''];
  }

  return {
    start(ctx) {
      serverCtx = ctx;
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        // 与真实 serve 的监听行同形（driver 的正则按此解析）
        writeLine(`opencode server listening on http://127.0.0.1:${addr.port}`);
      });
    },

    raw(line) {
      // emit_raw 逃生舱：作为一条 SSE data 帧广播（line 应为 JSON 对象文本）
      const frame = `data: ${typeof line === 'string' ? line : JSON.stringify(line)}\n\n`;
      for (const res of sseClients) {
        try {
          res.write(frame);
        } catch {
          sseClients.delete(res);
        }
      }
    },

    onStdinLine(_line, _ctx) {
      // opencode 协议不经 stdin；unshift 注入的 prompt 行落进 expect_stdin 队列
      return false;
    },

    async emit(event, ctx) {
      switch (event?.kind) {
        case 'text':
        case 'thinking': {
          const messageId = ensureAssistantMessage(ctx);
          const partId = nextId('prt');
          const partType = event.kind === 'thinking' ? 'reasoning' : 'text';
          const chunks = splitChunks(event.text ?? '', event.chunks);
          let cumulative = '';
          for (const d of chunks) {
            cumulative += d;
            // 与真实流同形：delta 帧 + 累计 part.updated 帧成对
            broadcast({
              type: 'message.part.delta',
              properties: { sessionID: ctx.sessionId, messageID: messageId, partID: partId, field: 'text', delta: d },
            });
            broadcast({
              type: 'message.part.updated',
              properties: {
                sessionID: ctx.sessionId,
                part: {
                  id: partId,
                  sessionID: ctx.sessionId,
                  messageID: messageId,
                  type: partType,
                  text: cumulative,
                  time: { start: Date.now() },
                },
                time: Date.now(),
              },
            });
          }
          return;
        }
        case 'tool_call': {
          const messageId = ensureAssistantMessage(ctx);
          const callId = event.id ?? nextId('call');
          const tool = String(event.name ?? 'unknown').toLowerCase();
          toolCalls.set(callId, tool);
          broadcast({
            type: 'message.part.updated',
            properties: {
              sessionID: ctx.sessionId,
              part: {
                id: nextId('prt'),
                sessionID: ctx.sessionId,
                messageID: messageId,
                type: 'tool',
                callID: callId,
                tool,
                state: { status: 'running', input: event.input ?? {}, time: { start: Date.now() } },
              },
              time: Date.now(),
            },
          });
          return;
        }
        case 'tool_result': {
          const messageId = ensureAssistantMessage(ctx);
          const tool = toolCalls.get(event.id) ?? 'unknown';
          const isError = Boolean(event.isError);
          broadcast({
            type: 'message.part.updated',
            properties: {
              sessionID: ctx.sessionId,
              part: {
                id: nextId('prt'),
                sessionID: ctx.sessionId,
                messageID: messageId,
                type: 'tool',
                callID: event.id,
                tool,
                state: isError
                  ? {
                      status: 'error',
                      input: {},
                      error: String(event.output ?? ''),
                      time: { start: Date.now(), end: Date.now() },
                    }
                  : {
                      status: 'completed',
                      input: {},
                      output: String(event.output ?? ''),
                      title: '',
                      time: { start: Date.now(), end: Date.now() },
                    },
              },
              time: Date.now(),
            },
          });
          return;
        }
        case 'permission_request': {
          const messageId = ensureAssistantMessage(ctx);
          const permissionId = event.id ?? nextId('per');
          const permission = String(event.toolName ?? 'bash').toLowerCase();
          const input = event.input ?? {};
          const patterns = [
            typeof input.command === 'string'
              ? input.command
              : typeof input.file_path === 'string'
                ? input.file_path
                : typeof input.filePath === 'string'
                  ? input.filePath
                  : '*',
          ];
          const responsePromise = new Promise((resolve) => {
            pendingPermissions.set(permissionId, resolve);
          });
          broadcast({
            type: 'permission.asked',
            properties: {
              id: permissionId,
              sessionID: ctx.sessionId,
              permission,
              patterns,
              metadata: input,
              always: [],
              tool: { messageID: messageId, callID: nextId('call') },
            },
          });
          const reply = await responsePromise; // 等 driver POST /permission/{id}/reply 再继续脚本
          io.log(`permission ${permissionId} 回执: ${JSON.stringify(reply)}`);
          return;
        }
        case 'turn_end': {
          const status = event.status ?? 'completed';
          const isError = status !== 'completed' || Boolean(event.isError);
          const messageId = ensureAssistantMessage(ctx);
          broadcast({
            type: 'message.updated',
            properties: {
              sessionID: ctx.sessionId,
              info: {
                id: messageId,
                sessionID: ctx.sessionId,
                role: 'assistant',
                time: { created: Date.now(), completed: Date.now() },
                parentID: nextId('msg'),
                modelID: ctx.model,
                providerID: 'fake',
                mode: 'build',
                agent: 'build',
                path: { cwd: ctx.cwd, root: ctx.cwd },
                cost: 0,
                tokens: {
                  total: (event.usage?.inputTokens ?? 3) + (event.usage?.outputTokens ?? 5),
                  input: event.usage?.inputTokens ?? 3,
                  output: event.usage?.outputTokens ?? 5,
                  reasoning: 0,
                  cache: {
                    read: event.usage?.cacheReadTokens ?? 0,
                    write: event.usage?.cacheWriteTokens ?? 0,
                  },
                },
                finish: isError ? 'error' : 'stop',
                ...(isError
                  ? { error: { name: 'UnknownError', data: { message: event.result ?? 'turn failed' } } }
                  : {}),
              },
            },
          });
          if (isError) {
            broadcast({
              type: 'session.error',
              properties: {
                sessionID: ctx.sessionId,
                error: { name: 'UnknownError', data: { message: event.result ?? 'turn failed' } },
              },
            });
          }
          broadcast({ type: 'session.idle', properties: { sessionID: ctx.sessionId } });
          return;
        }
        case 'error': {
          broadcast({
            type: 'session.error',
            properties: {
              sessionID: ctx.sessionId,
              error: { name: 'UnknownError', data: { message: event.message ?? 'error' } },
            },
          });
          broadcast({ type: 'session.idle', properties: { sessionID: ctx.sessionId } });
          return;
        }
        default:
          throw new Error(`opencode-sse 不支持逻辑事件: ${JSON.stringify(event)}`);
      }
    },
  };
}
