import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { captureRootFor, prepareTaskCapture } from '../src/main/changes/capture';
import { openDatabase } from '../src/main/db/database';
import type { Database as Db } from '../src/main/db/database';
import type { Task } from '../src/main/db/entities';
import * as taskRepo from '../src/main/db/taskRepo';
import * as workspaceRepo from '../src/main/db/workspaceRepo';
import {
  backflow,
  cleanupWorktree,
  createTaskWorktree,
  currentBranch,
  workspaceWorktreeInfo,
  worktreeBranch,
  worktreePathFor,
  worktreeStatus,
} from '../src/main/worktree/worktree';
import type { GitExec } from '../src/main/worktree/worktree';

/**
 * worktree 隔离与回流（ticket #25 全 vitest）：
 * 临时目录建真 git 仓 + 内存库 + 独立 dataDir——
 * 创建（pin base / 集中目录 / 分支逃生舱 / 失败回滚）→ 隔离运行（原目录零改动）→
 * 回流（git apply 未提交形态：status 有改动、log/index 不变）→ 漂移阻断与强制路径 →
 * apply 冲突逃生舱文案 → 手动清理（磁盘回收 + 分支保留/可选删 + 回退 workspace.path）。
 */

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function initGitRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commitAll(dir: string, msg: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

function gitLogCount(dir: string): number {
  return git(dir, ['log', '--oneline']).trim().split('\n').filter(Boolean).length;
}

/** index（暂存区）是否干净——回流不得 git add 的红线断言 */
function indexClean(dir: string): boolean {
  try {
    git(dir, ['diff', '--cached', '--quiet']);
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  db: Db;
  dataDir: string;
  root: string;
  task: Task;
}

/** 内存库 + workspace 指向 root + worktree opt-in 任务（ready 态） */
function setup(root: string, opts: { useWorktree?: boolean } = {}): Fixture {
  const dataDir = tmp('oc25-data-');
  const db = openDatabase(':memory:');
  const ws = workspaceRepo.add(db, root);
  const task = taskRepo.create(db, {
    workspaceId: ws.id,
    prompt: 'worktree 任务',
    agentType: 'claude-code',
    useWorktree: opts.useWorktree ?? true,
  });
  return { db, dataDir, root, task };
}

/** git workspace 打底：两文件一提交 */
function makeGitWorkspace(): string {
  const root = tmp('oc25-ws-');
  initGitRepo(root);
  writeFileSync(join(root, 'mod.txt'), 'old\n');
  writeFileSync(join(root, 'del.txt'), 'bye\n');
  commitAll(root, 'base');
  return root;
}

// ── 创建 ──────────────────────────────────────────────────────────────────

describe('worktree 创建', () => {
  it('集中目录 + cowork 分支落位，pin base SHA，任务行写 worktree_path', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const baseSha = git(root, ['rev-parse', 'HEAD']).trim();

    const created = createTaskWorktree(db, dataDir, task.id);
    expect(created.baseSha).toBe(baseSha);
    expect(created.branch).toBe(worktreeBranch(task.id));
    expect(created.path).toBe(worktreePathFor(dataDir, task.id));

    // 目录/分支/HEAD 落位
    expect(existsSync(join(created.path, 'mod.txt'))).toBe(true);
    expect(git(created.path, ['rev-parse', 'HEAD']).trim()).toBe(baseSha);
    expect(git(root, ['branch', '--list', worktreeBranch(task.id)])).toContain(
      worktreeBranch(task.id),
    );
    expect(git(root, ['worktree', 'list', '--porcelain'])).toContain(created.path);

    // 任务行：worktree_path + base_sha 落库
    const row = taskRepo.getById(db, task.id)!;
    expect(row.use_worktree).toBe(1);
    expect(row.worktree_path).toBe(created.path);
    expect(row.base_sha).toBe(baseSha);

    // 捕获根解析切到 worktree（agent cwd/diff/终端三处同一模式）
    expect(captureRootFor(db, row)).toBe(created.path);
  });

  it('幂等：已建任务重复创建返回现状，不重跑 git worktree add', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const first = createTaskWorktree(db, dataDir, task.id);
    const second = createTaskWorktree(db, dataDir, task.id);
    expect(second).toEqual(first);
  });

  it('非 git workspace 拒绝；无提交的仓库拒绝（无法 pin base）', () => {
    // 非 git
    const plain = tmp('oc25-plain-');
    const f1 = setup(plain);
    expect(() => createTaskWorktree(f1.db, f1.dataDir, f1.task.id)).toThrow(/仅 git workspace/);
    expect(workspaceWorktreeInfo(f1.db, f1.task.workspace_id)).toEqual({
      isGitRepo: false,
      hasCommits: false,
    });

    // git 但无提交
    const empty = tmp('oc25-empty-');
    initGitRepo(empty);
    const f2 = setup(empty);
    expect(() => createTaskWorktree(f2.db, f2.dataDir, f2.task.id)).toThrow(/尚无提交/);
    expect(workspaceWorktreeInfo(f2.db, f2.task.workspace_id)).toEqual({
      isGitRepo: true,
      hasCommits: false,
    });

    // 失败无副作用：任务行无 worktree_path/base_sha，集中目录与分支不留
    expect(taskRepo.getById(f2.db, f2.task.id)?.worktree_path).toBeNull();
    expect(taskRepo.getById(f2.db, f2.task.id)?.base_sha).toBeNull();
    expect(existsSync(worktreePathFor(f2.dataDir, f2.task.id))).toBe(false);
    expect(git(empty, ['branch', '--list', worktreeBranch(f2.task.id)]).trim()).toBe('');
  });

  it('未勾选 worktree 的任务不可创建（use_worktree=0）', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root, { useWorktree: false });
    expect(task.use_worktree).toBe(0);
    expect(() => createTaskWorktree(db, dataDir, task.id)).toThrow(/未启用 worktree/);
  });
});

