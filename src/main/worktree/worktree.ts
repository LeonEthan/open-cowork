import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isGitRepo, revParseHead } from '../changes/git';
import type { Database } from '../db/database';
import * as fileChangesRepo from '../db/fileChangesRepo';
import * as taskRepo from '../db/taskRepo';
import * as workspaceRepo from '../db/workspaceRepo';

/**
 * per-task worktree 隔离与回流（ticket #25 / ARCHITECTURE §8，决策票 #11 Codex 式设计）。
 *
 * ── 布局 ──
 *   <dataDir>/worktrees/<taskId>/   worktree 集中存放（DATA_SUBDIRS 已含 worktrees/）
 *   分支 cowork/<taskId>            逃生舱：回流失败/清理后仍可在原仓找到该分支
 *   tasks.worktree_path             集中目录绝对路径（清理后置 NULL → 各处自动回退 workspace.path）
 *   tasks.base_sha                  创建时 pin 的 base SHA（与 #24 捕获基准同列同语义）
 *
 * ── 创建 ──
 * git worktree add <path> -b cowork/<taskId> <baseSha>（--detach 不用：分支即逃生舱）。
 * 仅 git 且已有提交的 workspace 可建；失败时目录/分支回滚干净（调用方决定任务行去留）。
 *
 * ── 回流 ──
 * worktree 内 `git diff --binary <base>`（先 `git add -N .` 让 untracked 进入 diff——
 * 注意：add -N 只动 worktree 自己的 index，worktree 是 app 托管的草稿区，不碰原仓
 * index/提交的红线不受影响；原仓侧全程只跑只读命令 + 最后的 `git apply`）→
 * 原目录 `git apply`（纯工作区写入，不加 --index：落为未提交形态）。
 * base 漂移（原仓 HEAD ≠ tasks.base_sha）阻断自动回流，force=true 为用户确认后的强制路径。
 * apply 失败：worktree 目录与 cowork/<taskId> 分支原样保留，错误文案给出手动补救指引。
 *
 * ── 清理 ──
 * git worktree remove --force + 兜底删集中目录 + 可选删分支（默认保留逃生舱）+
 * tasks.worktree_path 置 NULL（终端/diff 捕获/agent cwd 三处 ?? 回退自动生效）。
 * 全部操作幂等：目录已被外部删掉、清理重复调用均安全。
 */

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** worktree 分支名（cowork/ 前缀为本应用托管命名空间，回流失败/清理默认保留） */
export function worktreeBranch(taskId: string): string {
  return `cowork/${taskId}`;
}

/** worktree 集中目录（<dataDir>/worktrees/<taskId>） */
export function worktreePathFor(dataDir: string, taskId: string): string {
  return join(dataDir, 'worktrees', taskId);
}

