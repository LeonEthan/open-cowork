import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 凭证红线回归（audit phase-g）：provider 明文 API 密钥随 StartCommand 整体
 * 序列化落 JSONL 旁路（<dataDir>/events/<taskId>/<sessionId>.jsonl）曾突破红线。
 * 修复后 handleStart 落盘前做脱敏投影（键名保留、值 <redacted>）。
 *
 * 本测试 shim process.parentPort 后在进程内驱动真实 utility 模块
 * （src/agent/index.ts），走 init → agent-command(start) → 会话失败 flush
 * 的完整路径，断言落盘 JSONL 不含密钥明文。
 */

class FakeParentPort extends EventEmitter {
  readonly outbox: unknown[] = [];
  postMessage(msg: unknown): void {
    this.outbox.push(msg);
  }
}

const fakePort = new FakeParentPort();

beforeAll(async () => {
  // utility 模块入口检查 process.parentPort（Electron utilityProcess 注入）；
  // vitest 进程无此属性，先 shim 再动态 import 防 process.exit(1)。
  Object.defineProperty(process, 'parentPort', { value: fakePort, configurable: true });
  await import('../src/agent/index');
});

afterAll(() => {
  delete (process as unknown as { parentPort?: unknown }).parentPort;
});

function sendInit(dataDir: string): void {
  fakePort.emit('message', { data: { type: 'init', dataDir }, ports: [] });
}

function sendStart(command: Record<string, unknown>): void {
  fakePort.emit('message', { data: { type: 'agent-command', command }, ports: [] });
}

async function waitForFile(file: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`等待旁路文件超时: ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('JSONL 旁路脱敏（凭证红线）', () => {
  it('start 指令的 env 密钥不落盘（未知 agent 快败路径，同步 flush）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'oc-bypass-env-'));
    sendInit(dataDir);
    const secret = 'sk-ant-api03-PLAINTEXT-SECRET-0123456789abcdef';
    sendStart({
      kind: 'start',
      taskId: 'task-redact-env',
      agentType: 'nonexistent-agent', // 快败：bypassWrite(in) 后立即 flush 到 nosession.jsonl
      prompt: 'hi',
      cwd: '/tmp',
      model: null,
      env: { ANTHROPIC_API_KEY: secret, PATH: '/usr/bin' },
    });

    const file = join(dataDir, 'events', 'task-redact-env', 'nosession.jsonl');
    const content = readFileSync(file, 'utf8');
    expect(content).not.toContain(secret);
    expect(content).toContain('<redacted>');
    // 键名保留供排障
    expect(content).toContain('ANTHROPIC_API_KEY');
    expect(content).toContain('PATH');
  });

  it('customAgent.env 密钥同样脱敏（spawn ENOENT 异步收尾）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'oc-bypass-custom-'));
    sendInit(dataDir);
    const secret = 'oc-custom-agent-PLAINTEXT-SECRET-0123456789';
    sendStart({
      kind: 'start',
      taskId: 'task-redact-custom',
      agentType: 'custom:audit',
      prompt: 'hi',
      cwd: '/tmp',
      model: null,
      customAgent: {
        id: 'audit',
        name: 'audit-agent',
        command: '/nonexistent/oc-audit-agent-xyz', // ENOENT → done(failed) → flush
        args: [],
        env: { CUSTOM_AGENT_TOKEN: secret },
      },
    });

    const file = join(dataDir, 'events', 'task-redact-custom', 'nosession.jsonl');
    await waitForFile(file);
    const content = readFileSync(file, 'utf8');
    expect(content).not.toContain(secret);
    expect(content).toContain('<redacted>');
    expect(content).toContain('CUSTOM_AGENT_TOKEN');
  });
});