// ── 隔离运行：原目录零改动 ────────────────────────────────────────────────

describe('隔离运行', () => {
  it('worktree 内写入不触及原目录（工作区与 index 全程干净）', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const { path: wt } = createTaskWorktree(db, dataDir, task.id);

    // 模拟 agent 在 worktree 内工作（agent cwd = worktree_path）
    writeFileSync(join(wt, 'mod.txt'), 'old\npatched\n');
    mkdirSync(join(wt, 'fresh'), { recursive: true });
    writeFileSync(join(wt, 'fresh', 'new.txt'), 'brand new\n');
    rmSync(join(wt, 'del.txt'));

    // 原目录零改动：文件内容、git status、log、index 全部原样
    expect(readFileSync(join(root, 'mod.txt'), 'utf8')).toBe('old\n');
    expect(existsSync(join(root, 'fresh'))).toBe(false);
    expect(git(root, ['status', '--porcelain'])).toBe('');
    expect(gitLogCount(root)).toBe(1);
    expect(indexClean(root)).toBe(true);
  });
});

// ── 回流 ──────────────────────────────────────────────────────────────────

describe('回流（Codex 式 git apply）', () => {
  it('改动落回原目录为未提交形态：status 有改动、log/index 不变、HEAD 不变', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const baseSha = git(root, ['rev-parse', 'HEAD']).trim();
    const { path: wt } = createTaskWorktree(db, dataDir, task.id);

    // worktree 内：改 tracked + 新增 untracked（含子目录）+ 删 tracked + 二进制新增
    writeFileSync(join(wt, 'mod.txt'), 'old\npatched line\n');
    mkdirSync(join(wt, 'fresh'), { recursive: true });
    writeFileSync(join(wt, 'fresh', 'new.txt'), 'brand new\n');
    rmSync(join(wt, 'del.txt'));
    writeFileSync(join(wt, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const result = backflow(db, task.id);
    expect(result.files).toBe(4);

    // 工作区状态断言（票面 AC）：改动以未提交形态落回原目录
    expect(readFileSync(join(root, 'mod.txt'), 'utf8')).toBe('old\npatched line\n');
    expect(readFileSync(join(root, 'fresh', 'new.txt'), 'utf8')).toBe('brand new\n');
    expect(existsSync(join(root, 'del.txt'))).toBe(false);
    expect(readFileSync(join(root, 'bin.dat'))).toEqual(Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const status = git(root, ['status', '--porcelain']);
    expect(status).toContain(' M mod.txt');
    expect(status).toContain(' D del.txt');
    expect(status).toContain('?? bin.dat');
    expect(status).toContain('?? fresh/');

    // 不自动 commit / 不碰 index / HEAD 不动（红线）
    expect(gitLogCount(root)).toBe(1);
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(baseSha);
    expect(indexClean(root)).toBe(true);

    // 回流不改任务行（worktree 保留，可继续迭代/再清理）
    const row = taskRepo.getById(db, task.id)!;
    expect(row.worktree_path).toBe(wt);
    expect(row.base_sha).toBe(baseSha);
  });

  it('worktree 无改动：files=0 幂等成功，原目录全程干净', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    createTaskWorktree(db, dataDir, task.id);
    expect(backflow(db, task.id)).toEqual({ files: 0 });
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });

  it('重复回流：同一 delta 二次 apply 失败 → 逃生舱文案（worktree/分支保留）', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const { path: wt, branch } = createTaskWorktree(db, dataDir, task.id);
    writeFileSync(join(wt, 'mod.txt'), 'old\npatched\n');

    backflow(db, task.id);
    // 二次回流：worktree 改动仍在（相对 base），但原目录已是 patched 态 → apply 冲突
    expect(() => backflow(db, task.id)).toThrow(/回流失败/);
    try {
      backflow(db, task.id);
      expect.unreachable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain(branch); // 逃生舱分支名
      expect(msg).toContain(wt); // worktree 目录
      expect(msg).toContain('逃生舱');
    }
    // worktree 原样保留（目录 + 分支 + 改动）
    expect(readFileSync(join(wt, 'mod.txt'), 'utf8')).toBe('old\npatched\n');
    expect(git(root, ['branch', '--list', branch])).toContain(branch);
  });

  it('与原目录现有未提交改动冲突：apply 失败且原目录不被写脏', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const { path: wt } = createTaskWorktree(db, dataDir, task.id);
    writeFileSync(join(wt, 'mod.txt'), 'old\nfrom worktree\n');

    // 原目录用户自己改了同一文件（未提交）
    writeFileSync(join(root, 'mod.txt'), 'old\nuser local edit\n');

    expect(() => backflow(db, task.id)).toThrow(/回流失败/);
    // git apply 原子失败：原目录保持用户现场，不被写脏
    expect(readFileSync(join(root, 'mod.txt'), 'utf8')).toBe('old\nuser local edit\n');
    expect(existsSync(wt)).toBe(true); // 逃生舱保留
  });
});

