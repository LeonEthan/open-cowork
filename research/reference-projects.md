# 参考项目架构调研：cindy / AionUi / opencodex

> 调研日期：2026-07-31 · 对应 issue：LeonEthan/open-cowork#4
> 调研方式：GitHub API 拉取三个仓库（含 AionUi 的后端仓库 iOfficeAI/AionCore）的完整文件树与关键源码文件逐一阅读。
> 注：三个项目都极其活跃（近 30 天 commit 数均 >100），数据截至调研当日。

---

## 一、cindy（makecindy/cindy）

- 仓库：`https://github.com/makecindy/cindy`，Apache-2.0，~1.2k stars，257 open issues
- 仓库 2026-07-22 才公开（此前私有开发），但代码量巨大（6000+ 文件），是心动的商业化产品 Cindy 的开源客户端
- 活跃度：极高，issue 多为内部「签字门」式任务跟踪（团队把工作流建在 GitHub Issues 上）

### 技术栈

- **pnpm monorepo**：`apps/desktop`（Electron + React + TypeScript + Tailwind）、`apps/mobile`（Expo/React Native）、`packages/*`（25+ 共享包）
- 桌面端用 electron-forge + 多份 vite 配置（main / preload / renderer / 多个 worker 各一份）
- 服务端不在本仓库（闭源），客户端可「跳过登录」纯本地使用

### agent 接入方式（最核心的借鉴对象）

统一抽象在 **`packages/maker-core`**：

- `src/agents/base-agent.ts`（1300 行）：`BaseAgent` 抽象类，统一 Claude Code / Codex 两种 harness 的接口面（capabilities、事件流 `AgentEvent`、权限 `InteractionResolver`、rewind/fork、usage）。不支持的能力抛 `NotSupportedError`
- **Claude Code**：`src/agents/claude-code/index.ts`（4500 行）——走 **`@anthropic-ai/claude-agent-sdk` 的 in-process `query()`**（不再 spawn CLI 子进程；注释里写明「之前走 sdkQuery + 子进程，spawn 1-3s 太慢」），通过 SDK 的 `canUseTool` 回调接管权限，`userMessageStream` 异步队列喂用户消息
- **Codex**：`src/agents/codex/app-server/host.ts`——spawn **codex app-server 子进程，stdio 上跑 JSON-RPC**（`stdioTransport.ts`），懒启动 + `ensureStarted()` 幂等并发去重；一个 CodexAgent 实例只 spawn 一个进程，多 thread 复用
- `apps/desktop/src/main/agent-binaries/`：claude-code / codex / ripgrep 二进制由 `pnpm install` 按平台 manifest 下载、校验、Linux runtime fallback
- `packages/maker-cc-manager`：独立 CLI 进程（`bin/cc-mgr.ts`）+ client/protocol/codec，把 SDK query 放进独立进程管理，隔离崩溃面

### 进程与会话管理

- `packages/maker-core/src/session.ts`：`Session` 包装 BaseAgent，统一事件订阅 API、状态机（active/aborting/closed/error）、**turn 零事件看门狗**（`XDT_SESSION_TURN_STALL_MS`，一轮连续无事件即判定链路死亡并中断）
- 事件流为 AsyncIterable → UI 友好的 listener 订阅
- 多会话：主进程 `cindy-brain` 模块群（`agentSlot.ts` / `fsSlot.ts` 等）+ `localDb` 持久化
- 多 agent 协同：`packages/orca-workflow`（Orca 多 agent 编排，docs/dev-rules 有深度文档）

### 权限审批流

- 三合一 `InteractionResolver`：permission / ask_user_question / plan_review 走同一个 resolver 注入 Session
- Claude 侧 `canUseTool` dispatcher 三路分支：白名单只读工具放行 → MCP 工具按 server 归属走策略（`McpToolApprovalPolicy`: auto-approve / prompt / prompt-each-time）→ 其他工具转 permission kind；**无 resolver 时 fail-closed 一律 deny**（`claude-code/index.ts:1415`）
- Codex 侧 `CodexInteractionBroker`（`codex/interaction-broker.ts`）：以 `connectionId + JSON-RPC requestId` 为稳定键跟踪挂起的服务端审批请求，支持按 thread/turn 谓词批量 cancel（turn 中断时自动清理）
- 权限模式四档：plan / ask / （中间档）/ bypassPermissions；决策可携带 `permissionUpdates` 写回会话规则（`types/permissions.ts`），之后同类工具不再询问

