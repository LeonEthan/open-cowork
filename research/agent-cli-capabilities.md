# 外部 Agent CLI 程序化接入能力调研

> 对应 issue: LeonEthan/open-cowork#2
> 调研日期： 2026-07-30。所有 CLI flag 均在本机实测验证（`--help` / 实际调用），版本：Claude Code 2.1.220、Codex CLI 0.146.0、opencode 1.18.3、pi 0.83.0（本机为 earendil-works fork，npm 上游 `@mariozechner/pi-coding-agent` 0.73.1）。

## 0. TL;DR

四家都能非交互运行，但"可编程深度"差异很大：

- **流式结构化输出**：四家都有（JSONL/NDJSON 或 SSE）。
- **外部注入审批（批准/拒绝）**：只有 **Claude Code**（stream-json 控制协议 / `--permission-prompt-tool`）和 **opencode**（HTTP API `POST /permission/{requestID}/reply`）支持程序化审批协商；**Codex exec** 无 TTY 时审批自动降级为 never（只能靠 sandbox 模式静态配置或全量 bypass）；**pi** 干脆没有内建工具审批模型（信任模型只管项目资源加载，不管工具调用）。
- **双向持久通道**：pi 的 `--mode rpc`（JSONL 命令/事件 over stdio）和 opencode 的 `serve`（REST + SSE）是真正的"长连接适配"形态；Claude Code 用 `--input-format stream-json` 也能做双工；Codex 有实验性的 `app-server`（JSON-RPC）。
- **ACP**：opencode 原生支持（`opencode acp`）；Claude Code 与 Codex 靠 Zed 维护的外部适配器（`@zed-industries/claude-code-acp`、`zed-industries/codex-acp`）；pi 不支持。
- **MCP**：Claude Code / Codex / opencode 均支持配置传入；pi 核心无 MCP（仓库 1307 个文件 0 处 mcp 匹配，需扩展自行实现）。

## 1. 对比矩阵