// ── base 漂移 ─────────────────────────────────────────────────────────────

describe('base 漂移', () => {
  it('原仓新提交 → status 报漂移；自动回流阻断；force 强制路径成功', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const { path: wt } = createTaskWorktree(db, dataDir, task.id);
    writeFileSync(join(wt, 'mod.txt'), 'old\npatched\n');

    // 任务创建后原仓前进一次提交（漂移）
    writeFileSync(join(root, 'upstream.txt'), 'upstream\n');
    commitAll(root, 'upstream work');
    const newHead = git(root, ['rev-parse', 'HEAD']).trim();

    const st = worktreeStatus(db, task.id);
    expect(st.enabled).toBe(true);
    expect(st.drifted).toBe(true);
    expect(st.headSha).toBe(newHead);
    expect(st.baseSha).not.toBe(newHead);

    // 阻断：报错含漂移提示
    expect(() => backflow(db, task.id)).toThrow(/漂移/);
    expect(readFileSync(join(root, 'mod.txt'), 'utf8')).toBe('old\n'); // 未回流

    // 漂移后 prepareTaskCapture 不炸（capture 根=worktree，pin 已存在不重 pin）
    expect(() => prepareTaskCapture(db, task.id, dataDir)).not.toThrow();
    expect(taskRepo.getById(db, task.id)?.base_sha).toBe(st.baseSha);

    // 用户确认后强制回流：patch 相对 pin 的 base 生成，落在漂移后的 HEAD 上
    const res = backflow(db, task.id, { force: true });
    expect(res.files).toBe(1);
    expect(readFileSync(join(root, 'mod.txt'), 'utf8')).toBe('old\npatched\n');
    expect(gitLogCount(root)).toBe(2); // 仍无自动 commit
    expect(indexClean(root)).toBe(true);
  });

  it('漂移且内容冲突：force 也可能失败 → 逃生舱指引', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const { path: wt } = createTaskWorktree(db, dataDir, task.id);
    writeFileSync(join(wt, 'mod.txt'), 'old\nworktree version\n');

    // 漂移提交恰好改了同一文件同一区域
    writeFileSync(join(root, 'mod.txt'), 'old\nupstream version\n');
    commitAll(root, 'conflicting upstream');

    expect(() => backflow(db, task.id)).toThrow(/漂移/);
    expect(() => backflow(db, task.id, { force: true })).toThrow(/回流失败/);
    // 逃生舱：worktree 原样、原目录保持 upstream 提交内容
    expect(readFileSync(join(wt, 'mod.txt'), 'utf8')).toBe('old\nworktree version\n');
    expect(readFileSync(join(root, 'mod.txt'), 'utf8')).toBe('old\nupstream version\n');
  });
});

// ── 手动清理 ──────────────────────────────────────────────────────────────

