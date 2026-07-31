import * as conversationRepo from '../db/conversationRepo';
import * as taskRepo from '../db/taskRepo';
import * as workspaceRepo from '../db/workspaceRepo';
import { prepareTaskCapture } from '../changes/capture';
import type { ServiceContext } from './index';

/**
 * agent 服务（ticket #19）：renderer 发起的会话控制（start/followup/cancel）
 * 与历史重拉。控制面走 main（状态机唯一权威），高频事件流不走这里——
 * utility → renderer 由 MessageChannel 直连（services/system.ts 接线）。
 *
 * 时序约定：状态迁移 + 用户消息落库 + Turn 创建完成后才把指令转发给 utility，
 * 保证「用户消息在前、agent 事件在后」的持久化顺序。
 * 取消/失败在任何活跃态可达（状态机把关）；全部迁移经 taskRepo.updateStatus。
 */
export default function register(ctx: ServiceContext): void {
  const broadcast = (): void => {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('tasks:changed');
  };

  const senderAllowed = (event: Electron.IpcMainInvokeEvent): boolean => {
    const win = ctx.getMainWindow();
    return !!win && event.sender === win.webContents;
  };

  const resolveCwd = (taskId: string): string => {
    const task = taskRepo.getById(ctx.db, taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.worktree_path) return task.worktree_path;
    const ws = workspaceRepo.getById(ctx.db, task.workspace_id);
    if (!ws) throw new Error(`workspace 不存在: ${task.workspace_id}`);
    return ws.path;
  };

  const postToAgent = (msg: unknown): void => {
    const agent = ctx.getAgentProcess();
    if (!agent) throw new Error('agent 适配层未就绪');
    agent.postMessage(msg);
  };

  /** 启动首轮（ready → running）：用任务创建时的需求描述开跑 */
  ctx.ipcMain.handle('agent:start', (event, taskId: unknown) => {
    if (!senderAllowed(event)) throw new Error('agent:start 来源非法');
    if (typeof taskId !== 'string') throw new Error('agent:start 需要任务 id');
    const task = taskRepo.getById(ctx.db, taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'ready') {
      throw new Error(`仅就绪状态可启动（当前 ${task.status}）`);
    }
    const cwd = resolveCwd(taskId);

    // #24：任务开始 pin 变更捕获基准（git base SHA / 非 git 快照，幂等）——必须先于 agent 开跑
    prepareTaskCapture(ctx.db, taskId, ctx.dataDir);

    taskRepo.updateStatus(ctx.db, taskId, 'running');
    const turn = conversationRepo.createTurn(ctx.db, taskId);
    conversationRepo.insertMessage(ctx.db, {
      taskId,
      turnId: turn.id,
      role: 'user',
      kind: 'text',
      content: task.prompt,
      seq: conversationRepo.nextSeq(ctx.db, taskId),
    });

    postToAgent({
      type: 'agent-command',
      command: {
        kind: 'start',
        taskId,
        agentType: task.agent_type,
        prompt: task.prompt,
        cwd,
        model: task.model,
        // env：#21 provider 密钥注入点（本票无 provider 配置，缺省）
      },
    });
    broadcast();
    return { ok: true as const };
  });

  /** 追问（awaiting_review → running）：同一会话内开新一轮 */
  ctx.ipcMain.handle('agent:followup', (event, taskId: unknown, text: unknown) => {
    if (!senderAllowed(event)) throw new Error('agent:followup 来源非法');
    if (typeof taskId !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('agent:followup 需要 { taskId, text }');
    }
    const task = taskRepo.getById(ctx.db, taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'awaiting_review') {
      throw new Error(`仅待复查状态可追问（当前 ${task.status}）`);
    }

    // #24：追问轮不重 pin 基准（幂等调用：git 已 pin / 快照已建即跳过）
    prepareTaskCapture(ctx.db, taskId, ctx.dataDir);

    taskRepo.updateStatus(ctx.db, taskId, 'running');
    const turn = conversationRepo.createTurn(ctx.db, taskId);
    conversationRepo.insertMessage(ctx.db, {
      taskId,
      turnId: turn.id,
      role: 'user',
      kind: 'text',
      content: text.trim(),
      seq: conversationRepo.nextSeq(ctx.db, taskId),
    });

    postToAgent({
      type: 'agent-command',
      command: { kind: 'followup', taskId, text: text.trim() },
    });
    broadcast();
    return { ok: true as const };
  });

  /** 取消（任何活跃态 → cancelled）：utility 侧终止进程；Turn 立即关单 */
  ctx.ipcMain.handle('agent:cancel', (event, taskId: unknown) => {
    if (!senderAllowed(event)) throw new Error('agent:cancel 来源非法');
    if (typeof taskId !== 'string') throw new Error('agent:cancel 需要任务 id');
    const task = taskRepo.getById(ctx.db, taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    // updateStatus 经状态机把关：done/cancelled 终态会抛错（IPC 层原样拒绝）
    taskRepo.updateStatus(ctx.db, taskId, 'cancelled');
    const turn = conversationRepo.getRunningTurn(ctx.db, taskId);
    if (turn) conversationRepo.closeTurn(ctx.db, turn.id, 'cancelled');
    // utility 无此会话时静默 no-op（如重启后的残留 running）
    postToAgent({ type: 'agent-command', command: { kind: 'cancel', taskId } });
    broadcast();
    return { ok: true as const };
  });

  /** 历史重拉：renderer 选中任务时的渲染基线（实时端口负责增量） */
  ctx.ipcMain.handle('agent:history', (event, taskId: unknown) => {
    if (!senderAllowed(event)) throw new Error('agent:history 来源非法');
    if (typeof taskId !== 'string') throw new Error('agent:history 需要任务 id');
    return conversationRepo.listHistory(ctx.db, taskId);
  });
}