### UI 架构与视觉风格

- React + Tailwind + CodeMirror 6；renderer 约 1700 文件（features 481 / components 389 / hooks 134）
- **`docs/design-rules/DESIGN.md` 是一份极其成熟的设计系统文档**：近单色（灰阶）+ 极少语义色白名单、Surface/Card/Board 三层体系、8/12/9999px 三档圆角、零阴影、Inter 单一字体、token 化（Eclipse/One Dark Pro/Monokai Pro 多主题）
- 特色 UI：macOS「灵动岛」式 agent 状态条（`main/agent-island/`）、ghost 插件市场（`GhostManager` 管 zip 包安装/签名/停用）

### 数据存储

- **SQLite + drizzle ORM**（`apps/desktop/src/main/localDb/`，196 个迁移文件）
- 亮点：DB 跑在 utility process / worker thread，主进程经 `DbClient` + `drizzleProxy` 透明访问（`localDb/client/`），含备份、迁移 replay 测试、FTS 聊天搜索

### 值得借鉴

1. `maker-core` 的 BaseAgent/Session 分层：UI 不碰 SDK 细节，事件统一 `AgentEvent`
2. 权限三合一 resolver + fail-closed 默认 + `permissionUpdates` 会话规则回写
3. CodexInteractionBroker 的挂起请求管理（键设计 + 批量取消）
4. turn 零事件看门狗
5. localDb 的 worker 化 SQLite + drizzle proxy
6. DESIGN.md 式「设计宪法」，issue 直接引用规范条款

### 坑 / 差评点

- 体量大到近乎不可移植参考（4500 行的单 agent 实现），只能借鉴结构不能抄代码
- 强绑定自家云服务（默认连官方服务端），「跳过登录」模式功能受限
- 仓库刚公开 8 天，社区贡献流程（DCO、签字门）重，外部 PR 不友好
- renderer 1700 文件，复杂度高；很多能力是商业产品级（语音输入、手机控制、IM 派活），远超 cowork 工具需要

---

## 二、AionUi（iOfficeAI/AionUi + iOfficeAI/AionCore）

- 仓库：`https://github.com/iOfficeAI/AionUi`，Apache-2.0，**~31k stars**，553 open issues，v2.1.44
- 定位与 open-cowork 最接近：「把命令行 AI agent 变成现代聊天界面」的 Cowork 平台
- 活跃度：极高；issue 量大但有自动化 triage

### 技术栈

- **前后端分离的两个仓库**：
  - `AionUi`：Electron 前端（electron-vite + React + Arco Design + UnoCSS），npm workspaces（`packages/desktop`、`packages/web-host`、`packages/web-cli`）
  - **`AionCore`：Rust 后端**（aionrs / "Aion CLI"），24 个 crate 的 workspace（aionui-ai-agent / aionui-db / aionui-team / aionui-mcp / aionui-channel …）
- 前端启动时拉起后端二进制（`process/startup/backendStartup.ts`、`process/backend/binaryResolver.ts`），经本地 HTTP/WebSocket 通信；同一套后端也支持纯 WebUI（web-host 静态服务 + web-cli）和 Docker

### agent 接入方式

- **ACP（Agent Client Protocol）是一等公民**：依赖 `@agentclientprotocol/sdk`（TS 侧）与 Rust `agent_client_protocol` crate
- `AionCore/crates/aionui-ai-agent/src/factory/acp.rs`（1150 行）：agent 装配工厂——从 catalog 解析元数据 → `CommandSpec`（spawn 命令）→ `apply_acp_launch_policy`（注入 env/MCP）→ `AcpAgentManager`
- **关键架构决策**：Claude Code 和 Codex **不走 ACP**，而是走直连 CLI 的 `SessionAgentTask`（clean-slate spawn + stream 解析）；其余 20+ 种 agent（Qwen Code、Goose、OpenCode、Kimi CLI、Copilot、Cursor 等）走 ACP
- agent 自动探测已安装 CLI；用户可自定义 ACP agent（InlineAgentEditor）
- MCP 统一配置一次，注入到所有 agent（`mcpCapabilities.stdio` 的 ACP 后端自动支持）

