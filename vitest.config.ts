import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // 原生模块双 ABI：vitest 跑在 Node 上，指向 postinstall 生成的 Node ABI 副本
      // （node_modules/better-sqlite3 本体已被 electron-rebuild 重编译为 Electron ABI）。
      // 若该路径不存在，先执行 npm install / npm run rebuild:native（见 README）。
      {
        find: /^better-sqlite3$/,
        replacement: fileURLToPath(
          new URL('./node_modules/better-sqlite3-node/lib/index.js', import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