| 维度 | Claude Code | Codex CLI | pi | opencode |
|---|---|---|---|---|
| headless 调用 | `claude -p "<prompt>"` | `codex exec "<prompt>"`（或 stdin） | `pi -p "<prompt>"` | `opencode run "<msg>"`；`opencode serve`（常驻 HTTP） |
| 双向流式通道 | `-p --input-format stream-json --output-format stream-json`（stdin/stdout JSONL 双工） | `codex app-server`（实验性 JSON-RPC，stdio/ws） | `pi --mode rpc`（stdin 命令 / stdout 事件，JSONL） | `serve` REST + `GET /event` SSE；`acp` stdio |
| 流式事件类型 | `system(init)`、`assistant`、`user`、`result`；`stream_event`（`--include-partial-messages`）、`hook_*`（`--include-hook-events`）、`control_request`/`control_response` | `--json` JSONL：`thread.started`、`turn.started/completed/failed`、`item.started/completed`（item 含 agent_message/reasoning/command_execution/file_change/mcp_tool_call 等）、`error` | `agent_start/end/settled`、`turn_start/end`、`message_start/update/end`（delta 级）、`tool_execution_start/update/end`、`queue_update`、`compaction_*`、`extension_error` 等 20+ 种 | SSE/JSON 事件：`session.updated`、`message.updated`、`message.part.updated`、`permission.asked` 等；`run --format json` 输出原始 JSON 事件 |
| 审批协商（外部注入） | ✅ `--permission-prompt-tool <mcp-tool>`（调外部 MCP 工具决定）；或 stream-json 双工下 `control_request(subtype=can_use_tool)` → 客户端回 `control_response`；`--permission-mode acceptEdits/plan/bypassPermissions/...`；`--dangerously-skip-permissions` | ⚠️ exec 无 TTY 时 `on-request` 降级为 `never`；只能静态配置 `--sandbox read-only/workspace-write/danger-full-access`、`--ask-for-approval`、`--dangerously-bypass-approvals-and-sandbox`；已知 bug：exec 会静默取消 MCP 工具调用审批（openai/codex#29857） | ❌ 无内建工具级审批（设计上无 sandbox，靠容器/VM 隔离）；只有项目资源信任（`--approve/-a`）；扩展可在 RPC 模式下用 Extension UI Protocol（`confirm`/`select`/`input` 请求↔响应）实现自定义确认 | ✅ `POST /permission/{requestID}/reply`（`once/always/reject`）；配置侧 `permission: allow/ask/deny`；`run --auto` 自动批准 |
| ACP 支持 | 间接：Zed 官方适配器 `@zed-industries/claude-code-acp`（npm 0.16.2，基于 Claude Agent SDK，活跃维护） | 间接：`zed-industries/codex-acp`（活跃，2026-07 仍在更新） | ❌ 无 | ✅ 原生 `opencode acp`（ACP server over stdio） |
| session resume | `--resume <id>` / `--continue`、`--fork-session`、`--session-id <uuid>`、`--no-session-persistence` | `codex exec resume <SESSION_ID>/"--last"`；`--ephemeral` 不落盘 | `--continue` / `--resume` / `--session <path|id>` / `--session-id` / `--fork` / `--no-session` | `run --continue` / `--session <id>` / `--fork`；serve 模式 session 常驻可复用 |
| 工作目录 | 进程 cwd；`--add-dir` 追加授权目录 | `-C/--cd <DIR>`；`--add-dir <DIR>` | 进程 cwd；`--session-dir` 控制会话存储 | `run --dir <path>`；`acp --cwd`；serve 以项目目录为上下文 |
| 环境变量传入 | 直接继承进程 env（`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 等）；`--settings` JSON | 继承 env（`CODEX_API_KEY`）；`-c shell_environment_policy.*` 控制子进程 env 继承策略 | 继承 env（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等十余家）；`--api-key` | 继承 env；server 有 basic auth（`OPENCODE_SERVER_PASSWORD`） |
| MCP 配置传入 | `--mcp-config <json文件或字符串>`（可多个）、`--strict-mcp-config` | `config.toml` 的 `[mcp_servers.*]` 或 `-c 'mcp_servers.x.command=...'`；`codex mcp add <name> -- <cmd>` / `--url`（支持 stdio 与 streamable HTTP） | ❌ 核心不支持（需扩展自行接 MCP client） | `opencode.json` 的 `"mcp"` 段（local command/env 或 remote url）；serve 模式另有 `/mcp*` 管理端点 |

## 2. 各家最小可运行示例

### 2.1 Claude Code — headless + 结构化流

```bash
# 最简单：打印结果并退出
claude -p "列出 src 下所有 ts 文件"

# 结构化流式输出（实测事件序列：system(init) → assistant* → result(success)）
echo "what is 2+2?" | claude -p --output-format stream-json --verbose

# 双工 + 外部审批协商：stdin/stdout 都走 stream-json，
# 工具授权以 {"type":"control_request","request":{"subtype":"can_use_tool",...}} 发出，
# 客户端回 {"type":"control_response","response":{"subtype":"success","request_id":...,"response":{"behavior":"allow"}}}
claude -p --input-format stream-json --output-format stream-json \
        --permission-prompt-tool stdio --verbose

# 恢复会话 + 注入 MCP + 限制权限
claude -p --resume <session-id> --mcp-config ./mcp.json \
        --permission-mode acceptEdits "继续刚才的重构"
```

要点：headless 下跳过 workspace trust 对话框；`--max-budget-usd`、`--allowedTools/--disallowedTools`、`--json-schema` 结构化输出都是自动化友好设计。正式集成优先用 **Claude Agent SDK**（TS/Python），它内部就是这套 stream-json 控制协议。

### 2.2 Codex CLI — exec 非交互

```bash
# 单次执行：进度走 stderr，最终答复走 stdout
codex exec "生成 changelog"

# 结构化事件流（JSONL: thread.started → turn.started → item.* → turn.completed）
codex exec --json "修复 lint 错误" | jq -c 'select(.type=="item.completed")'

