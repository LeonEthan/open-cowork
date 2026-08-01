import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import * as customAgentRepo from '../db/customAgentRepo';
import type { CustomAgent } from '../db/entities';
import type { ServiceContext } from './index';

/**
 * agent 环境治理服务（ticket #26，由 #22 的最小探测升级为完整 catalog）：
 * 内置四家 agent 定义（能力徽标元数据 / 安装命令 / 官网 / 认证启发式）+ 安装与认证探测 +
 * 自定义路径修复（catalog override 持久化）+ 探测日志 + 自定义 ACP agent 合并列表。
 *
 * 探测规则（安装判定保持 #22 口径：文件存在且可执行；版本号只是元数据，尽力而为）：
 * - 可执行解析优先级：env 覆盖（OPEN_COWORK_*_CLI，e2e/排障注入点）
 *   → 用户修复的持久化 override（<dataDir>/agent-overrides.json）→ PATH 逐目录扫描；
 * - 已安装才跑 `<exe> --version`（4s 超时，失败不影响安装判定，只记日志）；
 * - 认证启发式（调研口径，配置存在性 + 密钥 env，零 spawn）：
 *   claude → ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN，或 ~/.claude/.credentials.json、~/.claude.json；
 *   codex → OPENAI_API_KEY，或 ~/.codex/auth.json；
 *   opencode → ANTHROPIC_API_KEY / OPENAI_API_KEY，或 ~/.local/share/opencode/auth.json；
 *   pi → 常见 provider 密钥 env，或 ~/.pi/agent/models.json。
 *   注意：open-cowork 自身经 #21 provider env 注入密钥也能让 agent 工作——
 *   「未认证」是提醒态（横幅/徽标警告），picker 不因此置灰。
 * - 结果带缓存；agents:refresh 强制重测（含自定义 agent 实时重探测并回写 last_probe_json）；
 * - 探测过程与输出逐行记日志（ring buffer，agents:probe-log 拉取，设置页折叠区查看）。
 *
 * driverAvailable 静态维护：pi 的 driver 属 #23——未接入前 picker 一律标「即将支持」，
 * #23 落地后把 pi 行改为 true（并删除本注释）。
 */

// ── catalog 类型 ───────────────────────────────────────────────────────────

/** 能力徽标元数据（设置页卡片与 picker 的信息源；语义见 ARCHITECTURE §2 四家接入表） */
export interface AgentCapabilities {
  /** 审批能力：原生（请求路由回 open-cowork 审批流）/ 降级（无内建审批，静态策略兜底）/ 无 */
  approval: 'native' | 'degraded' | 'none';
  streaming: boolean;
  /** 用量事件归一（ARCHITECTURE §9） */
  usage: boolean;
  mcp: boolean;
}

/** 认证启发式：任一 env 存在或任一 home 相对路径文件存在即视为已认证 */
export interface AgentAuthHeuristic {
  envs: readonly string[];
  homeFiles: readonly string[];
}

export interface AgentCatalogEntry {
  id: string;
  displayName: string;
  executable: string;
  envOverride: string | null;
  driverAvailable: boolean;
  capabilities: AgentCapabilities;
  installCommand: string;
  homepage: string;
  auth: AgentAuthHeuristic;
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    executable: 'claude',
    envOverride: 'OPEN_COWORK_CLAUDE_CLI',
    driverAvailable: true,
    capabilities: { approval: 'native', streaming: true, usage: true, mcp: true },
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    homepage: 'https://docs.anthropic.com/en/docs/claude-code',
    auth: {
      envs: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
      homeFiles: ['.claude/.credentials.json', '.claude.json'],
    },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    executable: 'codex',
    envOverride: 'OPEN_COWORK_CODEX_CLI',
    driverAvailable: true,
    capabilities: { approval: 'native', streaming: true, usage: true, mcp: true },
    installCommand: 'npm install -g @openai/codex',
    homepage: 'https://github.com/openai/codex',
    auth: {
      envs: ['OPENAI_API_KEY'],
      homeFiles: ['.codex/auth.json'],
    },
  },
  {
    id: 'opencode',
    displayName: 'opencode',
    executable: 'opencode',
    envOverride: 'OPEN_COWORK_OPENCODE_CLI',
    driverAvailable: true,
    capabilities: { approval: 'native', streaming: true, usage: true, mcp: true },
    installCommand: 'npm install -g opencode-ai',
    homepage: 'https://opencode.ai',
    auth: {
      envs: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
      homeFiles: ['.local/share/opencode/auth.json'],
    },
  },
  {
    id: 'pi',
    displayName: 'pi',
    executable: 'pi',
    envOverride: null,
    driverAvailable: false, // #23：pi driver 接入后翻转
    capabilities: { approval: 'degraded', streaming: true, usage: true, mcp: false },
    installCommand: 'npm install -g @earendil-works/pi-coding-agent',
    homepage: 'https://github.com/badlogic/pi-mono',
    auth: {
      envs: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
      homeFiles: ['.pi/agent/models.json'],
    },
  },
];