### 进程与会话管理

- Rust 后端集中管理：`aionui-ai-agent/src/manager/acp/`（agent.rs / agent_reconcile.rs / agent_session_flow.rs / agent_event_tracker.rs …）
- `AgentRuntime`：每会话一个 runtime，带 idle scanner（空闲超时回收）、activity bump（权限请求也算活动，防误杀）
- `packages/web-host/src/agent-process-registry.ts`：**进程注册表落盘**（`runtime/agent-process-registry.json` 记 pid + 进程组 + conversation_id），退出时 SIGTERM → 1s 宽限 → SIGKILL 两级清理；Windows 用 taskkill /T 杀进程树——防止 UI 退出留下孤儿 agent 进程
- 并行多会话 + Team 模式：Leader/Teammate 多 agent，内置 Team MCP Server，异步 mailbox + 共享任务板（`aionui-team` crate；SQLite 里有 `teams`/`mailbox`/`team_tasks` 表）

### 权限审批流

- Rust 侧 `manager/acp/permission_router.rs`（566 行）：ACP permission 请求进 mpsc 通道 → 转 `Permission` 事件广播给前端 → oneshot 挂起等用户 `confirm()`；按 tool_call_id 键控；同 id 新请求自动取消旧请求；Team MCP 工具白名单自动批准；closing 标志阻止关停后新请求
- 前端 `MessageAcpPermission.tsx`：审批卡片 → `conversation.confirmMessage.invoke({confirm_key, msg_id, conversation_id, call_id})` 回传
- YOLO / Full-Auto 模式一键绕过所有审批；Team 模式每个 agent 独立审批弹窗 + 侧栏待办角标

### UI 架构与视觉风格

- Arco Design 组件库 + icon-park；多 tab 会话、会话平台按后端分（`pages/conversation/platforms/acp/` 等）
- 视觉风格偏「功能密集的企业工具」，不如 cindy 克制；有大量营销向 feature（桌宠 pet、21 个内置助理、技能市场、IM 频道接入 Telegram/Slack/飞书/微信）

### 数据存储

- SQLite（better-sqlite3 抽象 `ISqliteDriver`，WAL + busy_timeout），`schema.ts` 用 `user_version` pragma 做迁移（当前 v26）
- 表：users（带密码/JWT 的本地账户系统）/ conversations / messages / teams / mailbox / team_tasks
- 有 legacy schema 修复路径（`repairLegacyHandoffSchema`）

### 值得借鉴

1. **ACP 优先 + Claude/Codex 直连特例**的混合策略：ACP 覆盖长尾 agent，两个主流 agent 用专用通道保体验
2. agent-process-registry 的两级进程清理（防孤儿进程）
3. PermissionRouter 的通道化审批（mpsc + oneshot + 键控去重 + 自动批准白名单）
4. 前后端分仓 + 本地 HTTP：同一后端同时服务 Electron / WebUI / Docker，CLI 可 `webui` 远程访问
5. Rust 后端接管重活（进程管理、DB、流解析），前端纯展示
6. agent idle 回收 + activity bump

### 坑 / 差评点

- **两个仓库 + Rust 工具链**，贡献门槛高；issue 里常见「某版本某功能坏了」类回归（#3788 文件预览坏、#3783 多后端工具调用失败、#3747 团队成员不能改模型），功能面铺太广导致质量不均
- 本地账户系统（用户名+密码+JWT）对一个本地工具来说过重
- 电子宠物、IM 频道等花活稀释核心体验；553 open issues 说明维护带宽吃紧
- 前端 Arco Design 观感偏旧；agent catalog 靠启发式探测 CLI，环境差异导致 repair 流程（AgentRepairPage）成为必需品

---

## 三、opencodex（lidge-jun/opencodex）

- 仓库：`https://github.com/lidge-jun/opencodex`，MIT，~5.9k stars，45 open issues，v2.7.43
- **注意：它不是 cowork UI**，而是一个「universal provider proxy」——让 Codex CLI / Claude Code / Claude Desktop / Grok Build 跑任意 LLM 的本地代理 + Web dashboard
- 活跃度：极高（6 月建仓库，日均多 commit）