# 沙箱与审批：无 TTY 时审批提示不可用，靠沙箱级别静态控制
codex exec --sandbox workspace-write --ask-for-approval never "跑测试并修复"

# 恢复上次会话
codex exec resume --last "再补一条边界用例"

# CI 模式（外部已隔离环境 + API key）
CODEX_API_KEY=... codex exec --dangerously-bypass-approvals-and-sandbox "..."
```

要点：`codex exec` 是"一发一收"模型，运行中无法注入指令或审批决定；需要双向控制得用实验性 `codex app-server`（JSON-RPC，自带 `generate-ts`/`generate-json-schema` 绑定生成）或走 ACP 适配器。已知坑：exec 退出码不反映内部命令失败（openai/codex#15536）。

### 2.3 pi — RPC 模式

pi 即 badlogic/pi-mono 的 pi coding agent（npm `@mariozechner/pi-coding-agent`，现由 earendil-works 维护），Mario Zechner 的极简编码 agent。

```bash
# 一次性 headless
pi -p "列出 src 下所有 ts 文件"

# JSON 输出模式（事件流，只读输出）
pi -p --mode json "review 这段代码"

# RPC 模式：常驻进程，stdin 发命令、stdout 收事件（JSONL）
pi --mode rpc --model sonnet
# → 发送:  {"id":"req-1","type":"prompt","message":"修复 failing test"}
# ← 事件:  {"type":"agent_start"} / {"type":"message_update",...delta...} /
#          {"type":"tool_execution_start","toolName":"bash",...} / {"type":"agent_settled"}
# 控制命令: get_state / abort / steer（插队指令）/ follow_up / bash / fork / compact ...

# 会话续聊
pi --continue "刚才那个方案再细化下"
```

要点：RPC 协议文档完整（`docs/rpc.md`，1500+ 行），事件粒度到 text/thinking/toolcall delta，支持 `streamingBehavior: steer/followUp` 运行中插队——这是四家里最"agent-native"的双工协议。短板：无内建工具审批（官方明确说不做 sandbox，建议容器隔离）、无 MCP、无 ACP；自定义确认需写扩展走 Extension UI Protocol（`confirm`/`select` 请求-响应）。Node 场景也可直接 import `@earendil-works/pi-coding-agent` 的 `AgentSession`，连子进程都省了。

### 2.4 opencode — run / serve / acp 三形态

```bash
# 一次性 headless，原始 JSON 事件
opencode run --format json "给这个函数加注释"

# 常驻 HTTP 服务：REST + SSE（实测 /doc 暴露完整 OpenAPI）
opencode serve --port 4096 &
curl -X POST http://127.0.0.1:4096/session -d '{"title":"demo"}'          # 建会话
curl -X POST http://127.0.0.1:4096/session/<id>/prompt_async -d '{...}'   # 发 prompt
curl -N http://127.0.0.1:4096/event                                       # SSE 订阅全部事件
# 审批协商：收到 permission.asked 事件后
curl -X POST http://127.0.0.1:4096/permission/<requestID>/reply \
     -d '{"reply":"once"}'                                                # once/always/reject

# ACP 模式（Zed 等 ACP 客户端直接接）
opencode acp --cwd /path/to/project

