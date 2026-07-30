# 调研：各 agent 的自定义 provider / model 配置机制

> Issue: LeonEthan/open-cowork#3
> 调研日期： 2026-07-30
> 调研对象： Claude Code (@anthropic-ai/claude-code)、Codex CLI (openai/codex)、Pi (badlogic/pi-mono, npm 包 `@mariozechner/pi-coding-agent`)、opencode (sst/opencode)

---

## 1. 结论速览

| Agent | 主配置入口 | 环境变量直配 | OpenAI 兼容 endpoint | Anthropic 兼容 endpoint | 隔离配置目录 |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` 的 `env` 块 + 环境变量 | **是**（`ANTHROPIC_*`，一等公民） | 否（需代理转换） | **是**（原生协议） | 项目级 `.claude/settings.json` |
| Codex CLI | `~/.codex/config.toml` 的 `[model_providers]` | 部分（`OPENAI_BASE_URL`/`OPENAI_API_KEY` 仅作用于默认 openai provider） | **是**（chat / responses 两种 wire API） | 否（需代理转换） | `CODEX_HOME` 环境变量 |
| Pi | `~/.pi/agent/models.json` 的 `providers` | 间接（apiKey 支持 `"$ENV_VAR"` 插值；`--api-key` 旗标） | **是**（`openai-completions` / `openai-responses`） | **是**（`anthropic-messages`） | `PI_CODING_AGENT_DIR` 环境变量 |
| opencode | `opencode.json` 的 `provider` 块 | 间接（`{env:VAR}` 插值取 key） | **是**（`@ai-sdk/openai-compatible`） | **是**（`@ai-sdk/anthropic`） | 项目级 `opencode.json` |

**关键结论**: 只有 Claude Code 把「换 provider」做成纯环境变量问题；其余三家都需要写各自格式的配置文件。四家全部有办法做**进程级/项目级隔离配置**，这对 open-cowork 多实例并发至关重要。

---

## 2. 环境变量支持矩阵

| 环境变量 | Claude Code | Codex CLI | Pi | opencode |
|---|---|---|---|---|
| `ANTHROPIC_BASE_URL` | ✅ 原生支持，重定向所有请求 | ❌ | ❌（走 models.json） | ❌（走 opencode.json） |
| `ANTHROPIC_AUTH_TOKEN` | ✅ 自定义 endpoint 应使用此项（Bearer token） | ❌ | ❌ | ❌ |
| `ANTHROPIC_API_KEY` | ✅ 仅直连 Anthropic 时用；与 AUTH_TOKEN 同设会 401 冲突 | ❌ | 可被 models.json 引用 | 可被 `{env:...}` 引用 |
| `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` | ✅ 指定主模型 / 后台小模型 | ❌ | ❌ | ❌ |
| `OPENAI_BASE_URL` | ❌ | ✅ 作用于内置 openai provider | ❌ | ❌ |
| `OPENAI_API_KEY` | ❌ | ✅ 默认 provider 的 key（codex 中任意 provider 用 `env_key` 指向任意变量名） | 可被引用 | 可被引用 |
| 配置目录重定向 | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `PI_CODING_AGENT_DIR` | 项目内 `opencode.json`（自动发现） |

注意：
- Claude Code 改 `ANTHROPIC_BASE_URL` 时**必须 unset `ANTHROPIC_API_KEY`**，否则 401；已有订阅登录需先 `claude /logout`。
- 自定义 base URL 下 Claude Code 可能发送代理不认识的 `anthropic-beta` 头导致 400，是已知兼容性问题（选代理层时需验证）。

---

## 3. 各家配置机制详解与示例

### 3.1 Claude Code

纯环境变量驱动，可写进 `~/.claude/settings.json`（全局）或 `<项目>/.claude/settings.json`（项目级）的 `env` 块：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "zhipu-api-key",
    "ANTHROPIC_MODEL": "glm-4.6",
    "ANTHROPIC_SMALL_FAST_MODEL": "glm-4.5-air"
  }
}
```

- 协议要求： endpoint 必须讲 Anthropic Messages API。OpenAI 兼容 endpoint 需经 LiteLLM 等代理转换。
- 企业变量： `ANTHROPIC_BEDROCK_BASE_URL`、`ANTHROPIC_VERTEX_BASE_URL`、`ANTHROPIC_FOUNDRY_BASE_URL`、`ANTHROPIC_CUSTOM_HEADERS`、`HTTPS_PROXY`。
- 校验： 会话内 `/status` 查看生效配置。

### 3.2 Codex CLI

`~/.codex/config.toml`（**注意： `model_provider(s)` 只在用户级 config 生效，项目级 `.codex/config.toml` 被忽略；用 `CODEX_HOME` 指向托管目录来做隔离**）：