### 技术栈

- **Bun 单进程服务**（npm 包自动捆绑 Bun runtime，Node 启动器拉起），零重依赖（只有 zod + MCP SDK + protobuf）
- GUI：`gui/` 下 React 19 + Vite 的纯 Web dashboard（无 Electron），由代理进程静态托管在 `localhost:10100`
- 系统服务化：launchd / systemd / Windows Task Scheduler(+WinSW)

### agent 接入方式（角度不同：它不接 agent，它接在 agent 和模型之间）

- 对下：`src/server/responses.ts` + `chat-completions.ts` + `claude-messages.ts` 实现 OpenAI Responses API / Chat Completions / Anthropic Messages 三种**入口协议**
- 对上：`src/adapters/`（65 个文件）把请求翻译成各家 provider 协议（anthropic / google(+antigravity) / azure / kiro / cursor(protobuf!) / mimo …），双向翻译 streaming、tool calls、reasoning tokens、图片
- `src/claude/`：Claude Code/Desktop 注入（`inbound.ts`/`outbound.ts`/`agents-inject.ts` 子代理路由）；`src/codex/`：Codex 的 shim 注入、账号池

### 进程与会话管理

- 不管 agent 进程（agent 是用户的 CLI），管的是**账号与请求路由**：
  - ChatGPT 账号池（`codex/account-store.ts` 等）：多账号 token 刷新（60s 偏移、刷新锁防并发）、按 5h/周/30d 配额选最闲健康账号
  - **thread pinning**：已有 Codex 线程钉死在发起账号上，长会话（SSH/tmux/手机）不跳号
  - 429 → 冷却 + failover；401/403 → 标记需重新授权
- `src/tray/`（系统托盘）、`src/update/`、内存看门狗（`memory-watchdog.ts`）

### 权限审批流

- 无（权限归 agent CLI 自己管）；管理 API 有本地 admin token 鉴权（`management-auth.ts`），issue #760 暴露过 TLS 反代后 token 校验 403 的问题

### UI 架构与视觉风格

- 运维向 dashboard：providers / 账号池 / 用量日志 / 存储清理策略等 54 个页面组件，React + 自绘样式（无组件库），深色数据面板风格
- issue #753 指出 GUI 切 tab 无 loading、一次切 providers 页发 38 个请求——GUI 是附加品不是核心

### 数据存储

- 全 JSON 文件落配置目录（`codex-accounts.json` 等），原子写（tmp+rename）、目录权限加固（`hardenConfigDir`）、损坏自动备份（`backupInvalidConfig`）；不用数据库
- 请求日志 / 用量记录有独立清理策略调度器（`storage/policy-scheduler.ts`）

### 值得借鉴

1. **协议翻译层思路**：如果 open-cowork 想「任意模型 + 任意 harness」，它的 adapter 模式（每种 provider 一个目录，wire 编译/错误/重试/截断各一文件）是最系统的参考
2. thread pinning + 账号池路由（多订阅账号调度是刚需时）
3. 零依赖 Bun 单文件服务 + 托盘 + 三平台自启动的运维体验
4. 原子写 + 权限加固的 JSON 配置存储
5. issue 驱动的工程纪律（每个修复都有 issue 编号、隐私扫描脚本、隐私测试）

### 坑 / 差评点

- 与 open-cowork 的目标不重合：它是管道不是工作台，UI/会话管理部分参考价值有限
- 单作者项目（个人账号 lidge-jun），治理/持续性风险
- 打各家「逆向/非官方」接口（cursor protobuf、antigravity），随时可能被上游封；issue 里有供应商策略封禁的实例（#758）
- `ocx init` 有过 100% CPU busy-loop 的低级 bug（#754），迭代快但回归也快

---

## 四、汇总

### 可借鉴清单（按对 open-cowork 的价值排序）

