import { execFileSync } from 'node:child_process';
import { currentBranch } from './worktree/worktree';
import type { GitExec } from './worktree/worktree';

/**
 * 检查栏「变更」tab 的 git 操作（ticket #39，Codex Environment 对齐）：
 * 分支行（workingSummary）/ Commit or push（commitAll + push）/ Compare branch（compareWithBase）。
 *
 * 全部函数 exec 可注入（GitExec 签名同 worktree.ts），vitest 不碰真 git。
 * cwd 由 services/git.ts 解析（任务 worktree_path ?? workspace.path），本模块不查库。
 *
 * 错误口径：git 失败统一剥 stderr 首行，抛面向用户可读的 Error（中文前缀 + 细节）。
 */

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** 默认 git 执行器（同步；失败带 stderr 抛错） */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** 剥 execFileSync 报错的 stderr 首行（面向用户可读，去掉堆栈与换行噪声） */
export function gitErrorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'stderr' in e) {
    const stderr: unknown = e.stderr;
    if (typeof stderr === 'string') {
      const first = stderr
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (first) return first;
    }
  }
  if (e instanceof Error && e.message.length > 0) return e.message.split('\n')[0];
  return fallback;
}

export interface WorkingSummary {
  isGitRepo: boolean;
  branch: string | null;
  /** 相对 upstream 领先/落后；无 upstream（或未配置追踪）时均为 null */
  ahead: number | null;
  behind: number | null;
}

/**
 * 分支行数据：分支名复用 currentBranch（detached HEAD 给短 SHA；非 git 不抛）。
 * ahead/behind 来自 `rev-list --left-right --count @{upstream}...HEAD`
 * （左 = upstream 独有 = behind，右 = HEAD 独有 = ahead）；无 upstream 时命令失败 → null/null。
 */
export function workingSummary(cwd: string, execGit: GitExec = git): WorkingSummary {
  const { isGitRepo, branch } = currentBranch(cwd, execGit);
  if (!isGitRepo) return { isGitRepo: false, branch: null, ahead: null, behind: null };
  let ahead: number | null = null;
  let behind: number | null = null;
  try {
    const out = execGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).trim();
    const m = out.match(/^(\d+)\s+(\d+)$/);
    if (m) {
      behind = Number(m[1]);
      ahead = Number(m[2]);
    }
  } catch {
    // 无 upstream / 追踪分支已删：保持 null（UI 不渲染箭头）
  }
  return { isGitRepo: true, branch, ahead, behind };
}

/**
 * 提交全部改动（git add -A + commit -m）。
 * 无改动 → throw Error('没有可提交的改动')；message trim 后为空 → throw。
 * 成功返回新提交 SHA（rev-parse HEAD）。
 */
export function commitAll(
  cwd: string,
  message: string,
  execGit: GitExec = git,
): { ok: true; sha: string } {
  const msg = message.trim();
  if (msg.length === 0) throw new Error('提交信息不能为空');
  let status = '';
  try {
    status = execGit(cwd, ['status', '--porcelain']).trim();
  } catch (e) {
    throw new Error(`检查工作区状态失败：${gitErrorMessage(e, 'git status 失败')}`);
  }
  if (status.length === 0) throw new Error('没有可提交的改动');
  try {
    execGit(cwd, ['add', '-A']);
    execGit(cwd, ['commit', '-m', msg]);
  } catch (e) {
    throw new Error(`提交失败：${gitErrorMessage(e, 'git commit 失败')}`);
  }
  try {
    const sha = execGit(cwd, ['rev-parse', 'HEAD']).trim();
    return { ok: true, sha };
  } catch (e) {
    // 提交已成功但取不到 SHA 属异常路径，仍按失败报（调用方会重拉状态自愈）
    throw new Error(`提交已完成但读取 SHA 失败：${gitErrorMessage(e, 'git rev-parse 失败')}`);
  }
}

/** 推送当前分支（git push -u origin HEAD）；失败抛 stderr 首行摘要 */
export function push(cwd: string, execGit: GitExec = git): { ok: true } {
  try {
    execGit(cwd, ['push', '-u', 'origin', 'HEAD']);
    return { ok: true };
  } catch (e) {
    throw new Error(`推送失败：${gitErrorMessage(e, 'git push 失败')}`);
  }
}

export type CompareFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface CompareFile {
  path: string;
  status: CompareFileStatus;
}

export interface CompareWithBaseResult {
  supported: boolean;
  /** base 短 SHA（展示用） */
  baseLabel: string | null;
  files: CompareFile[];
  insertions: number;
  deletions: number;
}

/** `git diff --name-status <base>` 解析（R 记录取新路径标 renamed） */
export function parseNameStatus(out: string): CompareFile[] {
  const files: CompareFile[] = [];
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const code = parts[0]?.trim() ?? '';
    if (code.startsWith('R') && parts.length >= 3) {
      files.push({ path: parts[2], status: 'renamed' });
    } else if (code === 'A' && parts.length >= 2) {
      files.push({ path: parts[1], status: 'added' });
    } else if (code === 'M' && parts.length >= 2) {
      files.push({ path: parts[1], status: 'modified' });
    } else if (code === 'D' && parts.length >= 2) {
      files.push({ path: parts[1], status: 'deleted' });
    } else if (code.startsWith('C') && parts.length >= 3) {
      // copy 少见，按 added（新路径）呈现
      files.push({ path: parts[2], status: 'added' });
    }
    // 其它状态码（T/U/X 等）不在 diff-base 常规输出里，忽略
  }
  return files;
}

/** `git diff --shortstat <base>` 解析（「 N files changed, X insertions(+), Y deletions(-)」各段可缺省） */
export function parseShortStat(out: string): { insertions: number; deletions: number } {
  const ins = out.match(/(\d+)\s+insertion/);
  const del = out.match(/(\d+)\s+deletion/);
  return {
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/**
 * 与 base 对比（worktree 任务）：工作区现状（含未提交）vs baseSha。
 * - files：`git diff --name-status <base>`（tracked 的 M/D/R/A）+
 *   `git ls-files --others --exclude-standard`（untracked 一律标 added）；
 * - insertions/deletions：`git diff --shortstat <base>`——口径只含 tracked 内容改动，
 *   untracked 文件计入 files 列表但不计入 +/- 统计（其内容未进 index，diff 看不到）。
 * supported 的判定在 services 层（worktree 任务且有 base_sha），本函数假定二者已成立。
 */
export function compareWithBase(
  cwd: string,
  baseSha: string,
  execGit: GitExec = git,
): CompareWithBaseResult {
  let nameStatus = '';
  let shortStat = '';
  let untracked = '';
  let baseLabel: string;
  try {
    baseLabel = execGit(cwd, ['rev-parse', '--short', baseSha]).trim();
  } catch {
    baseLabel = baseSha.slice(0, 7); // 短 SHA 取不到就截断原值，不阻断对比
  }
  try {
    nameStatus = execGit(cwd, ['diff', '--name-status', baseSha]);
    shortStat = execGit(cwd, ['diff', '--shortstat', baseSha]);
    untracked = execGit(cwd, ['ls-files', '--others', '--exclude-standard']);
  } catch (e) {
    throw new Error(`对比 base 失败：${gitErrorMessage(e, 'git diff 失败')}`);
  }
  const files = parseNameStatus(nameStatus);
  for (const line of untracked.split('\n')) {
    const p = line.trim();
    if (p.length > 0) files.push({ path: p, status: 'added' });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const { insertions, deletions } = parseShortStat(shortStat);
  return { supported: true, baseLabel, files, insertions, deletions };
}