```toml
model = "deepseek-chat"
model_provider = "deepseek"
preferred_auth_method = "apikey"   # 强制 API key 认证，跳过 ChatGPT 登录

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"   # 不要带结尾斜杠
env_key = "DEEPSEEK_API_KEY"               # key 从环境变量读，不写进文件
wire_api = "chat"                          # "chat" = Chat Completions; "responses" = Responses API
# http_headers = { "X-Foo" = "bar" }       # 可选自定义头
# query_params = { api-version = "..." }   # Azure 场景
```

- `wire_api` 二选一： 多数第三方/代理只有 Chat Completions，用 `"chat"`；OpenAI 官方与部分新网关支持 `"responses"`。（有社区报告称新版本在收紧 chat 支持，落地时应以所装版本的 `docs/config.md` 为准。）
- 本地模型有专用 `codex --oss`（Ollama / LM Studio）。
- 协议要求： 只讲 OpenAI 系 API；Anthropic 兼容 endpoint 需代理转换。

### 3.3 Pi (badlogic/pi-mono)

先澄清： 这里的 pi 指 Mario Zechner (badlogic) 的 pi-mono monorepo 中的 coding agent（npm: `@mariozechner/pi-coding-agent`），配置目录默认 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 重定向。

自定义 provider 写 `~/.pi/agent/models.json`：

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [
        { "id": "deepseek-chat" },
        { "id": "deepseek-reasoner", "reasoning": true }
      ]
    },
    "zhipu-anthropic": {
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "api": "anthropic-messages",
      "apiKey": "$ZHIPU_API_KEY",
      "models": [{ "id": "glm-4.6" }]
    }
  }
}
```

- `api` 取值： `openai-completions`、`openai-responses`、`anthropic-messages`、`google-*` 等 —— **四家中唯一同时原生讲两种协议的**。
- `apiKey` 三种写法： 字面量、`"$ENV_VAR"` 环境插值、`"!op read ..."` shell 命令取值。
- 可覆盖内置 provider 的 `baseUrl`（把官方 Anthropic 指向代理）而无需重列模型；`compat` 字段（`supportsDeveloperRole` 等）适配 Ollama/vLLM 等不完全兼容服务。
- CLI 旗标： `--provider` / `--model` / `--api-key` / `--list-models`；会话内 `/model` 切换。

### 3.4 opencode (sst/opencode)

项目级 `opencode.json`（自动从项目根发现），基于 Vercel AI SDK provider 包：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com/v1",
        "apiKey": "{env:DEEPSEEK_API_KEY}"
      },
      "models": {
        "deepseek-chat": { "name": "DeepSeek Chat" }
      }
    },
    "kimi-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "options": {
        "baseURL": "https://api.moonshot.cn/anthropic",
        "apiKey": "{env:MOONSHOT_API_KEY}"
      },
      "models": {
        "kimi-k2-0711-preview": {}
      }
    }
  },
  "model": "deepseek/deepseek-chat"
}
```

- `npm` 字段决定协议： `@ai-sdk/openai-compatible`（OpenAI 系）/ `@ai-sdk/anthropic`（Anthropic 系）—— 两种协议都支持。
- key 用 `{env:VAR_NAME}` 插值，不落盘。
- 模型元数据（上下文窗口、价格）来自 models.dev；自定义 model 条目可覆盖。
- 内置 provider 的 key 也可用 `opencode auth login` 管理。

---

## 4. 本地代理层（LiteLLM / one-api）兼容性

| 代理层 | 暴露协议 | Claude Code | Codex | Pi | opencode |
|---|---|---|---|---|---|
| LiteLLM proxy | OpenAI `/v1` + Anthropic `/anthropic` 双协议 | ✅ 指到 `/anthropic` | ✅ 指到 `/v1` | ✅ 两种 api 均可 | ✅ 两种 npm 包均可 |
| one-api / new-api | 主要 OpenAI `/v1`；new-api 有 Anthropic 渠道 | 经 new-api anthropic 渠道 ✅ | ✅ | ✅ | ✅ |

代理层价值： 协议转换（让 Claude Code 用 OpenAI 系模型、让 Codex 用 Anthropic 系模型）、key 集中管理、限流/审计。代价： 多一个进程、beta 头等边缘特性可能被代理吞掉、增加延迟。

---

## 5. 国内可直连 provider 接入路径表

