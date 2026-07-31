/**
 * provider 运行时（ticket #21，main 进程专属——唯一允许接触 Electron safeStorage / fs 的一层）。
 *
 * 红线（ARCHITECTURE §3/§10）：
 * - safeStorage 加密落盘、解密只在 main 进程内（组装 agent env / 拉模型清单）发生；
 * - 生成文件只写 OPEN_COWORK_DATA_DIR/workspace-configs/<workspaceId>/<agent>/，
 *   绝不触碰 ~/.claude、~/.codex、~/.config/opencode、~/.pi 等用户全局位置。
 */

import { safeStorage } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { join } from 'node:path';
import type { Database } from '../db/database';
import type { Provider, Task } from '../db/entities';
import * as providerRepo from '../db/providerRepo';
import { buildProviderInjection, configEnvValue, modelIdsForInjection } from './agentEnv';
import type { Encryptor } from './credentials';
import { decryptApiKey } from './credentials';
import type { HttpGet, HttpGetResult } from './modelsFetch';

// ── 加密器（safeStorage / Keychain） ───────────────────────────────────────

let cachedEncryptor: Encryptor | null = null;

/**
 * 生产加密器（lazy 单例）。系统加密不可用即抛错——宁可拒绝配置也不落明文（红线）。
 * vitest 不经这里（注入测试 encryptor）；e2e 用真 safeStorage。
 */
export function getEncryptor(): Encryptor {
  if (cachedEncryptor) return cachedEncryptor;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用（safeStorage/Keychain），无法保存密钥');
  }
  cachedEncryptor = {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipherBase64) => safeStorage.decryptString(Buffer.from(cipherBase64, 'base64')),
  };
  return cachedEncryptor;
}

/** 测试/重置用（不改生产语义） */
export function resetEncryptorForTests(): void {
  cachedEncryptor = null;
}

// ── HTTP（/models 与 models.dev 拉取） ─────────────────────────────────────

/** node https 实现的 HttpGet（10s 超时由调用方给；非 2xx 不抛——状态码交回判定） */
export const nodeHttpGet: HttpGet = (url, headers, timeoutMs) =>
  new Promise<HttpGetResult>((resolve, reject) => {
    const req = get(url, { headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
  });

// ── 任务启动 env 注入闭环 ──────────────────────────────────────────────────

/** per-workspace 生成配置根目录（数据目录内，绝不写用户全局） */
export function workspaceConfigRoot(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspace-configs', workspaceId);
}

/**
 * 组装任务的 provider 注入 env（agent:start 调用点）。
 * - task.provider_id 为 null → 返回 undefined（agent 默认链路，无注入）；
 * - provider 缺失/密钥缺失/解密失败 → 抛错（启动随之失败，任务停留 ready，UI 呈现原因）；
 * - 生成文件幂等重写（密钥轮换/模型清单刷新后以最新快照再生）。
 */
export function prepareProviderEnv(args: {
  db: Database;
  dataDir: string;
  task: Task;
}): Record<string, string> | undefined {
  const { db, dataDir, task } = args;
  if (!task.provider_id) return undefined;

  const provider = providerRepo.getById(db, task.provider_id);
  if (!provider) {
    throw new Error('任务引用的 provider 已被移除——请在任务上重新选择 provider');
  }
  if (!provider.encrypted_api_key) {
    throw new Error(`provider「${provider.name}」缺少密钥——请在设置页重新配置`);
  }
  const apiKey = decryptApiKey(getEncryptor(), provider.encrypted_api_key);

  const injection = buildProviderInjection(
    provider,
    apiKey,
    task.agent_type,
    task.model,
    modelIdsForInjection(provider),
  );

  // 落盘生成文件（数据目录内）+ 回填指向 env
  if (injection.configTarget && injection.files.length > 0) {
    const root = workspaceConfigRoot(dataDir, task.workspace_id);
    for (const f of injection.files) {
      const abs = join(root, f.relPath);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, f.content, 'utf8');
    }
    injection.env[injection.configTarget.envName] = configEnvValue(root, injection.configTarget);
  }

  return injection.env;
}
