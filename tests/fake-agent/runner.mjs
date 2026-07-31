/**
 * 脚本解释器（wire 无关）：按 JSONL 动作逐行驱动。
 * io 由 cli.mjs 注入（emit/emitRaw/waitStdinLine/sleep/log），
 * 以便纯 Node 测试也能不起进程直接驱动 emitter。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export async function runScript(actions, io) {
  for (const action of actions) {
    switch (action?.action) {
      case 'emit':
        await io.emit(action.event);
        break;
      case 'emit_raw':
        io.emitRaw(action.line);
        break;
      case 'expect_stdin': {
        const timeoutMs = action.timeoutMs ?? 10_000;
        const line = await io.waitStdinLine(timeoutMs);
        if (typeof action.match === 'string' && !line.includes(action.match)) {
          throw new Error(`expect_stdin 未命中 ${JSON.stringify(action.match)}，实际: ${line}`);
        }
        break;
      }
      // ticket #24 additive：相对 session cwd 写真实文件（制造工作区变更，
      // diff 复查 e2e 与后续黄金路径都靠它；路径逃逸不受限——harness 仅测试用）
      case 'write_file': {
        if (typeof action.path !== 'string' || action.path.length === 0) {
          throw new Error('write_file 需要 path');
        }
        const abs = resolve(process.cwd(), action.path);
        mkdirSync(dirname(abs), { recursive: true });
        const content = typeof action.content === 'string' ? action.content : '';
        if (action.append) appendFileSync(abs, content);
        else writeFileSync(abs, content);
        io.log?.(`write_file ${abs}（${content.length} 字符${action.append ? '，append' : ''}）`);
        break;
      }
      case 'sleep':
        await io.sleep(action.ms ?? 0);
        break;
      case 'exit':
        process.exit(action.code ?? 0);
        break;
      default:
        throw new Error(`未知脚本动作: ${JSON.stringify(action)}`);
    }
  }
}