/** 自定义 ACP agent 的能力徽标（ACP 原生审批/流式/usage_update；MCP 配置 UI 不在 MVP） */
export const CUSTOM_ACP_CAPABILITIES: AgentCapabilities = {
  approval: 'native',
  streaming: true,
  usage: true,
  mcp: false,
};

// ── 探测结果类型 ───────────────────────────────────────────────────────────

export interface DetectedAgent {
  id: string;
  displayName: string;
  executable: string;
  installed: boolean;
  resolvedPath: string | null;
  driverAvailable: boolean;
  // ── ticket #26（additive）──
  /** `<exe> --version` 首行输出（尽力而为；未安装/探测失败为 null） */
  version: string | null;
  /** 认证启发式结论；未安装（无法判定）与自定义 agent（无启发式）为 null */
  authenticated: boolean | null;
  capabilities: AgentCapabilities;
  installCommand: string | null;
  homepage: string | null;
  /** 生效的自定义路径修复（无 override 为 null） */
  overridePath: string | null;
  /** 本次探测时间（epoch ms） */
  probedAt: number;
  source: 'builtin' | 'custom';
}

// ── 探测日志（ring buffer，设置页折叠区查看） ───────────────────────────────

const LOG_CAP = 120;
const probeLogs = new Map<string, string[]>();

export function appendProbeLog(agentId: string, line: string): void {
  const lines = probeLogs.get(agentId) ?? [];
  lines.push(`[${new Date().toISOString()}] ${line}`);
  if (lines.length > LOG_CAP) lines.splice(0, lines.length - LOG_CAP);
  probeLogs.set(agentId, lines);
}

export function getProbeLogs(): Record<string, string[]> {
  return Object.fromEntries([...probeLogs.entries()].map(([k, v]) => [k, [...v]]));
}

// ── 可注入的探测依赖（vitest 接缝；缺省真实实现） ───────────────────────────

export interface VersionProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type VersionRunner = (cmd: string, args: string[]) => Promise<VersionProbeResult>;

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * 生产实现：spawn 带超时，绝不抛错（版本号只是元数据）。
 * stdin 置 ignore（立即 EOF）：真实 CLI 的 --version 本就不读 stdin；被探测为
 * 「任何调用都当会话」的 CLI（如 e2e 的 fake harness）经 stdin EOF 立刻退出，
 * 避免探测挂到超时（也不给脚本动作执行窗口）。
 */
const defaultRun: VersionRunner = (cmd, args) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (r: VersionProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
      finish({ code: null, stdout, stderr, error: `超时（${VERSION_PROBE_TIMEOUT_MS}ms）` });
    }, VERSION_PROBE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
      if (stdout.length > 256 * 1024) child.stdout.destroy();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
      if (stderr.length > 256 * 1024) child.stderr.destroy();
    });
    child.once('error', (err) => {
      finish({ code: null, stdout, stderr, error: err.message });
    });
    child.once('exit', (code) => {
      finish({ code, stdout, stderr });
    });
  });

export interface ProbeDeps {
  env?: NodeJS.ProcessEnv;
  home?: string | null;
  run?: VersionRunner;
  /** 可执行性检查（缺省 accessSync X_OK） */
  isExecutable?: (path: string) => boolean;
  fileExists?: (path: string) => boolean;
  log?: (line: string) => void;
  now?: () => number;
}

function defaultIsExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── 路径解析（env 覆盖 → 持久化 override → PATH） ───────────────────────────

export interface ExecutableResolution {
  installed: boolean;
  resolvedPath: string | null;
  via: 'env' | 'override' | 'path' | null;
}

