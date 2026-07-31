/**
 * 脚本解释器（wire 无关）：按 JSONL 动作逐行驱动。
 * io 由 cli.mjs 注入（emit/emitRaw/waitStdinLine/sleep/log），
 * 以便纯 Node 测试也能不起进程直接驱动 emitter。
 *
 * emit 的 detach:true（ticket #20 并发审批脚本）：发射后不阻塞脚本推进
 * （permission_request 默认阻塞等回执——并发场景需要先发出多条再逐条决议）。
 * detach 事件内部的失败不再上抛（脚本已走远），仅经 emitter log 可见。
 */
export async function runScript(actions, io) {
  for (const action of actions) {
    switch (action?.action) {
      case 'emit':
        if (action.detach === true) {
          Promise.resolve(io.emit(action.event)).catch((err) => {
            io.log?.(`detach 事件失败: ${err?.message ?? err}`);
          });
        } else {
          await io.emit(action.event);
        }
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
