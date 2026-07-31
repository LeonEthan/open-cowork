# AGENTS.md — open-cowork

> 面向 AI 编码 agent 的项目说明书。本文件假设读者对项目一无所知。
> 项目文档与注释的主要语言为**中文**，代码标识符沿用英文惯例。

## 1. 项目概述

open-cowork 是一款**本地桌面 cowork 软件**：以外部 AI agent CLI（Claude Code / Codex / pi / opencode…）为 runtime 的客户端工作台。

- **UI 美学**学习 Typora：内容栏即文档，零阴影、克制配色、排版优先。
- **UX 体验**类似 Codex：多任务并行、文档式会话流、检查栏复查变更。
- **模型自由**：支持任意 provider 的自由 model 配置（含国内六家预设），无内置代理层。

产品决策全部来自 GitHub wayfinder 地图（[issues #1–#15](https://github.com/LeonEthan/open-cowork/issues/1)），已锁定，不要随意扩大范围。

## 2. 当前状态（重要）

**项目尚处于规划完成、编码未启动阶段。** `main` 分支上只有文档，没有源代码：

```
├── README.md            # 项目简介与文档索引
├── AGENTS.md            # 本文件
└── docs/
    ├── PRD.md           # 产品规格书（定位、范围、MVP 功能、数据模型）
    ├── ARCHITECTURE.md  # 架构决策集（进程架构、agent 接入、存储、回滚）
    └── DESIGN.md        # 设计宪法（一切 UI 实现的最高准则）
```

- **没有** `package.json`、`pyproject.toml`、`Cargo.toml` 等任何构建配置；**没有**测试框架；**没有** CI/CD 配置。
- 三份文档是事实之源（source of truth）。任何实现工作开始前，先读对应章节。

## 3. 权威文档（读代码之前先读这些）

| 文档 | 内容 | 何时查阅 |
|---|---|---|
| `docs/PRD.md` | 产品定位、范围边界、MVP 功能清单（§4）、界面规格、十实体数据模型（§6）、明确不做清单（§8） | 做任何功能前 |
| `docs/ARCHITECTURE.md` | Electron 三进程架构（§1）、agent 接入方式（§2）、provider 配置机制（§3）、存储方案（§5）、**关键工程红线（§10）** | 做任何架构/技术决策前 |
| `docs/DESIGN.md` | 设计宪法：布局、色彩 token 白名单、字体排版、组件规则、动效上限、禁区（§7） | 写任何 UI 代码前，条款可引用（如「违反 §3.2」） |

## 4. 规划的技术栈与目录结构（尚未落地）

以下来自 `docs/ARCHITECTURE.md`，实现时按此执行：

- **平台**：Electron 桌面应用，macOS 优先（Windows/Linux 不阻塞但不为其妥协设计）。
- **技术栈**：React 19 + Vite + Zustand + react-markdown + Shiki；终端用 node-pty + xterm.js。
- **工程化**：electron-vite + electron-builder + electron-updater（GitHub Releases）。
- **存储**：better-sqlite3 + WAL + FTS5，全局单一 DB（`~/.open-cowork/`）；agent 原始事件流另存 JSONL 旁路文件。
- **进程架构**：main（窗口/SQLite/git/worktree）· utility process（agent 适配层宿主，AgentAdapter × N）· renderer（纯 UI）。renderer ⇄ utility 用 MessageChannel 直连，高频事件流不过 main。
- **单仓目录约定**：`src/main` · `src/agent`（适配层）· `src/preload` · `src/renderer`。
- **Agent 接入**：内部事件模型对齐 ACP（Agent Client Protocol）语义，每家 agent 一个 TS driver。MVP 四家：Claude Code（Agent SDK 进程内）、Codex（`app-server` JSON-RPC）、opencode（`serve` REST + SSE）、pi（`--mode rpc`，降级接入 + 静态审批策略兜底）；另支持自定义 ACP agent。

## 5. 关键工程红线（ARCHITECTURE.md §10，必须遵守）

1. **fail-closed**：审批链路任何异常或超时一律视为拒绝，绝不放行。
2. **不碰全局**：不改用户全局 agent 配置；provider 配置按 per-workspace 生成隔离的原生配置文件，密钥经环境变量注入；凭证用 Electron safeStorage / macOS Keychain 加密，不出本机。
3. **本地优先**：无账户系统、无遥测上报、无内置模型代理/计费层。
4. **设计宪法至上**：新 UI 组件先过 `docs/DESIGN.md`，白名单外元素一律拒绝。

## 6. 设计宪法速查（写 UI 前必读 DESIGN.md 全文）

- **布局**：三栏——任务侧栏 240px（可折叠）｜会话文档流（内容栏 max-width 860px 居中）｜检查栏 320px（可折叠）。
- **色彩**：Typora 官方主题 token 直采（浅色=github / 深色=night），只允许引用 token，禁止硬编码色值；语义色白名单制（成功绿 / 警告橙 / 错误红 + diff 三色），此外不得引入彩色。
- **零阴影**：浮层（命令面板、切换器除外）用边框而非阴影分层。圆角仅三档：8px / 12px / 9999px。
- **动效只许三类**：状态点 pulse、抽屉 slide（≤220ms）、流式光标 blink。禁止页面级转场、弹性动画、hover 位移。
- **组件**：工具调用渲染为极简行（不得做成大卡片）；思考过程左边线 + 折叠；审批托盘 ⌘1/2/3。

## 7. 仓库与分支

- 远程：GitHub `LeonEthan/open-cowork`。
- `main`：当前仅文档。
- 原型分支（各含一个自包含 HTML 单文件原型，无构建步骤，直接用浏览器打开）：
  - `prototype/typora-ui` → `prototype/typora-ui.html`（界面设计稿，票 #9）
  - `prototype/approval-flow` → `prototype/approval-flow.html`（审批流交互，票 #8）
  - `prototype/agent-onboarding` → `prototype/agent-onboarding.html`（agent 接入引导，票 #5/#14）
- 调研分支：`research/agent-cli-capabilities`、`research/provider-config`、`research/reference-projects`（commit message 用中文，如 `docs: 产品规格书终稿`）。

## 8. 构建、测试与部署

**目前均不存在。** 无构建命令、无测试、无 lint 配置、无 CI。首批代码落地时应按 `docs/ARCHITECTURE.md` §1 引入 electron-vite 工程化，并同步更新本文件。

部署/分发属延期项（PRD §9）：技术选型已定（electron-builder + electron-updater + GitHub Releases），发布渠道与签名策略待定。

## 9. 范围纪律（PRD §8，MVP 内明确不做）

- 账户系统、云同步、团队协作
- 内置模型代理/计费层
- 独立用量 dashboard、看板、自动化工作流
- 插件/MCP 生态管理界面

不要主动实现上述内容；如用户要求，先指出其与已锁定范围冲突。