| # | 设计 | 出处 | 适用点 |
|---|------|------|--------|
| 1 | BaseAgent 统一抽象 + Session 包装 + 统一 `AgentEvent` 事件流 | cindy `packages/maker-core/src/agents/base-agent.ts`、`src/session.ts` | 多 harness 接入的核心骨架 |
| 2 | Claude Code 走 `@anthropic-ai/claude-agent-sdk` in-process query + `canUseTool` 回调；Codex 走 app-server stdio JSON-RPC | cindy `agents/claude-code/index.ts`、`agents/codex/app-server/` | 两大 harness 的具体接法 |
| 3 | ACP 作为长尾 agent 统一协议（@agentclientprotocol/sdk），主流 agent 直连特例 | AionCore `crates/aionui-ai-agent/src/factory/acp.rs` | 第二期扩展 agent 面 |
| 4 | 权限审批：mpsc 通道 + oneshot 挂起 + tool_call_id 键控 + fail-closed 默认 + 决策可写回会话规则（permissionUpdates） | AionCore `permission_router.rs` + cindy `interaction-broker.ts`、`types/permissions.ts` | 审批流实现范本 |
| 5 | agent 进程注册表落盘 + SIGTERM→SIGKILL 两级清理 + Windows taskkill /T | AionUi `packages/web-host/src/agent-process-registry.ts` | 防孤儿进程 |
| 6 | turn 零事件看门狗（流卡死检测） | cindy `session.ts` | 流式健壮性 |
| 7 | SQLite + WAL + busy_timeout + user_version 迁移；重负载则 worker 化 | AionUi `schema.ts`；cindy `localDb/` | 会话/消息持久化 |
| 8 | 后端独立进程 + 本地 HTTP/WS，同一后端服务桌面与 Web | AionUi 前后端分仓架构 | 若想要 WebUI/远程访问 |
| 9 | provider/协议 adapter 目录式组织（wire 编译、错误、重试、截断分文件） | opencodex `src/adapters/` | 多模型代理层（如需要） |
| 10 | 设计系统宪法（token 化、少色、三档圆角、issue 引用条款） | cindy `docs/design-rules/DESIGN.md` | UI 规范治理 |
| 11 | 原子写 JSON + 权限加固的轻量配置存储 | opencodex `src/codex/account-store.ts` | 密钥/配置落盘 |
| 12 | Codex app-server 懒启动 + ensureStarted 幂等并发去重 | cindy `app-server/host.ts` | 子进程生命周期 |

### 避坑清单

1. **不要为本地工具做账户系统**（AionUi 的 users 表 + JWT + resetpass CLI 是纯包袱）。
2. **不要功能摊大饼**：AionUi 的桌宠/IM 频道/技能市场稀释核心体验，553 个 open issue、版本回归频发是代价。
3. **不要把 UI 和 agent 生命周期放同一进程**：cindy 把 SDK query 独立成 cc-manager 进程、AionUi 用 Rust 后端，都是为了崩溃隔离；至少要做到进程注册表 + 两级清理。
4. **spawn 子进程必须有看门狗**（零事件超时）和幂等启动，否则用户看到的就是「一直转圈」。
5. **权限审批默认 fail-closed**：无 resolver / 异常路径一律 deny，白名单只读工具才放行（cindy 注释里反复强调）。
6. **不要抄大体量实现**：cindy 单文件 4500 行是商业团队产物，借鉴分层即可，照抄会拖垮小团队。
7. **慎用非官方/逆向接口**（opencodex 的 cursor protobuf 路线），上游一变就全线坏。
8. **CLI 探测式接入需要配套修复流程**：AionUi 被迫做了 AgentRepairPage；自动探测 + 手动修复入口要一起设计。
9. **JSON 文件存储够用就别上数据库**（配置/密钥类），但聊天历史必须 SQLite + FTS。
10. **审批请求要能批量取消**：turn 中断时挂起的审批不清理会泄漏（cindy broker 的 `cancelWhere`、AionCore 的同 id 顶掉旧请求）。

### 一句话结论

> **架构上以 cindy `maker-core` 的 BaseAgent/Session 分层为骨架，以 AionUi/AionCore 的 ACP + 进程注册表 + PermissionRouter 为工程化范本，opencodex 只在「多模型代理」需求出现时再回头看；UI 规范学 cindy 的设计宪法，产品形态守住 AionUi 的定位但砍掉它的花活。**
