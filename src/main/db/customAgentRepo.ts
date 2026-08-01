import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import type { CustomAgent } from './entities';

/**
 * CustomAgent 仓库（ticket #26）：自定义 ACP agent 的注册与探测快照持久化。
 *
 * 表本体在迁移 001（command/args_json/env_json），迁移 008 additive 补
 * last_probe_json（最近一次探测快照）。全部写操作幂等无状态（行级 upsert 语义无——
 * create 总是新行；remove 硬删除，引用它的任务保留 agent_type 快照串，
 * 启动时由 services/agent.ts 给出「已删除」的明确错误）。
 */

export interface CreateCustomAgentInput {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 注册入参校验（IPC 边界第一道；错误消息面向用户） */
export function validateCustomAgentInput(input: CreateCustomAgentInput): void {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 80) {
    throw new Error('名称需为 1–80 个字符');
  }
  if (input.command.trim().length === 0) {
    throw new Error('命令不能为空（可执行文件绝对路径或 PATH 上的命令名）');
  }
  if (!Array.isArray(input.args) || input.args.some((a) => typeof a !== 'string')) {
    throw new Error('参数必须是字符串数组');
  }
  if (input.args.length > 32 || input.args.some((a) => a.length > 500)) {
    throw new Error('参数过多或过长（≤32 个，每个 ≤500 字符）');
  }
  if (input.env !== undefined) {
    for (const [k, v] of Object.entries(input.env)) {
      if (!ENV_KEY_RE.test(k)) throw new Error(`非法环境变量名: ${JSON.stringify(k)}`);
      if (typeof v !== 'string') throw new Error(`环境变量 ${k} 的值必须是字符串`);
    }
  }
}

export function create(db: Database, input: CreateCustomAgentInput): CustomAgent {
  validateCustomAgentInput(input);
  const row: CustomAgent = {
    id: randomUUID(),
    name: input.name.trim(),
    command: input.command.trim(),
    args_json: JSON.stringify(input.args),
    protocol: 'acp',
    env_json: input.env && Object.keys(input.env).length > 0 ? JSON.stringify(input.env) : null,
    created_at: Date.now(),
    last_probe_json: null,
  };
  db.prepare(
    `INSERT INTO custom_agents (id, name, command, args_json, protocol, env_json, created_at, last_probe_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.command,
    row.args_json,
    row.protocol,
    row.env_json,
    row.created_at,
    row.last_probe_json,
  );
  return row;
}

export function getById(db: Database, id: string): CustomAgent | null {
  const row = db.prepare('SELECT * FROM custom_agents WHERE id = ?').get(id) as
    | CustomAgent
    | undefined;
  return row ?? null;
}

export function list(db: Database): CustomAgent[] {
  return db
    .prepare('SELECT * FROM custom_agents ORDER BY created_at ASC, id ASC')
    .all() as CustomAgent[];
}

export function remove(db: Database, id: string): boolean {
  const res = db.prepare('DELETE FROM custom_agents WHERE id = ?').run(id);
  return res.changes > 0;
}

/** 回写最近一次探测快照（services/agentDetect.ts 的 probeAndRecordCustomAgent 调用点） */
export function updateLastProbe(db: Database, id: string, probeJson: string | null): void {
  db.prepare('UPDATE custom_agents SET last_probe_json = ? WHERE id = ?').run(probeJson, id);
}

/** 防御性解析（行数据损坏时回落缺省，不让列表/启动链路崩掉） */
export function parseArgs(row: Pick<CustomAgent, 'args_json'>): string[] {
  try {
    const v = JSON.parse(row.args_json) as unknown;
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function parseEnv(row: Pick<CustomAgent, 'env_json'>): Record<string, string> {
  if (!row.env_json) return {};
  try {
    const v = JSON.parse(row.env_json) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      );
    }
  } catch {
    // fallthrough
  }
  return {};
}
