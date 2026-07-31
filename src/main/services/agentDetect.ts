import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ServiceContext } from './index';

/**
 * agent 探测服务（ticket #22，最小版）：内置四家 agent catalog + PATH 探测，
 * 供会话 picker 列「已安装可选 / 未安装置灰 / 即将支持」。
 * #26 会做完整卡片/修复/日志——本票只做探测与 picker 数据源。
 *
 * 探测规则：
 * - env 覆盖优先（OPEN_COWORK_*_CLI，与 driver 的 executablePath 注入点同源）：
 *   指向存在且可执行的文件即视为已安装（e2e/排障经此注入 fake CLI）；
 * - 否则按 PATH 逐目录找可执行文件（accessSync X_OK）；
 * - 结果带缓存；agents:refresh 强制重测（手动刷新 IPC）。
 *
 * driverAvailable 静态维护：四家内置 driver 均已接入（claude #19 / codex+opencode #22 / pi #23）。
 */

export interface AgentCatalogEntry {
  id: string;
  displayName: string;
  executable: string;
  envOverride: string | null;
  driverAvailable: boolean;
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    executable: 'claude',
    envOverride: 'OPEN_COWORK_CLAUDE_CLI',
    driverAvailable: true,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    executable: 'codex',
    envOverride: 'OPEN_COWORK_CODEX_CLI',
    driverAvailable: true,
  },
  {
    id: 'opencode',
    displayName: 'opencode',
    executable: 'opencode',
    envOverride: 'OPEN_COWORK_OPENCODE_CLI',
    driverAvailable: true,
  },
  {
    id: 'pi',
    displayName: 'pi',
    executable: 'pi',
    envOverride: 'OPEN_COWORK_PI_CLI', // #23：与 pi driver 的 executablePath 注入点同源
    driverAvailable: true, // #23：pi driver 已接入（降级审批，静态策略兜底）
  },
];

export interface DetectedAgent {
  id: string;
  displayName: string;
  executable: string;
  installed: boolean;
  resolvedPath: string | null;
  driverAvailable: boolean;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probeEntry(entry: AgentCatalogEntry): DetectedAgent {
  if (entry.envOverride) {
    const override = process.env[entry.envOverride];
    if (override && isExecutable(override)) {
      return { ...pickShape(entry), installed: true, resolvedPath: override };
    }
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, entry.executable);
    if (isExecutable(candidate)) {
      return { ...pickShape(entry), installed: true, resolvedPath: candidate };
    }
  }
  return { ...pickShape(entry), installed: false, resolvedPath: null };
}

function pickShape(entry: AgentCatalogEntry): Omit<DetectedAgent, 'installed' | 'resolvedPath'> {
  return {
    id: entry.id,
    displayName: entry.displayName,
    executable: entry.executable,
    driverAvailable: entry.driverAvailable,
  };
}

export default function register(ctx: ServiceContext): void {
  let cache: DetectedAgent[] | null = null;
  const probeAll = (): DetectedAgent[] => AGENT_CATALOG.map(probeEntry);

  /** 探测结果（首调实测，之后走缓存） */
  ctx.ipcMain.handle('agents:list', () => {
    cache ??= probeAll();
    return cache;
  });

  /** 手动刷新：重测并更新缓存 */
  ctx.ipcMain.handle('agents:refresh', () => {
    cache = probeAll();
    return cache;
  });
}
