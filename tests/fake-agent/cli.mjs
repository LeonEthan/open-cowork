#!/usr/bin/env node
/**
 * fake agent harness —— 可脚本化的 stub agent CLI（ticket #19，测试接缝 1）。
 *
 * 用途：contract 测试与 e2e 用它冒充真实 agent CLI。它读取一份 JSONL 脚本
 * （每行一个动作），按指定 wire 格式在 stdout 发射协议事件，并按需消费 stdin。
 *
 * 用法：
 *   node cli.mjs --script <script.jsonl> [--format claude-stream-json] [--verbose]
 * 未知参数（真实 agent CLI 的旗标，如 --output-format stream-json --model x）一律忽略
 * ——harness 必须能被 driver 以真实 CLI 的调用方式 spawn。
 *
 * ── 脚本动作（每行一个 JSON）──
 *   {"action":"emit","event":{...}}      逻辑事件 → wire 格式（见 formats/ 模块）
 *   {"action":"emit","event":{...},"detach":true}
 *                                        发射后不阻塞脚本（#20 并发 permission_request 用）
 *   {"action":"emit_raw","line":{...}}   原样写一行 wire 报文（逃生舱）
 *   {"action":"expect_stdin","match":"可选子串","timeoutMs":10000}
 *                                        等待 stdin 收到一条 user 输入（追问节奏控制）
 *   {"action":"write_file","path":"a/b.txt","content":"...","append":false}
 *                                        相对 session cwd 写真实文件（ticket #24 additive，
 *                                        制造工作区变更；append=true 追加）
 *   {"action":"sleep","ms":100}
 *   {"action":"exit","code":0}
 *
 * ── 逻辑事件 kind（与 src/agent/events.ts 的 AgentEvent 对齐，wire 无关）──
 *   text {text, chunks?}      assistant 正文（chunks>1 时分片流式）
 *   thinking {text, chunks?}  思考过程
 *   tool_call {id,name,input} 工具调用开始
 *   tool_result {id,output,isError?} 工具结果
 *   permission_request {id?,toolName,input,reason?,suggestions?,expectResponse?}
 *                             发起权限请求并阻塞等决议（claude = control_request/response）；
 *                             suggestions 原样作 permission_suggestions 发出（#20 回写用）；
 *                             expectResponse 对回执内层载荷做键级断言（未命中脚本失败退出）
 *   turn_end {status:"completed"|"failed", result?, isError?, usage?}
 *   error {message}           致命错误（claude = error result）
 *
 * ── 新增 wire 格式（#22 codex JSON-RPC / opencode SSE、#23 pi rpc）──
 * 在 formats/ 下新增 <name>.mjs，默认导出一个工厂：
 *   (io: { writeLine(line:string):void, log(msg:string):void }) => WireEmitter
 * WireEmitter 接口：
 *   start(ctx): void                    连接建立时的协议起手（如 claude 的 system/init）
 *   emit(event, ctx): Promise<void>|void 逻辑事件 → wire 报文（可异步，如等审批回执）
 *   onStdinLine(line, ctx): boolean     认领一条 stdin 行；返回 true 表示已消费
 * ctx: { sessionId, model, cwd, args } 由 CLI 从参数/环境解析。
 * 然后在 FORMATS 表登记一行即可。
 */

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import claudeStreamJson from './formats/claude-stream-json.mjs';
import codexJsonrpc from './formats/codex-jsonrpc.mjs'; // ticket #22
import opencodeSse from './formats/opencode-sse.mjs'; // ticket #22
import acpJsonrpc from './formats/acp-jsonrpc.mjs'; // ticket #26
import { runScript } from './runner.mjs';

const FORMATS = {
  'claude-stream-json': claudeStreamJson,
  'codex-jsonrpc': codexJsonrpc, // ticket #22
  'opencode-sse': opencodeSse, // ticket #22
  'acp-jsonrpc': acpJsonrpc, // ticket #26
};

async function main() {
  const { values } = parseArgs({
    options: {
      script: { type: 'string' },
      format: { type: 'string', default: 'claude-stream-json' },
      verbose: { type: 'boolean', default: false },
      // 宽容解析：driver 以真实 CLI 旗标调用时不得报错
      strict: { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  const scriptPath = values.script ?? process.env.FAKE_AGENT_SCRIPT;
  if (typeof scriptPath !== 'string') {
    console.error('[fake-agent] 缺少 --script <path>（或 FAKE_AGENT_SCRIPT 环境变量）');
    process.exit(64);
  }
  const formatName = String(values.format ?? 'claude-stream-json');
  const createEmitter = FORMATS[formatName];
  if (!createEmitter) {
    console.error(`[fake-agent] 未知 wire 格式: ${formatName}（可用: ${Object.keys(FORMATS).join(', ')}）`);
    process.exit(64);
  }

  const verbose = Boolean(values.verbose) || process.env.FAKE_AGENT_VERBOSE === '1';
  const log = (msg) => {
    if (verbose) console.error(`[fake-agent] ${msg}`);
  };

  const script = readFileSync(scriptPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => JSON.parse(l));

  const ctx = {
    sessionId: randomUUID(),
    model: typeof values.model === 'string' ? values.model : 'fake-model-1',
    cwd: process.cwd(),
    args: process.argv.slice(2),
  };

  const rl = createInterface({ input: process.stdin, terminal: false });
  const emitter = createEmitter({
    writeLine: (line) => {
      process.stdout.write(`${line}\n`);
      log(`→ ${line}`);
    },
    log,
  });

  // stdin 分派：先给 emitter（协议控制报文），再进 user 输入队列（expect_stdin 消费）
  const stdinQueue = [];
  let stdinWaiter = null;
  rl.on('line', (line) => {
    log(`← ${line}`);
    if (emitter.onStdinLine(line, ctx)) return;
    if (stdinWaiter) {
      const w = stdinWaiter;
      stdinWaiter = null;
      w(line);
    } else {
      stdinQueue.push(line);
    }
  });
  rl.on('close', () => {
    // driver 关 stdin = 让我们收工（真实 CLI 同语义）
    log('stdin 关闭，退出');
    process.exit(0);
  });

  const waitStdinLine = (timeoutMs) =>
    new Promise((resolve, reject) => {
      if (stdinQueue.length > 0) {
        resolve(stdinQueue.shift());
        return;
      }
      const timer = setTimeout(() => {
        stdinWaiter = null;
        reject(new Error(`expect_stdin 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      stdinWaiter = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
    });

  emitter.start(ctx);
  try {
    await runScript(script, {
      emit: (event) => emitter.emit(event, ctx),
      emitRaw: (line) => emitter.raw(line),
      waitStdinLine,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    });
  } catch (err) {
    console.error(`[fake-agent] 脚本执行失败: ${err?.message ?? err}`);
    process.exit(2);
  }
}

void main();
