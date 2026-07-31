import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapturedChange } from '../db/fileChangesRepo';
import { countDiffLines, createUnifiedDiff, isBinaryBuffer } from './diff';

/**
 * git 原生捕获（ticket #24 / ARCHITECTURE §7）：
 * `git status --porcelain` 枚举工作区相对 base 的变更，`git diff <base>` 取 diff 文本，
 * untracked 文件读内容自合成 unified diff——统一归一为 CapturedChange。
 *
 * 红线（票面 + 编排者附注 2）：本模块只读 git——
 * 永不 `git add` / `git commit` / `git checkout`（测试断言 git log 与 index 不变）。
 *
 * 约定：
 * - 路径一律相对捕获根（cwd，= worktree_path ?? workspace.path），posix 分隔；
 *   workspace 是 repo 子目录时 `--relative`/`-- .` 保证口径一致（`git show` 需库根相对路径，
 *   由 review.ts 用 `rev-parse --show-prefix` 换算）；
 * - staged rename 不产 'renamed'：拆为 deleted(旧) + added(新)，与工作区未暂存时的
 *   实际形态一致（快照兜底同此口径）；FileChangeType.renamed 保留给未来；
 * - 无提交的库（rev-parse HEAD 失败，baseSha=null）：一切皆按新增处理（内容自合成）。
 */

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** cwd 是否在 git 工作树内（子目录也算；repo 不存在/git 不可用 → false） */
export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/** 当前 HEAD SHA；无提交（空库）或出错 → null */
export function revParseHead(cwd: string): string | null {
  try {
    const sha = git(cwd, ['rev-parse', 'HEAD']).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

interface StatusEntry {
  /** 索引侧状态（' ' 表示无） */
  x: string;
  /** 工作树侧状态 */
  y: string;
  /** 新路径（rename 时为 to） */
  path: string;
  /** rename/copy 的原路径（-z 模式下跟随在新路径后）；非 rename 为 null */
  oldPath: string | null;
}

/** `git status --porcelain=v1 -z` 解析（-z 不转义，rename 记录为新\0旧两段） */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const parts = out.split('\0').filter((p) => p.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    const x = rec[0];
    const y = rec[1];
    const path = rec.slice(3);
    let oldPath: string | null = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = parts[i + 1] ?? null;
      i++;
    }
    entries.push({ x, y, path, oldPath });
  }
  return entries;
}

/** untracked / staged 新增：从磁盘读内容自合成 diff（二进制 → diff null） */
function addedFromDisk(cwd: string, path: string): CapturedChange | null {
  const abs = join(cwd, path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null; // 捕获窗口内被删（与 status 竞态）：跳过
  }
  if (!st.isFile() && !st.isSymbolicLink()) return null; // FIFO/socket 等不读（防阻塞）
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return { path, changeType: 'added', diff: null, added: null, removed: null };
  }
  if (isBinaryBuffer(buf)) {
    return { path, changeType: 'added', diff: null, added: null, removed: null };
  }
  const d = createUnifiedDiff(path, null, buf.toString('utf8'));
  return { path, changeType: 'added', diff: d.text, added: d.added, removed: d.removed };
}

/** tracked 变更：`git diff <base> -- <path>` 取文本（二进制 → diff null） */
function diffViaGit(
  cwd: string,
  baseSha: string,
  path: string,
  changeType: CapturedChange['changeType'],
): CapturedChange {
  const raw = git(cwd, ['diff', '--no-color', '--no-ext-diff', '--relative', baseSha, '--', path]);
  if (raw.includes('Binary files') || raw.includes('GIT binary patch')) {
    return { path, changeType, diff: null, added: null, removed: null };
  }
  const { added, removed } = countDiffLines(raw);
  // 纯 mode 变更等无 hunk 的 diff 保留文本（added/removed=0）；完全空输出置 null
  return { path, changeType, diff: raw.length > 0 ? raw : null, added, removed };
}

/**
 * 捕获「工作区 vs base」的全量 delta。
 * baseSha 为 null（空库）时一切皆新增；tracked 的 M/D 不可能存在。
 */
export function captureGitChanges(cwd: string, baseSha: string | null): CapturedChange[] {
  const status = git(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all', // 展开未跟踪目录内的每个文件（normal 会折叠成「dir/」无法逐文件归一）
    '--',
    '.',
  ]);
  const out: CapturedChange[] = [];
  for (const e of parsePorcelainZ(status)) {
    if (e.oldPath !== null) {
      // staged rename：拆 删旧 + 增新（不自产 renamed，见头注释）
      if (baseSha !== null) out.push(diffViaGit(cwd, baseSha, e.oldPath, 'deleted'));
      const added = addedFromDisk(cwd, e.path);
      if (added) out.push(added);
      continue;
    }
    if (e.x === '?' || e.y === '?' || baseSha === null) {
      const added = addedFromDisk(cwd, e.path);
      if (added) out.push(added);
      continue;
    }
    const changeType =
      e.x === 'D' || e.y === 'D' ? 'deleted' : e.x === 'A' ? 'added' : 'modified';
    out.push(diffViaGit(cwd, baseSha, e.path, changeType));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 回滚用：取 base 版本的文件内容（Buffer 保二进制）。
 * 路径为捕获根相对；库根相对路径经 show-prefix 换算（workspace 为 repo 子目录时非空）。
 */
export function readBaseFile(cwd: string, baseSha: string, relPath: string): Buffer {
  const prefix = git(cwd, ['rev-parse', '--show-prefix']).trim();
  return execFileSync('git', ['-C', cwd, 'show', `${baseSha}:${prefix}${relPath}`], {
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
