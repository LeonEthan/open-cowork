import type { IpcMain } from 'electron';
import type { Database } from '../db/database';
import type { BrowserWindow, UtilityProcess } from 'electron';
import type { ApprovalService } from '../approval/service';

export interface ServiceContext {
  ipcMain: IpcMain;
  /** 全局单一 SQLite（WAL + FTS5，迁移已在启动时执行完毕） */
  db: Database;
  /** 应用数据根目录（OPEN_COWORK_DATA_DIR 覆盖后的实际值） */
  dataDir: string;
  getMainWindow: () => BrowserWindow | null;
  getAgentProcess: () => UtilityProcess | null;
  /** ticket #20（additive）：审批回路中枢（pending 注册表 + 策略引擎接线） */
  approval: ApprovalService;
}

export type ServiceRegister = (ctx: ServiceContext) => void;

/**
 * ── 如何新增一个 main 进程服务（IPC handler）──
 * 1. 在本目录（src/main/services/）新建 <name>.ts；
 * 2. 默认导出一个函数：(ctx: ServiceContext) => void，函数内用 ctx.ipcMain.handle/on 注册通道；
 * 3. 完成。无需编辑本文件或任何其他文件——import.meta.glob 启动时自动聚合并调用。
 *
 * 约定：通道名用 '<域>:<动作>'（如 'tasks:create'）；写库一律经 ctx.db；
 * 审批链路相关服务必须 fail-closed（ARCHITECTURE §10）。
 */
const modules = import.meta.glob('./*.ts', { eager: true }) as Record<
  string,
  { default?: ServiceRegister }
>;

export function registerServices(ctx: ServiceContext): string[] {
  const registered: string[] = [];
  for (const [path, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    if (path === './index.ts') continue;
    if (typeof mod.default !== 'function') {
      console.warn(`[services] ${path} 缺少默认导出 (ctx) => void，已跳过`);
      continue;
    }
    mod.default(ctx);
    registered.push(path.replace(/^\.\//, '').replace(/\.ts$/, ''));
  }
  console.log(`[services] 已注册: ${registered.join(', ') || '(无)'}`);
  return registered;
}
