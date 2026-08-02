import { dialog } from 'electron';
import * as workspaceRepo from '../db/workspaceRepo';
import { currentBranch } from '../worktree/worktree';
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

  // Codex 对齐（additive）：workspace 当前 git 分支——
  // 非 git 目录 / git 命令失败一律 { isGitRepo: false, branch: null }（不抛错）；
  // detached HEAD 时 branch 为短 SHA。纯逻辑见 worktree/worktree.ts currentBranch。
  ctx.ipcMain.handle('workspaces:current-branch', (event, id: unknown) => {
    const win = ctx.getMainWindow();
    if (!win || event.sender !== win.webContents) {
      throw new Error('workspaces:current-branch 来源非法');
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('workspaces:current-branch 需要 workspace id');
    }
    const ws = workspaceRepo.getById(ctx.db, id);
    if (!ws) throw new Error(`workspace 不存在: ${id}`);
    return currentBranch(ws.path);
  });
}