export function resolveExecutable(
  entry: Pick<AgentCatalogEntry, 'executable' | 'envOverride'>,
  deps: ProbeDeps & { overrides?: Record<string, string> },
): ExecutableResolution {
  const env = deps.env ?? process.env;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const log = deps.log ?? ((): void => {});

  if (entry.envOverride) {
    const override = env[entry.envOverride];
    if (override) {
      if (isExecutable(override)) {
        log(`env 覆盖命中 ${entry.envOverride}=${override}`);
        return { installed: true, resolvedPath: override, via: 'env' };
      }
      log(`env 覆盖 ${entry.envOverride}=${override} 不可执行，继续探测`);
    }
  }

  const overridePath = deps.overrides?.[entry.executable] ?? null;
  if (overridePath) {
    if (isExecutable(overridePath)) {
      log(`自定义路径修复命中 ${overridePath}`);
      return { installed: true, resolvedPath: overridePath, via: 'override' };
    }
    log(`自定义路径 ${overridePath} 已失效（不可执行），回退 PATH 扫描`);
  }

  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, entry.executable);
    if (isExecutable(candidate)) {
      log(`PATH 探测命中 ${candidate}`);
      return { installed: true, resolvedPath: candidate, via: 'path' };
    }
  }
  log(`PATH 未找到可执行文件 ${entry.executable}`);
  return { installed: false, resolvedPath: null, via: null };
}

/** 认证启发式（纯 env/fs 检查，零 spawn） */
export function probeAuth(
  entry: Pick<AgentCatalogEntry, 'auth'>,
  deps: ProbeDeps,
): { authenticated: boolean; evidence: string } {
  const env = deps.env ?? process.env;
  const home = deps.home === undefined ? homedir() : deps.home;
  const fileExists = deps.fileExists ?? existsSync;
  const hitEnv = entry.auth.envs.find((name) => typeof env[name] === 'string' && env[name] !== '');
  if (hitEnv) return { authenticated: true, evidence: `env ${hitEnv} 已设置` };
  if (home) {
    for (const rel of entry.auth.homeFiles) {
      const abs = join(home, rel);
      if (fileExists(abs)) return { authenticated: true, evidence: `配置文件存在 ${abs}` };
    }
  }
  return {
    authenticated: false,
    evidence: `未发现密钥 env（${entry.auth.envs.join('/')}）或配置文件（${entry.auth.homeFiles.join(', ')}）`,
  };
}

/** 版本探测：--version 首行；失败返回 null（记日志，不影响安装判定） */
async function probeVersion(
  cmd: string,
  args: string[],
  deps: ProbeDeps,
  log: (line: string) => void,
): Promise<string | null> {
  const run = deps.run ?? defaultRun;
  const r = await run(cmd, [...args, '--version']);
  const firstLine = r.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  if (r.error) {
    log(`--version 探测失败: ${r.error}${r.stderr.trim() ? `（stderr: ${r.stderr.trim().slice(0, 200)}）` : ''}`);
    return null;
  }
  if (r.code !== 0) {
    log(`--version 退出码 ${r.code ?? 'null'}${r.stderr.trim() ? `（stderr: ${r.stderr.trim().slice(0, 200)}）` : ''}`);
    return firstLine; // 部分 CLI 非零退出但仍打印版本——尽量保留
  }
  log(`--version → ${firstLine ?? '(无输出)'}`);
  return firstLine;
}

/** 内置 catalog 条目完整探测（安装 + 版本 + 认证） */
export async function probeEntry(
  entry: AgentCatalogEntry,
  deps: ProbeDeps & { overrides?: Record<string, string> },
): Promise<DetectedAgent> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => appendProbeLog(entry.id, line));
  log(`开始探测 ${entry.displayName}（${entry.executable}）`);
  const resolution = resolveExecutable(entry, deps);
  let version: string | null = null;
  let authenticated: boolean | null = null;
  if (resolution.installed && resolution.resolvedPath) {
    version = await probeVersion(resolution.resolvedPath, [], deps, log);
    const auth = probeAuth(entry, deps);
    authenticated = auth.authenticated;
    log(`认证启发式：${auth.authenticated ? '已认证' : '未认证'}（${auth.evidence}）`);
  }
  return {
    id: entry.id,
    displayName: entry.displayName,
    executable: entry.executable,
    installed: resolution.installed,
    resolvedPath: resolution.resolvedPath,
    driverAvailable: entry.driverAvailable,
    version,
    authenticated,
    capabilities: entry.capabilities,
    installCommand: entry.installCommand,
    homepage: entry.homepage,
    overridePath: resolution.via === 'override' ? resolution.resolvedPath : null,
    probedAt: now(),
    source: 'builtin',
  };
}

