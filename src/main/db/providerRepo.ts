import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import type { Provider } from './entities';

/**
 * Provider 仓储（ticket #21）：任意 provider 的自由 model 配置（PRD §4.6 / ARCHITECTURE §3）。
 *
 * 红线：本模块只经手密文（encrypted_api_key，base64）——加解密在
 * src/main/providers/credentials.ts（注入式 encryptor），密钥明文绝不入库。
 *
 * 纯 Node 无 Electron 依赖，vitest 可直接用 ':memory:' 跑。
 */

export interface CreateProviderInput {
  name: string;
  /** preset 内置六家 / custom 自定义 */
  kind: 'preset' | 'custom';
  /** 线协议：anthropic / openai（OpenAI 兼容） */
  protocol: string;
  baseUrl: string;
  /** 来源预设 id（kind='preset' 时必给） */
  presetId?: string | null;
  /** safeStorage 密文（base64）；无密钥的 provider 不允许（启动任务时无密钥即失败） */
  encryptedApiKey: string;
  /** env 角色映射覆盖；null = 预设/协议默认 */
  envMap?: { keyEnvs?: string[]; baseUrlEnv?: string } | null;
  /** 初始模型清单缓存（通常 null —— list 时回落预设静态清单） */
  modelsJson?: string | null;
}

export function create(db: Database, input: CreateProviderInput, now: number = Date.now()): Provider {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('provider 名称不能为空');
  if (typeof input.baseUrl !== 'string' || input.baseUrl.trim().length === 0) {
    throw new Error('provider base URL 不能为空');
  }
  if (typeof input.protocol !== 'string' || input.protocol.length === 0) {
    throw new Error('provider protocol 不能为空');
  }
  const row: Provider = {
    id: randomUUID(),
    name,
    kind: input.kind,
    base_url: input.baseUrl.trim(),
    protocol: input.protocol,
    credential_key: null, // #17 留位列：凭证本体走 encrypted_api_key（safeStorage 密文）
    models_json: input.modelsJson ?? null,
    encrypted_api_key: input.encryptedApiKey,
    preset_id: input.presetId ?? null,
    env_map_json: input.envMap ? JSON.stringify(input.envMap) : null,
    models_fetched_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO providers (id, name, kind, base_url, protocol, credential_key, models_json,
                            encrypted_api_key, preset_id, env_map_json, models_fetched_at,
                            created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.kind,
    row.base_url,
    row.protocol,
    row.credential_key,
    row.models_json,
    row.encrypted_api_key,
    row.preset_id,
    row.env_map_json,
    row.models_fetched_at,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function list(db: Database): Provider[] {
  return db
    .prepare('SELECT * FROM providers ORDER BY created_at ASC, id ASC')
    .all() as Provider[];
}

export function getById(db: Database, id: string): Provider | null {
  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Provider | undefined;
  return row ?? null;
}

/** 写入模型清单缓存（/models 拉取 + models.dev 元数据合并后的 JSON） */
export function setModels(
  db: Database,
  id: string,
  modelsJson: string,
  fetchedAt: number,
  now: number = Date.now(),
): void {
  db.prepare(
    'UPDATE providers SET models_json = ?, models_fetched_at = ?, updated_at = ? WHERE id = ?',
  ).run(modelsJson, fetchedAt, now, id);
}

/**
 * 移除 provider。tasks.provider_id 有外键引用——先把引用它的任务快照清空
 * （provider_id/model 回退为 NULL = agent 默认），同事务删除 provider 行。
 */
export function remove(db: Database, id: string): void {
  db.transaction(() => {
    db.prepare('UPDATE tasks SET provider_id = NULL, model = NULL, updated_at = ? WHERE provider_id = ?').run(
      Date.now(),
      id,
    );
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  })();
}