| Provider | OpenAI 兼容端点 | Anthropic 兼容端点 | Claude Code | Codex | Pi | opencode |
|---|---|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `https://api.deepseek.com/anthropic` | env 直配 (A) | config.toml (O) | models.json 两种皆可，且有内置 deepseek provider | opencode.json 两种皆可 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `https://open.bigmodel.cn/api/anthropic` | env 直配 (A) | config.toml (O) | 两种皆可 | 两种皆可 |
| Kimi / Moonshot | `https://api.moonshot.cn/v1` | `https://api.moonshot.cn/anthropic` | env 直配 (A) | config.toml (O) | 两种皆可 | 两种皆可 |
| 通义千问 / 百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `https://dashscope.aliyuncs.com/apps/anthropic`（Coding Plan: `https://coding.dashscope.aliyuncs.com/apps/anthropic`；新版按量端点带 WorkspaceId，如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic`） | env 直配 (A) | config.toml (O) | 两种皆可 | 两种皆可 |

(A) = Anthropic 兼容路径，(O) = OpenAI 兼容路径。四家国内 provider 均同时提供两种协议端点，因此**任何一家 agent 都可以不经过代理直连任何一家国内 provider**。

### 具体配置示例

**Claude Code + GLM:**
```bash
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_AUTH_TOKEN="zhipu-key"
export ANTHROPIC_MODEL="glm-4.6"
unset ANTHROPIC_API_KEY   # 关键，避免 401
claude
```

**Codex + DeepSeek:** 见 3.2 节 config.toml，另需 `export DEEPSEEK_API_KEY=sk-...`。

**Pi + Kimi:**
```json
{ "providers": { "kimi": {
  "baseUrl": "https://api.moonshot.cn/anthropic",
  "api": "anthropic-messages",
  "apiKey": "$MOONSHOT_API_KEY",
  "models": [{ "id": "kimi-k2-0711-preview" }] } } }
```

**opencode + 通义千问:**
```json
{ "provider": { "qwen": {
  "npm": "@ai-sdk/openai-compatible",
  "options": { "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
               "apiKey": "{env:DASHSCOPE_API_KEY}" },
  "models": { "qwen3-coder-plus": {} } } },
  "model": "qwen/qwen3-coder-plus" }
```

---

## 6. 三种候选机制对比（open-cowork 视角）

| 机制 | 做法 | 利 | 弊 |
|---|---|---|---|
| A. 环境变量注入 | spawn agent 进程时注入 `ANTHROPIC_*` / `OPENAI_*` 等 | 无文件读写、天然进程级隔离、并发安全；Claude Code/Codex 开箱即用 | 覆盖面不全： Pi / opencode 不能用纯标准环境变量完成 provider 注册（最多注入 key）；无法表达模型列表与模型元数据；各 agent 变量名不统一 |
| B. 编辑 agent 原生配置 | 由 open-cowork 生成/合并 settings.json、config.toml、models.json、opencode.json，配合 `CODEX_HOME` / `PI_CODING_AGENT_DIR` / 项目级配置做隔离 | 四家全覆盖、能力完整（模型列表、reasoning、cost、compat）；key 均可 env 引用不落盘；配置即代码可审查 | 四种 schema 异构，需跟随 agent 版本维护；合并用户已有配置要小心（应写隔离目录而非改用户全局配置） |
| C. 内置本地代理层 | open-cowork 内嵌 LiteLLM 类代理，统一翻译成 OpenAI+Anthropic 双协议，agent 全部走 `localhost` | 一处接入所有 provider；协议转换兜底（Claude Code↔OpenAI 系、Codex↔Anthropic 系）；key/限流/审计集中 | 额外进程与依赖（Python 运行时或 Node 等价物）；beta 头、prompt caching、thinking 等边缘特性可能被代理损失；延迟与运维复杂度 |

### 推荐

**以 B（生成隔离的原生配置）为主、A（环境变量）为其实现手段与兜底、不内置代理层（C 仅作为用户可选外挂）。**

理由：
1. 四家国内 provider 都自带双协议端点，四家在 2026 年的版本里都能直连国内 provider，**协议转换不是刚需**，内置代理层的核心价值（协议转换）在国内场景不成立。
2. B 是唯一能统一覆盖四家的机制；且每家都有隔离手段（`CODEX_HOME`、env、`PI_CODING_AGENT_DIR`、项目级 opencode.json/.claude/settings.json），open-cowork 为每个 workspace 生成独立配置目录即可，**绝不改写用户全局配置**。
3. key 一律走环境变量（codex `env_key`、pi `"$VAR"`、opencode `{env:VAR}`、claude `ANTHROPIC_AUTH_TOKEN`），即「配置文件由 B 生成、密钥由 A 注入」，两者自然结合。
4. 用户已有自建 LiteLLM/one-api 时，B 同样适用——把 baseUrl 指向用户的代理即可，无需我们内嵌。

---

## 7. 参考来源

- Claude Code 环境变量官方文档： https://code.claude.com/docs/en/env-vars
- Claude Code 模型配置： https://code.claude.com/docs/en/model-config
- Codex 配置文档： https://github.com/openai/codex/blob/main/docs/config.md
- Codex provider 实现： https://github.com/openai/codex/blob/main/codex-rs/core/src/model_provider_info.rs
- Pi coding-agent README: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md
- Pi models 配置文档： https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md
- Pi 作者博客： https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- opencode providers 文档： https://opencode.ai/docs/providers/
- 阿里云百炼 Claude Code 接入文档： https://help.aliyun.com/zh/model-studio/claude-code
- Claude Code 第三方模型兼容配置汇总： https://github.com/Alorse/cc-compatible-models
- Requesty Claude Code 集成指南： https://docs.requesty.ai/integrations/claude-code
