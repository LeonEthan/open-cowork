import * as conversationRepo from '../db/conversationRepo';
import * as taskRepo from '../db/taskRepo';
import { resolveContextWindow } from '../usage/pricing';
import type { ServiceContext } from './index';

/**
 * 用量服务（ticket #27）：任务 chip 聚合 / 轮次小字 reconcile / 水位环分母。
 *
 * 通道：
 * - usage:list            任务用量记录（recorded_at 升序，轮次小字 reconcile 用）；
 * - usage:totals          全任务聚合（侧栏 chip；聚合口径见 shared/usageFormat.ts）；
 * - usage:context         水位环分母 + 最新一轮已占 token（input+cacheRead）。
 *
 * 折算在落库时完成（agentEvents.ts 'usage' 分派），本服务只读不算。
 */
export default function register(ctx: ServiceContext): void {
  const senderAllowed = (event: Electron.IpcMainInvokeEvent): boolean => {
    const win = ctx.getMainWindow();
    return !!win && event.sender === win.webContents;
  };

  ctx.ipcMain.handle('usage:list', (event, taskId: unknown) => {
    if (!senderAllowed(event)) throw new Error('usage:list 来源非法');
    if (typeof taskId !== 'string') throw new Error('usage:list 需要任务 id');
    return conversationRepo.listUsageByTask(ctx.db, taskId);
  });

  ctx.ipcMain.handle('usage:totals', (event) => {
    if (!senderAllowed(event)) throw new Error('usage:totals 来源非法');
    return conversationRepo.usageTotalsByTask(ctx.db).map((r) => ({
      taskId: r.task_id,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      costUsd: r.cost_usd,
      hasPriced: r.priced_records > 0,
      hasSubscription: r.subscription_records > 0,
      records: r.records,
    }));
  });

  ctx.ipcMain.handle('usage:context', (event, taskId: unknown) => {
    if (!senderAllowed(event)) throw new Error('usage:context 来源非法');
    if (typeof taskId !== 'string') throw new Error('usage:context 需要任务 id');
    const task = taskRepo.getById(ctx.db, taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    const info = resolveContextWindow(ctx.db, task);
    // 已占口径：最新一轮的 input + cacheRead（claude 系 cacheRead 是 context 重放的大头）
    const latest = conversationRepo.listUsageByTask(ctx.db, taskId).at(-1) ?? null;
    const usedTokens = latest ? latest.input_tokens + latest.cache_read_tokens : 0;
    return { ...info, usedTokens };
  });
}
