/**
 * 脚本解释器（wire 无关）：按 JSONL 动作逐行驱动。
 * io 由 cli.mjs 注入（emit/emitRaw/waitStdinLine/sleep/log），
 * 以便纯 Node 测试也能不起进程直接驱动 emitter。
 */
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