/** 只读/写 git 命令统一入口（同步；失败带 stderr 抛错） */
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** 容错 git（清理路径用：失败不抛，返回是否成功） */
function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function mustTask(db: Database, taskId: string) {
  const task = taskRepo.getById(db, taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  return task;
}

function mustWorkspacePath(db: Database, workspaceId: string): string {
  const ws = workspaceRepo.getById(db, workspaceId);
  if (!ws) throw new Error(`workspace 不存在: ${workspaceId}`);
  return ws.path;
}

/** workspace 的 worktree 可用性（创建表单勾选框启用依据） */
export function workspaceWorktreeInfo(
  db: Database,
  workspaceId: string,
): { isGitRepo: boolean; hasCommits: boolean } {
  const path = mustWorkspacePath(db, workspaceId);
  const gitRepo = isGitRepo(path);
  return { isGitRepo: gitRepo, hasCommits: gitRepo ? revParseHead(path) !== null : false };
}

/**
 * 创建 worktree 并 pin base SHA（任务入库后由 tasks 服务调用；幂等——
 * worktree_path 已落库且目录仍在时直接返回现状）。
 * 失败：目录与分支回滚干净后抛错（调用方负责任务行的回滚）。
 */
export function createTaskWorktree(
  db: Database,
  dataDir: string,
  taskId: string,
): { path: string; branch: string; baseSha: string } {
  const task = mustTask(db, taskId);
  if (task.use_worktree !== 1) throw new Error(`任务未启用 worktree 隔离: ${taskId}`);
  const wsPath = mustWorkspacePath(db, task.workspace_id);
  const branch = worktreeBranch(taskId);
  const wtPath = worktreePathFor(dataDir, taskId);

  // 幂等：已建且目录仍在（如重试/重启后重入）
  if (task.worktree_path && existsSync(task.worktree_path) && task.base_sha) {
    return { path: task.worktree_path, branch, baseSha: task.base_sha };
  }

  if (!isGitRepo(wsPath)) {
    throw new Error('仅 git workspace 支持 worktree 隔离（该目录不在 git 工作树内）');
  }
  const baseSha = revParseHead(wsPath);
  if (!baseSha) {
    throw new Error('仓库尚无提交，无法 pin base SHA——请先在 workspace 里完成首次提交');
  }

  mkdirSync(join(dataDir, 'worktrees'), { recursive: true });
  // 前次失败残留：集中目录与本应用托管分支一律先清（cowork/ 命名空间归本应用所有）
  rmSync(wtPath, { recursive: true, force: true });
  gitOk(wsPath, ['worktree', 'prune']);
  gitOk(wsPath, ['branch', '-D', branch]);

  try {
    git(wsPath, ['worktree', 'add', wtPath, '-b', branch, baseSha]);
  } catch (err) {
    // 回滚干净：目录 + 可能已建的分支都不留
    rmSync(wtPath, { recursive: true, force: true });
    gitOk(wsPath, ['worktree', 'prune']);
    gitOk(wsPath, ['branch', '-D', branch]);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`创建 worktree 失败（已回滚，原目录未受影响）：${detail}`);
  }

  taskRepo.setWorktreePath(db, taskId, wtPath);
  // base SHA 落 tasks.base_sha（与 #24 捕获基准同列；write-once 守卫，同值幂等）
  fileChangesRepo.setTaskBaseSha(db, taskId, baseSha);
  return { path: wtPath, branch, baseSha };
}

/** worktree 状态 DTO（检查栏「回流到原目录」区块的渲染基线） */
export interface WorktreeStatus {
  /** 任务创建时勾选了 worktree 隔离 */
  enabled: boolean;
  /** 集中目录绝对路径；已清理/从未建成 为 null */
  path: string | null;
  /** 目录当前是否在磁盘上（外部被删时为 false，清理可收尾） */
  exists: boolean;
  /** 逃生舱分支名（enabled 时恒有值） */
  branch: string | null;
  /** pin 的 base SHA */
  baseSha: string | null;
  /** 原仓当前 HEAD（worktree 活跃时探测） */
  headSha: string | null;
  /** base 漂移：原仓 HEAD 已离开 pin 的 base（阻断自动回流） */
  drifted: boolean;
}

export function worktreeStatus(db: Database, taskId: string): WorktreeStatus {
  const task = mustTask(db, taskId);
  const enabled = task.use_worktree === 1;
  const path = task.worktree_path;
  const exists = path !== null && existsSync(path);
  let headSha: string | null = null;
  if (enabled && path) {
    headSha = revParseHead(mustWorkspacePath(db, task.workspace_id));
  }
  return {
    enabled,
    path,
    exists,
    branch: enabled ? worktreeBranch(taskId) : null,
    baseSha: task.base_sha,
    headSha,
    drifted: enabled && path !== null && task.base_sha !== null && headSha !== null
      ? headSha !== task.base_sha
      : false,
  };
}

/**
 * 回流（Codex 式）：worktree 内「base → 工作区」全量 delta（含 untracked、二进制）
 * 打成 patch，原目录 git apply 落为未提交改动。
 *
 * - base 漂移：headSha ≠ baseSha 且 force=false → 抛错阻断（UI 提供强制路径）；
 * - apply 失败：worktree 目录与 cowork/<taskId> 分支保留作逃生舱，错误文案含补救指引；
 * - 幂等：worktree 无改动时 files=0 成功返回；回流本身不改 tasks/file_changes 任何行
 *   （改动落回原目录后，worktree 保持原样直至手动清理；复查决议语义不变）。
 *
 * 返回 files = patch 涉及的路径数（diff --git 段计数）。
 */
