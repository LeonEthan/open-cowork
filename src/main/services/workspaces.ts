import { dialog } from 'electron';
import * as workspaceRepo from '../db/workspaceRepo';
import type { ServiceContext } from './index';

/**
 * workspaces 服务（ticket #18）：本地目录 workspace 的增删查。
 * 添加走原生目录选择 dialog（'workspaces:pick-and-add'）；
 * 'workspaces:add-by-path' 供 e2e/自动化与后续票据（如命令行传入）直给路径用。
 */
export default function register(ctx: ServiceContext): void {
  ctx.ipcMain.handle('workspaces:list', () => workspaceRepo.list(ctx.db));

  ctx.ipcMain.handle('workspaces:pick-and-add', async () => {
    const win = ctx.getMainWindow();
    const options = {
      title: '选择 workspace 目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return workspaceRepo.add(ctx.db, result.filePaths[0]);
  });

  ctx.ipcMain.handle('workspaces:add-by-path', (_event, dirPath: unknown) => {
    if (typeof dirPath !== 'string' || dirPath.trim().length === 0) {
      throw new Error('workspaces:add-by-path 需要一个非空目录路径');
    }
    return workspaceRepo.add(ctx.db, dirPath);
  });

  ctx.ipcMain.handle('workspaces:remove', (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('workspaces:remove 需要 workspace id');
    }
    workspaceRepo.remove(ctx.db, id);
  });
}
