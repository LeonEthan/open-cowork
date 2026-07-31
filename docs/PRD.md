# open-cowork 产品规格书（PRD）

> 版本：v1.0（wayfinder 地图终点交付物）
> 来源：汇总 [wayfinder 地图](https://github.com/LeonEthan/open-cowork/issues/1) 的全部决策票（#2–#15）。
> 配套文档：[架构决策集](ARCHITECTURE.md) · [设计宪法](DESIGN.md)

## 1. 产品定位

本地桌面 cowork 软件：以外部 AI agent CLI（Claude Code / Codex / pi / opencode）为 runtime 的客户端工作台。

- **UI 美学**高度学习 Typora：内容栏即文档，零阴影、克制配色、排版优先。
- **UX 体验**类似 Codex：多任务并行、文档式会话流、检查栏复查变更。
- **模型自由**：支持任意 provider 的自由 model 配置，不锁定任何一家。

## 2. 范围边界（已锁定，charting 阶段决策）

| 维度 | 决策 |
|---|---|
| 场景 | 开发者场景先行；架构为泛知识工作场景预留通用性 |
| Provider | 任意 provider 自由配置（含国内六家预设），无内置代理层 |
| 平台 | Electron 桌面应用，macOS 优先 |
| 界面 | Codex 多任务骨架 + Typora 内容呈现 |
| MVP 必含 | 单会话对话闭环、权限审批流、diff 复查与回滚、多会话并行 + worktree 隔离 |

## 3. 用户与核心场景

**目标用户**：拥有多个 agent CLI、使用多种模型 provider 的开发者。

核心场景：

1. **创建任务**：选定 workspace（本地目录）→ 选 agent + provider/model → 输入需求 → agent 开跑。
2. **并行推进**：多个任务同时运行（任务侧栏状态点区分：运行/待批/待复查/完成）；按需对单任务启用 worktree 隔离。
3. **审批把关**：agent 请求写文件/跑命令/联网时，底部审批托盘逐条弹出，键盘优先批准/拒绝。
4. **复查回滚**：任务完成后在检查栏查看文件变更与 diff，文件级或任务级接受/回滚。
5. **环境治理**：agent 未安装/未认证时，侧栏横幅提醒，设置页一键查看安装命令与修复路径。

## 4. MVP 功能清单

### 4.1 单会话对话闭环

- 文档式会话流：用户消息、agent 回复（markdown 流式渲染）、工具调用极简行、思考过程折叠区。
- 输入区：单圆角框，内嵌 agent/model chip、附件、权限档位 chip、context 水位环、发送键。
- 任务六态状态机：`ready → running ⇄ awaiting_approval → awaiting_review → done`（+`failed`/`cancelled`）。
- 内置终端 tab（node-pty + xterm.js）。

### 4.2 权限审批流（[原型](https://github.com/LeonEthan/open-cowork/tree/prototype/approval-flow)，票 #8）

- **呈现**：文档流中工具调用为极简行（icon + 名称 + 目标 + 状态）；待审批项在输入区上方底部托盘逐条聚焦。
- **操作**：批准一次 ⌘1 / 总是允许 ⌘2 / 拒绝 ⌘3（拒绝可附理由）；并发审批排队预览。
- **权限档位**：三档 per-task 切换——只读 / 自动（默认）/ 完全放权。
- **「总是允许」**：按工具 + 目标模式记忆（如 `Bash: npm *`），规则可回写 agent 侧。
- 全部审批 **fail-closed**：适配层异常或超时一律视为拒绝。

### 4.3 diff 复查与回滚（票 #10）

- **捕获**：git 仓库走原生 `status`/`diff`；非 git 目录快照兜底。统一为 FileChange 实体。
- **呈现**：检查栏文件列表 + 内嵌 diff（`+`绿/`-`红/上下文灰）。
- **操作**：文件级接受/回滚 + 任务级整体操作；任务快照期内可恢复。
- **不自动 commit**：改动留在工作区，由用户决定提交。

### 4.4 多会话并行 + worktree 隔离（票 #11）

- **默认不隔离**：任务直接在 workspace 原目录跑。
- **opt-in worktree**：per-task 启用，集中存放（`~/.open-cowork/worktrees/`），pin base SHA。
- **回流**按 Codex 设计：`git apply` 把未提交改动落回原目录 + 保留分支作逃生舱 + base 漂移检测提示。
- 非 git workspace：共享目录 + 快照兜底。无并发上限；worktree 手动清理。

### 4.5 Agent 接入与引导（票 #5、#14，[原型](https://github.com/LeonEthan/open-cowork/tree/prototype/agent-onboarding)）

- MVP 四家全上：Claude Code（SDK 进程内）/ Codex（app-server）/ opencode（serve）/ pi（rpc，降级接入 + 静态审批策略）。
- 支持自定义 ACP agent（表单录入命令与参数）。
- **无向导融入式引导**：侧栏横幅提醒 + 设置页 Agent 卡片（状态/能力徽标、安装命令 chip、路径修复 + 验证 + 探测日志）；会话 picker 未安装置灰。

### 4.6 Provider / Model 配置（票 #6）

- **机制**：per-workspace 生成隔离的原生配置文件 + 密钥经环境变量注入；不改用户全局配置，无内置代理层。
- **粒度**：Provider 全局配置，model per-session 选择。
- **凭证**：Electron safeStorage / macOS Keychain 加密存储。
- **预设**：内置六家（Anthropic / OpenAI / DeepSeek / GLM / Kimi / 通义），支持自定义 provider；模型清单接 [models.dev](https://models.dev)。

### 4.7 用量与成本展示（票 #15）

- 任务级汇总 chip + 轮次灰色小字，**无独立 dashboard**。
- 金额按 models.dev API 价折算并明确标注；订阅制用量标「仅供参考」。
- 输入区 context 水位环，>80% 警告 + 压缩建议。

## 5. 界面规格（票 #9，[原型](https://github.com/LeonEthan/open-cowork/tree/prototype/typora-ui)）

布局骨架抄 Codex，视觉语言抄 Typora 官方默认主题。所有规则以 [设计宪法](DESIGN.md) 为准，此处仅列骨架：

- **三栏**：任务侧栏（240px 可折叠）｜会话文档流（内容栏 max-width 860px 居中）｜检查栏（320px，变更/文件/终端 tab，可折叠）。
- 明暗双主题，默认跟随系统，手动切换记忆偏好。

## 6. 数据概念模型（票 #7）

十实体：`Workspace / Task / Turn / Message / ToolCall / Approval / FileChange / UsageRecord / Provider / CustomAgent`。
Task 与 agent session 1:1。详见 [架构决策集](ARCHITECTURE.md) §5。

## 7. 非功能要求

- **本地优先**：全部数据存本地（SQLite 全局单一 DB），无任何账户系统/遥测。
- **克制**：UI 组件规则、动效、配色全部受设计宪法约束；功能上无花活（不做看板/日程/插件市场）。
- **可恢复**：任务改动在快照期内可回滚；适配层进程崩溃有两级清理。
- **macOS 优先**：首发只保 macOS 体验，Windows/Linux 不阻塞但不为其妥协设计。

## 8. 明确不做（MVP 内）

- 账户系统、云同步、团队协作
- 内置模型代理/计费层
- 独立用量 dashboard、看板、自动化工作流
- 插件/MCP 生态管理界面

## 9. 延期项（地图走完后仍在雾中，留待下一程）

以下主题在 wayfinder 地图关闭时**有意识地未展开**，不构成 MVP 阻塞：

- 分发、打包与自动更新策略（技术选型 electron-builder + electron-updater 已定，发布渠道与签名策略待定）
- 开发者场景之后的泛知识工作扩展形态
- MCP / 插件生态的接入方式
- UI 多语言（中英）