// ── 自定义路径修复（catalog override 持久化） ───────────────────────────────

function overridesFile(dataDir: string): string {
  return join(dataDir, 'agent-overrides.json');
}

export function readOverrides(dataDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(overridesFile(dataDir), 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      );
    }
  } catch {
    // 文件不存在/损坏：视为无 override
  }
  return {};
}

export function writeOverrides(dataDir: string, overrides: Record<string, string>): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(overridesFile(dataDir), `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
}

/**
 * agent 启动时的可执行路径解析（services/agent.ts 调用点）：
 * 与探测同优先级——env 覆盖生效时返回 null（driver 自行解析 env 注入点），
 * 否则返回持久化 override（无则 null，driver 走 PATH 默认）。
 */
export function resolveLaunchExecutablePath(dataDir: string, agentId: string): string | null {
  const entry = AGENT_CATALOG.find((e) => e.id === agentId);
  if (!entry) return null;
  if (entry.envOverride) {
    const override = process.env[entry.envOverride];
    if (override && defaultIsExecutable(override)) return null;
  }
  const overrides = readOverrides(dataDir);
  const path = overrides[entry.executable];
  return path && defaultIsExecutable(path) ? path : null;
}

// ── 自定义 ACP agent 探测 ──────────────────────────────────────────────────

export interface CustomProbeSnapshot {
  ok: boolean;
  resolvedPath: string | null;
  version: string | null;
  error: string | null;
  at: number;
}

export function parseCustomProbe(row: Pick<CustomAgent, 'last_probe_json'>): CustomProbeSnapshot | null {
  if (!row.last_probe_json) return null;
  try {
    const v = JSON.parse(row.last_probe_json) as CustomProbeSnapshot;
    if (typeof v === 'object' && v !== null && typeof v.ok === 'boolean') return v;
  } catch {
    // 损坏：视为未探测
  }
  return null;
}

/** 自定义命令实时探测（注册/重验证调用点）；结果由调用方回写 last_probe_json */
export async function probeCustomCommand(
  spec: { id: string; command: string; args: string[] },
  deps: ProbeDeps = {},
): Promise<CustomProbeSnapshot> {
  const log = deps.log ?? ((line: string) => appendProbeLog(`custom:${spec.id}`, line));
  const env = deps.env ?? process.env;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const now = deps.now ?? Date.now;
  const cmd = spec.command.trim();
  log(`开始探测自定义 agent（${cmd}）`);

  let resolvedPath: string | null = null;
  if (isAbsolute(cmd)) {
    if (isExecutable(cmd)) {
      resolvedPath = cmd;
      log(`绝对路径可执行 ${cmd}`);
    } else {
      log(`绝对路径不可执行或不存在 ${cmd}`);
    }
  } else {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, cmd);
      if (isExecutable(candidate)) {
        resolvedPath = candidate;
        break;
      }
    }
    log(resolvedPath ? `PATH 探测命中 ${resolvedPath}` : `PATH 未找到命令 ${cmd}`);
  }

  if (!resolvedPath) {
    return {
      ok: false,
      resolvedPath: null,
      version: null,
      error: `命令不可执行：${cmd}（请检查绝对路径或 PATH 安装）`,
      at: now(),
    };
  }
  const version = await probeVersion(resolvedPath, spec.args, deps, log);
  return { ok: true, resolvedPath, version, error: null, at: now() };
}

/** 实时探测并回写 custom_agents.last_probe_json（create/reprobe/agents:refresh 共用） */
export async function probeAndRecordCustomAgent(
  db: Parameters<typeof customAgentRepo.updateLastProbe>[0],
  row: CustomAgent,
): Promise<CustomProbeSnapshot> {
  const snapshot = await probeCustomCommand({
    id: row.id,
    command: row.command,
    args: customAgentRepo.parseArgs(row),
  });
  customAgentRepo.updateLastProbe(db, row.id, JSON.stringify(snapshot));
  return snapshot;
}

/** 自定义行 + 探测快照 → 合并列表条目（agents:list 零 spawn 直读 DB 快照） */
export function customEntryFromRow(row: CustomAgent): DetectedAgent {
  const probe = parseCustomProbe(row);
  return {
    id: `custom:${row.id}`,
    displayName: row.name,
    executable: row.command,
    installed: probe?.ok === true,
    resolvedPath: probe?.resolvedPath ?? null,
    driverAvailable: true,
    version: probe?.version ?? null,
    authenticated: null, // 自定义 ACP agent 认证形态各异，无启发式（卡片不置灰）
    capabilities: CUSTOM_ACP_CAPABILITIES,
    installCommand: null,
    homepage: null,
    overridePath: null,
    probedAt: probe?.at ?? 0,
    source: 'custom',
  };
}

// ── IPC 注册 ───────────────────────────────────────────────────────────────

export default function register(ctx: ServiceContext): void {
  let builtinCache: DetectedAgent[] | null = null;

  const probeAllBuiltins = async (): Promise<DetectedAgent[]> => {
    const overrides = readOverrides(ctx.dataDir);
    return Promise.all(AGENT_CATALOG.map((e) => probeEntry(e, { overrides })));
  };

  /** 合并视图：内置缓存 + 自定义 DB 快照（每次调用现读 DB，零 spawn） */
  const mergedList = (): DetectedAgent[] => [
    ...(builtinCache ?? []),
    ...customAgentRepo.list(ctx.db).map(customEntryFromRow),
  ];

  /** 探测结果（首调实测，之后走缓存；自定义 agent 读 DB 快照） */
  ctx.ipcMain.handle('agents:list', async () => {
    builtinCache ??= await probeAllBuiltins();
    return mergedList();
  });

  /** 手动刷新：内置全量重测 + 自定义逐个实时重探测（回写 last_probe_json） */
  ctx.ipcMain.handle('agents:refresh', async () => {
    builtinCache = await probeAllBuiltins();
    for (const row of customAgentRepo.list(ctx.db)) {
      await probeAndRecordCustomAgent(ctx.db, row);
    }
    return mergedList();
  });

  // ── ticket #26（additive）：路径修复 / 恢复自动探测 / 探测日志 ────────────

  /** 自定义路径修复：绝对路径 + 可执行校验 → 持久化 override → 重测该 agent */
  ctx.ipcMain.handle('agents:set-override-path', async (_e, agentId: unknown, path: unknown) => {
    const entry = AGENT_CATALOG.find((en) => en.id === agentId);
    if (!entry) throw new Error(`未知 agent: ${String(agentId)}`);
    if (typeof path !== 'string' || !isAbsolute(path.trim())) {
      throw new Error('需要可执行文件的绝对路径');
    }
    const target = path.trim();
    appendProbeLog(entry.id, `路径修复：验证 ${target}`);
    if (!defaultIsExecutable(target)) {
      appendProbeLog(entry.id, `路径修复失败：${target} 不存在或不可执行`);
      throw new Error(`路径不可用：${target} 不存在或不可执行`);
    }
    const overrides = readOverrides(ctx.dataDir);
    overrides[entry.executable] = target;
    writeOverrides(ctx.dataDir, overrides);
    const probed = await probeEntry(entry, { overrides });
    if (builtinCache) {
      builtinCache = builtinCache.map((a) => (a.id === entry.id ? probed : a));
      if (!builtinCache.some((a) => a.id === entry.id)) builtinCache.push(probed);
    } else {
      builtinCache = await probeAllBuiltins();
    }
    appendProbeLog(entry.id, `路径修复成功：${target}`);
    return mergedList();
  });

  /** 恢复自动探测：移除 override 并重测 */
  ctx.ipcMain.handle('agents:clear-override', async (_e, agentId: unknown) => {
    const entry = AGENT_CATALOG.find((en) => en.id === agentId);
    if (!entry) throw new Error(`未知 agent: ${String(agentId)}`);
    const overrides = readOverrides(ctx.dataDir);
    delete overrides[entry.executable];
    writeOverrides(ctx.dataDir, overrides);
    appendProbeLog(entry.id, '已移除自定义路径，恢复自动探测');
    const probed = await probeEntry(entry, { overrides });
    if (builtinCache) {
      builtinCache = builtinCache.map((a) => (a.id === entry.id ? probed : a));
      if (!builtinCache.some((a) => a.id === entry.id)) builtinCache.push(probed);
    } else {
      builtinCache = await probeAllBuiltins();
    }
    return mergedList();
  });

  /** 探测日志（设置页折叠区；key = agentId 或 custom:<dbId>） */
  ctx.ipcMain.handle('agents:probe-log', () => getProbeLogs());
}
