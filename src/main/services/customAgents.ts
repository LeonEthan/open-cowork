import * as customAgentRepo from '../db/customAgentRepo';
import type { CustomAgent } from '../db/entities';
import type { ServiceContext } from './index';
import { parseCustomProbe, probeAndRecordCustomAgent } from './agentDetect';

/**
 * 自定义 ACP agent 注册服务（ticket #26，PRD §4.5）：
 * 表单录入（名称 + 命令 + 参数 + 可选环境变量）→ custom_agents 落库 → 即时探测
 * （结果回写 last_probe_json，agents:list 合并视图随之更新）。
 * 会话实例化：task.agent_type = 'custom:<id>'，启动时由 services/agent.ts 把
 * 本表 spec 随 start 指令传给 utility，经 acp driver（src/agent/drivers/acp.driver.ts）跑起。
 *
 * 幂等约定：create 总是新行；remove 硬删除（引用它的任务启动时得到明确错误）；
 * reprobe 可任意重复（只刷新探测快照）。
 */

/** renderer 卡片 DTO（探测快照展平；密钥类 env 值原样返回——用户本机自填，无第三方凭证） */
export interface CustomAgentInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  installed: boolean;
  resolvedPath: string | null;
  version: string | null;
  probeError: string | null;
  probedAt: number | null;
  createdAt: number;
}

function toInfo(row: CustomAgent): CustomAgentInfo {
  const probe = parseCustomProbe(row);
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: customAgentRepo.parseArgs(row),
    env: customAgentRepo.parseEnv(row),
    installed: probe?.ok === true,
    resolvedPath: probe?.resolvedPath ?? null,
    version: probe?.version ?? null,
    probeError: probe?.error ?? null,
    probedAt: probe?.at ?? null,
    createdAt: row.created_at,
  };
}

function parseInput(raw: unknown): customAgentRepo.CreateCustomAgentInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  return {
    name: typeof input.name === 'string' ? input.name : '',
    command: typeof input.command === 'string' ? input.command : '',
    args: Array.isArray(input.args) ? (input.args as string[]) : [],
    ...(input.env && typeof input.env === 'object' && !Array.isArray(input.env)
      ? { env: input.env as Record<string, string> }
      : {}),
  };
}

export default function register(ctx: ServiceContext): void {
  /** 注册列表（含探测快照） */
  ctx.ipcMain.handle('custom-agents:list', () => customAgentRepo.list(ctx.db).map(toInfo));

  /** 注册：校验 → 落库 → 即时探测（结果随列表返回） */
  ctx.ipcMain.handle('custom-agents:create', async (_e, raw: unknown) => {
    const row = customAgentRepo.create(ctx.db, parseInput(raw));
    await probeAndRecordCustomAgent(ctx.db, row);
    return customAgentRepo.list(ctx.db).map(toInfo);
  });

  /** 删除（引用它的任务保留 agent_type 快照，启动时报「已删除」） */
  ctx.ipcMain.handle('custom-agents:remove', (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('custom-agents:remove 需要 id');
    customAgentRepo.remove(ctx.db, id);
    return { ok: true as const };
  });

  /** 重新探测单家（修复命令/环境后手动重验证） */
  ctx.ipcMain.handle('custom-agents:reprobe', async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('custom-agents:reprobe 需要 id');
    const row = customAgentRepo.getById(ctx.db, id);
    if (!row) throw new Error(`自定义 agent 不存在: ${id}`);
    await probeAndRecordCustomAgent(ctx.db, row);
    return customAgentRepo.list(ctx.db).map(toInfo);
  });
}
