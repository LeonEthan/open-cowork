# open-cowork 架构决策集

> 版本：v1.0（wayfinder 地图终点交付物）
> 每条决策标注来源票；详细论证见对应 issue 的 resolution comment。
> 配套文档：[产品规格书](PRD.md) · [设计宪法](DESIGN.md)

## 1. 总体架构（票 #12）

Electron 三进程：

```
┌────────────────────────────────────────────┐
│ main process                               │
│  窗口管理 · SQLite · git 操作 · worktree    │
├────────────────────────────────────────────┤
│ utility process（agent 适配层宿主）          │
│  AgentAdapter × N · 进程注册表两级清理       │
├────────────────────────────────────────────┤
│ renderer（纯 UI）                           │
│  React 19 · Zustand · react-markdown/Shiki │
└────────────────────────────────────────────┘
  renderer ⇄ utility：MessageChannel 直连（高频事件流不过 main）
```

- **技术栈**：React 19 + Vite + Zustand + react-markdown + Shiki；node-pty + xterm.js（终端 tab）。
- **工程化**：electron-vite + electron-builder + electron-updater（GitHub Releases）。
- **仓库结构**（单仓）：`src/main` · `src/agent`（适配层）· `src/preload` · `src/renderer`。

## 2. Agent 接入架构（票 #5；调研票 #2、#4）

**决策：ACP 语义 + 主流直连 + 长尾 ACP。**

- 内部事件模型对齐 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 语义；每家 agent 一个 driver，TS 适配层跑在独立 utility process。
- **MVP 四家 driver**：

  | Agent | 接入方式 | 审批能力 |
  |---|---|---|
  | Claude Code | Agent SDK 进程内 `query()` | 原生（`--permission-prompt-tool` 等价物） |
  | Codex | `app-server` JSON-RPC 直连 | 原生 |
  | opencode | `serve` REST + SSE | 原生（`/permission/{id}/reply`） |
  | pi | `--mode rpc` | **降级**：pi 无内建审批，适配层静态策略兜底 |

- **审批全套**：fail-closed（异常/超时=拒绝）；「总是允许」规则可回写（permissionUpdates）；批量取消。
- **Agent catalog**：内置四家定义 + 探测/修复 + 自定义 ACP agent；进程注册表两级清理防泄漏。
- 参考项目取舍（票 #4）：骨架学 cindy 的 maker-core 分层（BaseAgent/Session）；工程实现参考 AionCore（ACP 接入、PermissionRouter、进程治理）；**不做账户系统、不铺花活**。

## 3. Provider / Model 配置机制（票 #6；调研票 #3）

- **per-workspace 隔离原生配置**：为每个 workspace 生成 agent 各自的原生配置文件（Codex `config.toml`、pi `models.json`、opencode `opencode.json` 等），密钥以环境变量注入进程，**不触碰用户全局配置，不内置代理层**。
- 国内 provider（DeepSeek/GLM/Kimi/通义）双协议端点可免代理直连。
- **粒度**：Provider 全局；model per-session。
- **凭证**：Electron safeStorage / Keychain 加密。
- **模型清单**：六家预设 + `/models` 拉取 + models.dev 元数据（上下文长度、价格）。

## 4. 界面架构（票 #9）

- 布局骨架 = Codex 三栏工作台；视觉语言 = Typora 官方默认主题 token 直采（浅色=github / 深色=night）。
- 一切 UI 实现受 [设计宪法](DESIGN.md) 约束（白名单语义色、零阴影、三类动效上限、明暗双主题）。

## 5. 数据模型与存储（票 #7）

**十实体**：`Workspace / Task / Turn / Message / ToolCall / Approval / FileChange / UsageRecord / Provider / CustomAgent`

- Task 与 agent session **1:1**；六态状态机：`ready → running ⇄ awaiting_approval → awaiting_review → done`（+`failed`/`cancelled`）。
- **存储**：SQLite 轻量路线——better-sqlite3 + WAL + FTS5，全局单一 DB（`~/.open-cowork/`）。
- 结构化实体入库；agent 原始事件流另存 JSONL 旁路文件（排障与回放用）。

## 6. 审批流技术要点（票 #8）

- 三档权限 per-task：只读 / 自动 / 完全放权；自动档下未命中规则的请求逐条审批。
- 「总是允许」按 **工具 + 目标模式**（如 `Bash: npm *`）记忆为规则。
- 交互定稿：文档流极简工具行 + 底部审批托盘（⌘1/2/3、排队预览、拒绝附理由）。

## 7. diff 捕获与回滚（票 #10）

- **git 仓库**：原生 `status`/`diff` 捕获；**非 git 目录**：任务开始时快照兜底。统一归一为 FileChange。
- 不自动 commit；文件级 + 任务级双粒度接受/回滚；任务快照期内可恢复。

## 8. 多会话并行与 worktree（票 #11）

- **默认不隔离**；worktree 为 per-task opt-in，集中存放于 `~/.open-cowork/worktrees/`，创建时 pin base SHA。
- **回流（Codex 式设计）**：worktree 内改动以未提交形态 `git apply` 落回原目录；保留 worktree 分支作逃生舱；base 漂移检测，漂移时提示用户先处理。
- 无并发上限；worktree 手动清理。

## 9. 用量计量（票 #15）

- 适配层归一 **UsageEvent**（claude `result` / codex `turn.completed` / opencode `message.updated` / pi `turn_end`）→ 落 UsageRecord。
- 成本折算用 models.dev 价格，订阅制用量标注「仅供参考」。

## 10. 关键工程红线

1. **fail-closed**：审批链路任何异常都拒绝执行，绝不放行。
2. **不碰全局**：不改用户全局 agent 配置；凭证不出本机（safeStorage）。
3. **本地优先**：无账户系统、无遥测上报。
4. **设计宪法至上**：新 UI 组件先过 DESIGN.md，白名单外元素一律拒绝。
