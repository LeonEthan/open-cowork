import { fileURLToPath } from 'node:url';
import claudeDef from '../../src/agent/drivers/claude.driver';
import { defineContractSuite } from './suite';

/**
 * Claude driver 跑共享 contract 用例表（ticket #19）。
 * 接线：executablePath → fake agent harness（claude stream-json 格式脚本化输出）。
 * #22/#23 新增 driver 时仿照本文件新建 <name>.contract.test.ts，复用 suite.ts。
 */
defineContractSuite({
  id: 'claude-code',
  create: claudeDef.create,
  makeParams: (scriptPath) => ({
    executablePath: fileURLToPath(new URL('../fake-agent/cli.mjs', import.meta.url)),
    env: { FAKE_AGENT_SCRIPT: scriptPath },
  }),
});