describe('手动清理', () => {
  it('worktree remove + 集中目录删除 + 分支保留（逃生舱）+ 任务行置空回退', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const { path: wt, branch } = createTaskWorktree(db, dataDir, task.id);
    writeFileSync(join(wt, 'mod.txt'), 'dirty\n'); // 有未提交改动也可强制清理

    cleanupWorktree(db, dataDir, task.id);

    // 磁盘回收：目录删除、git 登记移除
    expect(existsSync(wt)).toBe(false);
    expect(git(root, ['worktree', 'list', '--porcelain'])).not.toContain(wt);
    // 分支默认保留（逃生舱）
    expect(git(root, ['branch', '--list', branch]).trim()).toBe(branch);
    // 任务行置空 → 三处 ?? 回退自动生效（此处断言捕获根回退 workspace.path）
    const row = taskRepo.getById(db, task.id)!;
    expect(row.worktree_path).toBeNull();
    expect(row.use_worktree).toBe(1); // 历史勾选保留
    expect(captureRootFor(db, row)).toBe(root);
    // 状态 DTO：path=null、不再漂移
    const st = worktreeStatus(db, task.id);
    expect(st.path).toBeNull();
    expect(st.drifted).toBe(false);

    // 幂等：重复清理安全
    expect(cleanupWorktree(db, dataDir, task.id)).toEqual({ ok: true });
  });

  it('deleteBranch=true：连分支一起删', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const { branch } = createTaskWorktree(db, dataDir, task.id);
    cleanupWorktree(db, dataDir, task.id, { deleteBranch: true });
    expect(git(root, ['branch', '--list', branch]).trim()).toBe('');
  });

  it('目录被外部删除：清理照常收尾（prune + 任务行置空）', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    const { path: wt } = createTaskWorktree(db, dataDir, task.id);
    rmSync(wt, { recursive: true, force: true }); // 用户手动 rm -rf

    expect(worktreeStatus(db, task.id).exists).toBe(false);
    expect(cleanupWorktree(db, dataDir, task.id)).toEqual({ ok: true });
    expect(git(root, ['worktree', 'list', '--porcelain'])).not.toContain(wt);
    expect(taskRepo.getById(db, task.id)?.worktree_path).toBeNull();
  });

  it('清理后不可回流；非 worktree 任务回流/清理的守卫', () => {
    const root = makeGitWorkspace();
    const { db, dataDir, task } = setup(root);
    createTaskWorktree(db, dataDir, task.id);
    cleanupWorktree(db, dataDir, task.id);
    expect(() => backflow(db, task.id)).toThrow(/已清理/);

    const plain = setup(root, { useWorktree: false });
    expect(() => backflow(plain.db, plain.task.id)).toThrow(/未启用 worktree/);
    expect(cleanupWorktree(plain.db, plain.dataDir, plain.task.id)).toEqual({ ok: true });
  });
});

// Codex 对齐（additive）：workspaces:current-branch 的纯逻辑——注入 exec，不碰真 git
describe('currentBranch（注入 exec 的纯逻辑）', () => {
  /** 按 args 首元素分发的假 git；未命中抛错模拟命令失败 */
  const fakeGit = (out: Partial<Record<'rev-parse' | 'symbolic-ref', string>>): GitExec => {
    return (_cwd, args) => {
      const key = args[0] as 'rev-parse' | 'symbolic-ref';
      const v = out[key];
      if (v === undefined) throw new Error(`fatal: ${args.join(' ')}`);
      return v;
    };
  };

  it('正常分支：symbolic-ref 命中返回分支名', () => {
    expect(
      currentBranch('/repo', fakeGit({ 'rev-parse': 'true\n', 'symbolic-ref': 'main\n' })),
    ).toEqual({ isGitRepo: true, branch: 'main' });
  });

  it('非 git 目录：rev-parse 非 true → isGitRepo=false', () => {
    expect(currentBranch('/tmp', fakeGit({ 'rev-parse': 'false\n' }))).toEqual({
      isGitRepo: false,
      branch: null,
    });
  });

  it('git 命令失败一律不抛：返回 isGitRepo=false', () => {
    expect(currentBranch('/nowhere', fakeGit({}))).toEqual({ isGitRepo: false, branch: null });
  });

  it('detached HEAD：symbolic-ref 失败 → branch 给短 SHA', () => {
    // rev-parse 需同时应答 --is-inside-work-tree 与 --short HEAD
    const exec: GitExec = (_cwd, args) => {
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return 'true\n';
      if (args[0] === 'rev-parse' && args.includes('--short')) return 'abc1234\n';
      throw new Error('fatal: ref HEAD is not a symbolic ref');
    };
    expect(currentBranch('/repo', exec)).toEqual({ isGitRepo: true, branch: 'abc1234' });
  });

  it('真 git 冒烟：临时仓在 main 分支；普通目录非 git', () => {
    const root = makeGitWorkspace();
    expect(currentBranch(root)).toEqual({ isGitRepo: true, branch: 'main' });
    expect(currentBranch(tmp('oc-nonrepo-'))).toEqual({ isGitRepo: false, branch: null });
  });
});
