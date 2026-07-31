import { describe, expect, it } from 'vitest';
import { JsonRpcPeer, createLineSplitter } from '../src/agent/drivers/jsonRpcPeer';
import { createSseParser } from '../src/agent/drivers/sseParser';

/**
 * wire 格式边界测试（ticket #22）：SSE 分片与 JSON-RPC 乱序/粘包。
 * 纯 Node 接缝——不经 fake 进程，直接驱动 parser/peer。
 */

describe('SSE parser 分片边界', () => {
  const collect = (chunks: string[]): { event: string | null; data: string }[] => {
    const frames: { event: string | null; data: string }[] = [];
    const parser = createSseParser((f) => frames.push(f));
    for (const c of chunks) parser.feed(c);
    parser.end();
    return frames;
  };

  it('任意 chunk 边界切分（逐字节喂入）帧完整', () => {
    const wire = 'data: {"type":"text","v":"甲乙"}\n\ndata: second\n\n';
    const chunks: string[] = [];
    for (const ch of wire) chunks.push(ch);
    const frames = collect(chunks);
    expect(frames).toHaveLength(2);
    expect(frames[0].data).toBe('{"type":"text","v":"甲乙"}');
    expect(frames[1].data).toBe('second');
  });

  it('一帧跨多行 data: 以 \\n 连接；event: 字段保留', () => {
    const frames = collect(['event: message\ndata: line1\ndata: line2\n\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: 'message', data: 'line1\nline2' });
  });

  it('注释行（:心跳）与 \\r\\n 兼容；无 data 的帧不派发', () => {
    const frames = collect([': ping\r\n\r\ndata: real\r\n\r\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('real');
  });

  it('流末尾无空行收尾的残帧由 end() 冲刷', () => {
    const frames = collect(['data: tail']);
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('tail');
  });

  it('空 data 行保留为空串段（data:\\n\\n 派发空帧）', () => {
    const frames = collect(['data:\n\n']);
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('');
  });
});

describe('JSON-RPC peer 乱序与粘包', () => {
  it('响应与通知乱序交错：call 按 id 配对不受干扰', async () => {
    const sent: unknown[] = [];
    const notifications: string[] = [];
    const peer = new JsonRpcPeer((m) => sent.push(m), {
      onNotification: (method) => notifications.push(method),
      onServerRequest: async () => ({ ok: true }),
    });
    const p1 = peer.call('initialize', { a: 1 });
    const p2 = peer.call('thread/start', { b: 2 });
    // 乱序：通知 → p2 响应 → 通知 → p1 响应
    peer.feedLine(JSON.stringify({ method: 'thread/started', params: {} }));
    peer.feedLine(JSON.stringify({ id: 2, result: { thread: { id: 't1' } } }));
    peer.feedLine(JSON.stringify({ method: 'warning', params: {} }));
    peer.feedLine(JSON.stringify({ id: 1, result: { userAgent: 'x' } }));
    await expect(p1).resolves.toEqual({ userAgent: 'x' });
    await expect(p2).resolves.toEqual({ thread: { id: 't1' } });
    expect(notifications).toEqual(['thread/started', 'warning']);
    expect(sent).toHaveLength(2);
  });

  it('server 反向请求（审批）：handler 结果作为 {id, result} 回发', async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer((m) => sent.push(m), {
      onNotification: () => {},
      onServerRequest: async (req) => {
        expect(req.method).toBe('item/commandExecution/requestApproval');
        return { decision: 'accept' };
      },
    });
    peer.feedLine(
      JSON.stringify({ id: 'srv_1', method: 'item/commandExecution/requestApproval', params: {} }),
    );
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([{ id: 'srv_1', result: { decision: 'accept' } }]);
  });

  it('server 反向请求 handler 抛错：回 JSON-RPC error（fail-closed）', async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer((m) => sent.push(m), {
      onNotification: () => {},
      onServerRequest: async () => {
        throw new Error('未接入（fail-closed）');
      },
    });
    peer.feedLine(JSON.stringify({ id: 9, method: 'item/tool/requestUserInput', params: {} }));
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([
      { id: 9, error: { code: -32000, message: '未接入（fail-closed）' } },
    ]);
  });

  it('对端 error 帧 reject 对应 call；destroy 后所有在途 call 一律 reject', async () => {
    const peer = new JsonRpcPeer(
      () => {},
      { onNotification: () => {}, onServerRequest: async () => null },
    );
    const pErr = peer.call('bad/method');
    peer.feedLine(JSON.stringify({ id: 1, error: { code: -32601, message: 'Method not found' } }));
    await expect(pErr).rejects.toThrow('Method not found');

    const pHang = peer.call('never/answered');
    peer.destroy(new Error('进程已退出'));
    await expect(pHang).rejects.toThrow('进程已退出');
  });

  it('行切分器：粘包（两行一 chunk）与分包（一行两 chunk）', () => {
    const lines: string[] = [];
    const feed = createLineSplitter((l) => lines.push(l));
    feed('{"a":1}\n{"b":');
    feed('2}\n{"c"');
    feed(':3}\r\n');
    feed('{"d":4}');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    // 末尾无换行的残行留在缓冲（进程退出前对方总会补换行或连接关闭）
  });

  it('坏行不中断：onParseError 记后后续帧照常分派', () => {
    const parseErrors: string[] = [];
    const notifications: string[] = [];
    const peer = new JsonRpcPeer(() => {}, {
      onNotification: (m) => notifications.push(m),
      onServerRequest: async () => null,
      onParseError: (line) => parseErrors.push(line),
    });
    peer.feedLine('not json {{{');
    peer.feedLine(JSON.stringify({ method: 'ok', params: {} }));
    expect(parseErrors).toHaveLength(1);
    expect(notifications).toEqual(['ok']);
  });
});
