# open-cowork

本地 cowork 桌面软件：Typora 美学 × Codex 体验，以外部 AI agent（claude code / codex / pi / opencode…）为 runtime，支持任意 provider 的自由 model 配置。

规划已完成，见 [Wayfinder 地图](https://github.com/LeonEthan/open-cowork/issues/1)。

## 文档

- [产品规格书（PRD）](docs/PRD.md) — 定位、范围、MVP 功能、界面与数据规格
- [架构决策集](docs/ARCHITECTURE.md) — 进程架构、agent 接入、provider 配置、存储与回滚
- [设计宪法](docs/DESIGN.md) — 一切 UI 实现的最高准则（Codex 骨架 × Typora 视觉）

## 开发

技术栈：Electron 三进程（main / utility / renderer）· electron-vite · React 19 + Zustand + TS strict · better-sqlite3（WAL + FTS5）。

```bash
npm install        # 装依赖 + 原生模块双 ABI 处理（见下）

npm run dev        # 开发模式（electron-vite dev）
npm run build      # 产物构建（out/）
npm run test       # Vitest 单测
npm run typecheck  # tsc --noEmit
npm run test:e2e   # Playwright 冒烟（自动先 build，会短暂弹出应用窗口）
```

### 数据目录

应用数据根目录默认 `~/.open-cowork/`，可用环境变量 `OPEN_COWORK_DATA_DIR` 覆盖（e2e 与并行开发隔离均依赖它）：

```
<root>/open-cowork.db   全局单一 SQLite（十实体，WAL + FTS5）
<root>/events/          agent 原始事件流 JSONL 旁路
<root>/worktrees/       per-task worktree 集中存放
```

### 原生模块（双 ABI）

`better-sqlite3` / `node-pty` 是原生模块：应用跑 Electron ABI，Vitest 跑 Node ABI，二者二进制互不兼容。本仓库的做法（`scripts/postinstall.mjs`，随 `npm install` 自动执行）：

1. install 阶段官方 prebuild 落地的是 **Node ABI**——先整包复制为 `node_modules/<pkg>-node/`；
2. 再用 `@electron/rebuild` 把原包重编译为 **Electron ABI**（应用侧用）；
3. `vitest.config.ts` 用 `resolve.alias` 把 `better-sqlite3` 指到 `better-sqlite3-node` 副本。

验证：

```bash
node -e "require('better-sqlite3'); console.log('Node ABI ok')"        # Node ABI（vitest 同此路径）
npm run test                                                            # vitest 直接 require 通过即副本生效
npm run build && npm run test:e2e                                       # Electron ABI：应用能起、DB 能建即正常
```

Electron 版本升级或 ABI 异常（`NODE_MODULE_VERSION mismatch`）后重跑：`npm run rebuild:native`。

注意 `node_modules/better-sqlite3-node/` 等 `*-node/` 副本是构建产物，不要手动编辑；重新 `npm install` 会自动刷新。

### 目录结构与扩展点

```
src/
  main/          main 进程：窗口 · SQLite · 服务注册
    db/          十实体 schema + 迁移 runner（migrations/ 按序执行，user_version 记版本）
    services/    IPC handler 服务：新增文件即注册（见 services/index.ts 头注释）
  agent/         utility 进程（agent 适配层宿主）
    drivers/     agent driver 注册表：新增 <name>.driver.ts 即注册（本票为空表）
  preload/       contextBridge 最小桥 + MessageChannel 端口转发
  renderer/      React 19 纯 UI
    src/extensions/
      inspector-tabs/     检查栏 tab：新增 .tsx 默认导出 { id, title, order, component }
      settings-sections/  设置页区块：同上
      sidebar-sections/   任务侧栏区块：同上
  shared/        跨进程共享（数据目录解析、桥 API 类型）
```

所有扩展点均为「新增文件即注册、零编辑共享文件」（`import.meta.glob` 自动聚合）。UI 实现一律对照 [docs/DESIGN.md](docs/DESIGN.md)：只用 token、零阴影、动效白名单。