export function backflow(
  db: Database,
  taskId: string,
  opts: { force?: boolean } = {},
): { files: number } {
  const task = mustTask(db, taskId);
  if (task.use_worktree !== 1) throw new Error('该任务未启用 worktree 隔离');
  if (!task.worktree_path) throw new Error('worktree 已清理，无可回流内容');
  if (!existsSync(task.worktree_path)) {
    throw new Error(`worktree 目录不存在（可能已被外部删除）：${task.worktree_path}`);
  }
  if (!task.base_sha) throw new Error('缺 base SHA，无法界定回流范围');
  const wsPath = mustWorkspacePath(db, task.workspace_id);
  const branch = worktreeBranch(taskId);

  // base 漂移检测：原仓 HEAD 已离开 pin 的 base → 阻断自动回流（票面 AC）
  const headSha = revParseHead(wsPath);
  if (headSha !== task.base_sha && !opts.force) {
    throw new Error(
      `原仓 base 已漂移（任务 pin 的 base 为 ${task.base_sha.slice(0, 8)}，当前 HEAD 为 ` +
        `${headSha ? headSha.slice(0, 8) : '无提交'}）。自动回流已阻断——请先在原目录处理新提交` +
        `（拉齐/审阅），确认无误后用「我已处理，强制回流」。`,
    );
  }

  // worktree 内打包：add -N 让 untracked 进入 diff（只动 worktree 自身 index——
  // worktree 是 app 托管草稿区；原仓 index/commit 红线不受影响）
  const wt = task.worktree_path;
  try {
    git(wt, ['add', '-N', '.']);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`worktree 变更打包失败（未触碰原目录）：${detail}`);
  }
  const patch = git(wt, [
    'diff',
    '--binary',
    '--no-color',
    '--no-ext-diff',
    task.base_sha,
  ]);

  const files = (patch.match(/^diff --git /gm) ?? []).length;
  if (files === 0) return { files: 0 }; // 无改动：幂等成功

  // 原目录 apply：纯工作区写入（无 --index），落为未提交形态
  try {
    git(wsPath, ['apply', '--whitespace=nowarn', '-'], patch);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `回流失败：原目录 apply 未应用任何改动（通常是与原目录现有未提交改动冲突）。\n` +
        `全部改动原样保留在 worktree（逃生舱）：\n` +
        `  目录 ${wt}\n  分支 ${branch}\n` +
        `手动补救：进入该目录核对后提交并合并分支，或自行 git apply；处理好原目录后也可重试回流。\n` +
        `（git 报错：${detail}）`,
    );
  }
  return { files };
}

/**
 * 手动清理 worktree（磁盘回收）：git worktree remove --force → 兜底删集中目录 →
 * 可选删分支（默认保留 cowork/<taskId> 作逃生舱）→ tasks.worktree_path 置 NULL
 * （终端/diff 捕获/agent cwd 的 ?? 回退随之自动生效）。全程幂等。
 */
export function cleanupWorktree(
  db: Database,
  dataDir: string,
  taskId: string,
  opts: { deleteBranch?: boolean } = {},
): { ok: true } {
  const task = mustTask(db, taskId);
  // worktree_path 已被清空但任务曾 opt-in：按约定路径兜底探一遍（DB/磁盘不同步的残留也回收）
  const wtPath =
    task.worktree_path ?? (task.use_worktree === 1 ? worktreePathFor(dataDir, taskId) : null);
  if (wtPath === null) return { ok: true }; // 非 worktree 任务：幂等 no-op

  // workspace 行若还在（任务在则 workspace 必在）且仍是 git 仓：走正规移除 + prune
  const ws = workspaceRepo.getById(db, task.workspace_id);
  if (ws && isGitRepo(ws.path)) {
    if (wtPath && existsSync(wtPath)) {
      gitOk(ws.path, ['worktree', 'remove', '--force', wtPath]);
    }
    gitOk(ws.path, ['worktree', 'prune']);
    if (opts.deleteBranch) {
      gitOk(ws.path, ['branch', '-D', worktreeBranch(taskId)]);
    }
  }
  // 兜底：集中目录删除（git remove 失败/仓已非 git/外部残留都回收干净）
  if (wtPath) rmSync(wtPath, { recursive: true, force: true });
  taskRepo.setWorktreePath(db, taskId, null);
  return { ok: true };
}