# 续聊
opencode run --continue "继续" ; opencode run --session <id> "..."
```

要点：opencode 是四家里**服务器化最彻底**的——REST API 覆盖 session/message/permission/question/mcp/file/pty/lsp 等全部面（`/doc` 有 OpenAPI schema），还有官方 TS SDK（`@opencode-ai/sdk`）。审批、提问（elicitation）、会话 fork/revert/share 都有 API。权限配置声明式（`permission: allow/ask/deny` per tool）。

## 3. ACP（Agent Client Protocol）成熟度

| Agent | ACP 支持形态 | 成熟度 |
|---|---|---|
| opencode | 原生 `opencode acp` 子命令 | 高，官方一等公民 |
| Claude Code | Zed 维护的 `@zed-industries/claude-code-acp`（包在 Claude Agent SDK 之上） | 中：非 Anthropic 官方，但 Zed 生产环境在用（npm 周更，0.16.2） |
| Codex | Zed 维护的 `zed-industries/codex-acp` | 中：同上，社区活跃（仓库 882 star，2026-07 仍在推） |
| pi | 无 | 无 |

ACP 本身（Zed 主导，JSON-RPC over stdio，定义了 session/prompt、tool_call 更新、requestPermission 等标准方法）正在成为跨 agent UI 的事实标准——**open-cowork 若计划接多家 agent，把内部协议对齐 ACP 语义是低风险选择**。

## 4. 结论：统一适配层应该长什么样

1. **抽象成"会话进程 + 双向事件流"模型**，而不是"调用命令拿结果"。内部接口对齐 ACP 语义：`session/new(cwd, env, mcpServers)` → `session/prompt` → 事件流（`agent_message_chunk` / `tool_call` / `tool_call_update` / `requestPermission`）→ `session/resume`。这样 opencode(acp)、claude-code-acp、codex-acp 可以直接作为 backend，零自研协议成本。
2. **每家落地一个 driver**，按能力分三档接入：
   - *一等公民*（双工 + 外部审批注入）：Claude Code（stream-json control protocol / SDK）、opencode（serve REST+SSE 或 acp）。
   - *二等*（双工但无审批模型）：pi（`--mode rpc`，审批需在适配层自己实现策略闸门——比如对 `tool_execution_start` 做白名单/拦截，或要求容器化运行）。
   - *三等*（单发）：Codex exec（适合一次性任务/CI；要交互就走 codex-acp 或等 app-server 稳定）。
3. **审批抽象**：适配层暴露统一的 `PermissionRequest{tool, input, reason} → allow/deny/always` 回调。Claude 映射 `control_request/can_use_tool` 或 `--permission-prompt-tool`；opencode 映射 `/permission/{id}/reply`；Codex/pi 映射为启动期静态策略（sandbox 级别 / 工具白名单），运行期审批请求直接按策略自动应答。
4. **横向关注点统一收口到适配层**：cwd/env/MCP 配置作为 `session/new` 参数（四家都支持，pi 的 MCP 空缺由适配层代理注入：适配层自己跑 MCP client，把工具结果经 prompt/扩展喂给 pi）；session id 映射与 resume 能力表（四家都支持 resume，参数形态各异）；预算/超时/中断（`abort` 四家都有对应物：`control interrupt`、进程信号、rpc `abort`、`/session/{id}/abort`）。
5. **落地顺序建议**：先接 opencode serve 和 Claude Code stream-json（覆盖"完整交互"需求），再加 codex exec（一次性任务），pi 视需求接 rpc。若不想维护多 driver，可评估"只讲 ACP"路线：opencode 原生 + 两个 Zed 适配器，pi 放弃或自研薄 ACP shim。

## 5. 参考来源

- Claude Code：`claude --help`（2.1.220 实测）、实测 stream-json 事件序列、二进制内 `can_use_tool`/`control_request` 字符串验证
- Codex：[exec 模式 flag 实测参考](https://github.com/philipbankier/agent-cli-skills/blob/main/skills/codex-cli/reference/exec-mode-flags.md)、[81 组 flag 实验](https://gist.github.com/alexfazio/359c17d84cb6a5af12bac88fa1db9770)、[codex#15536](https://github.com/openai/codex/issues/15536)、[codex#29857](https://github.com/openai/codex/issues/29857)、本机 `codex exec --help`（0.146.0）
- pi：[pi-mono docs/rpc.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)、[docs/security.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/security.md)、仓库 tree 全量 grep（无 mcp/acp 匹配）
- opencode：本机 `opencode serve` 实测 OpenAPI（`/doc`）、`opencode run/acp --help`（1.18.3）
- ACP：`@zed-industries/claude-code-acp`（npm）、[zed-industries/codex-acp](https://github.com/zed-industries/codex-acp)
