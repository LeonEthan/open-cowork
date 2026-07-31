/**
 * per-workspace 隔离原生配置生成（ticket #21 seam 2 纯函数，ARCHITECTURE §3）。
 *
 * 为各家 agent 生成原生配置内容（**绝不写用户全局目录**——调用方落到
 * OPEN_COWORK_DATA_DIR/workspace-configs/<workspaceId>/<agent>/ 下，
 * 启动时经各家官方 env 指向生成物）：
 *
 * | agent    | 生成文件      | 指向机制（官方 env）        | env 引用   |
 * |----------|---------------|-----------------------------|------------|
 * | codex    | config.toml   | CODEX_HOME=<dir>            | 目录       |
 * | pi       | models.json   | PI_CODING_AGENT_DIR=<dir>   | 目录       |
 * | opencode | opencode.json | OPENCODE_CONFIG=<file>      | 文件本体   |
 * | claude   | （不生成）     | ——env 变量已全覆盖           | —          |
 *
 * 密钥一律不入生成文件：codex 走 env_key / pi 走 apiKey=env 名 / opencode 走 {env:X} 插值，
 * 三家都引用「注入子进程的环境变量名」，密钥本体只经 env 进进程。
 *
 * 本模块纯函数、零 IO——vitest 逐字节断言生成内容与 env 映射。
 */

import type { ProviderProtocol } from './presets';

/** 内置四家 agent（task.agent_type 前缀映射；custom:<id> 无生成物） */
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'pi';

/** task.agent_type → AgentKind（未知/自定义返回 null——不生成配置） */
export function agentKindFromType(agentType: string): AgentKind | null {
  switch (agentType) {
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'pi':
      return 'pi';
    default:
      return null;
  }
}

export interface ConfigGenInput {
  /** provider 在生成文件内的 key（稳定标识，如 preset id / 'custom'；各家命名空间下唯一即可） */
  providerKey: string;
  /** 显示名（codex name / opencode name / pi 注释用途） */
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** 接收密钥的环境变量名（密钥本体不出现于任何生成文件） */
  keyEnv: string;
  /** 写入生成文件的模型清单（id 列表；可为空——各家仍会含 defaultModel） */
  models: string[];
  /** 任务选定模型（task.model 快照；null 用清单首项/缺省） */
  defaultModel: string | null;
}

export interface AgentConfigTarget {
  agent: AgentKind;
  /** 生成文件名（相对 <workspace-configs>/<workspaceId>/<agent>/） */
  fileName: string;
  /** 文件完整内容（逐字节确定性，测试断言） */
  content: string;
  /** 指向生成物的官方 env 名 */
  envName: string;
  /** env 值引用 <agent> 目录还是文件本体 */
  envTarget: 'dir' | 'file';
}

const GENERATED_BANNER = 'open-cowork 生成（ticket #21）：per-workspace 隔离配置，请勿手改；密钥经 env 注入，不落盘';

function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** codex config.toml：自定义 model_provider + env_key 引用密钥 env；wire_api 取 chat（OpenAI 兼容面最广） */
function genCodex(input: ConfigGenInput): AgentConfigTarget {
  const model = input.defaultModel ?? input.models[0] ?? null;
  const lines = [
    `# ${GENERATED_BANNER}`,
    `model_provider = "${tomlEscape(input.providerKey)}"`,
    ...(model ? [`model = "${tomlEscape(model)}"`] : []),
    '',
    `[model_providers.${input.providerKey}]`,
    `name = "${tomlEscape(input.displayName)}"`,
    `base_url = "${tomlEscape(input.baseUrl)}"`,
    `env_key = "${tomlEscape(input.keyEnv)}"`,
    `wire_api = "chat"`,
    '',
  ];
  return {
    agent: 'codex',
    fileName: 'config.toml',
    content: lines.join('\n'),
    envName: 'CODEX_HOME',
    envTarget: 'dir',
  };
}

/** pi models.json：apiKey 字段是「环境变量名」而非密钥本体（pi 官方约定） */
function genPi(input: ConfigGenInput): AgentConfigTarget {
  const api = input.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
  const models = (input.models.length > 0 ? input.models : input.defaultModel ? [input.defaultModel] : []).map(
    (id) => ({
      id,
      name: id,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    }),
  );
  const doc = {
    _comment: GENERATED_BANNER,
    providers: {
      [input.providerKey]: {
        baseUrl: input.baseUrl,
        apiKey: input.keyEnv,
        api,
        models,
      },
    },
  };
  return {
    agent: 'pi',
    fileName: 'models.json',
    content: `${JSON.stringify(doc, null, 2)}\n`,
    envName: 'PI_CODING_AGENT_DIR',
    envTarget: 'dir',
  };
}

/** opencode opencode.json：{env:X} 插值引用密钥 env；npm 按协议选 AI SDK provider 包 */
function genOpencode(input: ConfigGenInput): AgentConfigTarget {
  const npm = input.protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
  const modelIds = input.models.length > 0 ? input.models : input.defaultModel ? [input.defaultModel] : [];
  const models: Record<string, { name: string }> = {};
  for (const id of modelIds) models[id] = { name: id };
  const defaultModel = input.defaultModel ?? modelIds[0] ?? null;
  const doc: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    _comment: GENERATED_BANNER,
    provider: {
      [input.providerKey]: {
        npm,
        name: input.displayName,
        options: {
          baseURL: input.baseUrl,
          apiKey: `{env:${input.keyEnv}}`,
        },
        models,
      },
    },
    ...(defaultModel ? { model: `${input.providerKey}/${defaultModel}` } : {}),
  };
  return {
    agent: 'opencode',
    fileName: 'opencode.json',
    content: `${JSON.stringify(doc, null, 2)}\n`,
    envName: 'OPENCODE_CONFIG',
    envTarget: 'file',
  };
}

/**
 * 生成某 agent 的原生配置目标；claude 返回 null——
 * claude driver 的 env 注入（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / --model）已完整覆盖，
 * 不需要也不应写任何 settings 文件（§10 不碰全局）。
 */
export function generateAgentConfig(agent: AgentKind, input: ConfigGenInput): AgentConfigTarget | null {
  switch (agent) {
    case 'codex':
      return genCodex(input);
    case 'pi':
      return genPi(input);
    case 'opencode':
      return genOpencode(input);
    case 'claude':
      return null;
  }
}
