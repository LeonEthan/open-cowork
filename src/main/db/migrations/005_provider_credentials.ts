/**
 * 迁移 005（ticket #21）：provider 凭证与模型清单支撑。
 * - providers.encrypted_api_key：safeStorage.encryptString 密文（base64）；密钥明文绝不入库
 *   （ARCHITECTURE §3/§10 不碰全局、凭证不出本机）。
 * - providers.preset_id：来源内置预设 id（kind='preset' 时记录，模型清单/env 约定的兜底来源）。
 * - providers.env_map_json：env 角色映射覆盖（{ keyEnvs?: string[], baseUrlEnv?: string }），
 *   自定义 provider 可改注入子进程的变量名；NULL = 用预设/协议默认。
 * - providers.models_fetched_at：模型清单（models_json）最近一次远端拉取时间（NULL = 纯静态兜底）。
 * 纯 additive：仅新增可空列，不动既有列与数据。
 */
export default {
  name: 'provider-credentials',
  sql: `
ALTER TABLE providers ADD COLUMN encrypted_api_key TEXT;
ALTER TABLE providers ADD COLUMN preset_id TEXT;
ALTER TABLE providers ADD COLUMN env_map_json TEXT;
ALTER TABLE providers ADD COLUMN models_fetched_at INTEGER;
`,
};
