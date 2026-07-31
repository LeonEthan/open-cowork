import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { captureTaskChanges, prepareTaskCapture, baselineDir, rollbackBackupDir } from '../src/main/changes/capture';
import {
  acceptAll,
  acceptChange,
  restoreChange,
  rollbackAll,
  rollbackChange,
} from '../src/main/changes/review';
import { openDatabase } from '../src/main/db/database';
import type { Database as Db } from '../src/main/db/database';
import type { Task } from '../src/main/db/entities';
import * as fileChangesRepo from '../src/main/db/fileChangesRepo';
import { runMigrations } from '../src/main/db/migrate';
import m001 from '../src/main/db/migrations/001_initial';
import * as taskRepo from '../src/main/db/taskRepo';
import * as workspaceRepo from '../src/main/db/workspaceRepo';

/**
 * diff 复查与回滚（ticket #24 seam 2 全 vitest）：
 * 临时目录建真 git 仓（init/commit/modify/untracked）断言 FileChange 归一 +
 * 回滚/恢复往返 + 无自动 commit/index 不变断言 + 非 git 快照全同款 +
 * pending supersede / accepted 复用 + 任务级整体操作经状态机。
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
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commitAll(dir: string, msg: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

function gitLogCount(dir: string): number {
  try {
    return git(dir, ['log', '--oneline']).trim().split('\n').filter(Boolean).length;
  } catch {
    return 0; // 无提交的库：git log 非零退出
  }
}

/** index（暂存区）是否干净——永不 git add 的红线断言 */
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

/** 内存库 + workspace 指向 root + 任务置 running（模拟 agent:start 的状态迁移） */
function setup(root: string): Fixture {
  const dataDir = tmp('oc-data-');
  const db = openDatabase(':memory:');
  const ws = workspaceRepo.add(db, root);
  const task = taskRepo.create(db, {
    workspaceId: ws.id,
    prompt: '改文件',
    agentType: 'claude-code',
  });
  taskRepo.updateStatus(db, task.id, 'running');
  return { db, dataDir, root, task };
}

function paths(rows: { path: string }[]): string[] {
  return rows.map((r) => r.path);
}

// ── git 捕获归一 ──────────────────────────────────────────────────────────

describe('git 捕获（真 git 仓）', () => {
  it('任务开始 pin base SHA；turn_end 后归一 modified/added/deleted/二进制', () => {
    const root = tmp('oc-git-');
    initGitRepo(root);
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    writeFileSync(join(root, 'mod.txt'), 'old\n');
    writeFileSync(join(root, 'del.txt'), 'bye\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'nested.txt'), 'nested\n');
    commitAll(root, 'base');

    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);

    const headSha = git(root, ['rev-parse', 'HEAD']).trim();
    expect(taskRepo.getById(db, task.id)?.base_sha).toBe(headSha);

    // agent 工作：修改 / 新增（含子目录）/ 删除 / 二进制
    writeFileSync(join(root, 'mod.txt'), 'old\nnew line\n');
    writeFileSync(join(root, 'untracked.txt'), 'hello\nworld\n');
    writeFileSync(join(root, 'sub', 'new-nested.txt'), 'nn\n');
    rmSync(join(root, 'del.txt'));
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const rows = captureTaskChanges(db, task.id, dataDir);
    expect(paths(rows)).toEqual([
      'bin.dat',
      'del.txt',
      'mod.txt',
      'sub/new-nested.txt',
      'untracked.txt',
    ]);
    const byPath = new Map(rows.map((r) => [r.path, r]));

    const mod = byPath.get('mod.txt');
    expect(mod?.change_type).toBe('modified');
    expect(mod?.added).toBe(1);
    expect(mod?.removed).toBe(0);
    expect(mod?.diff).toContain('--- a/mod.txt');
    expect(mod?.diff).toContain('+++ b/mod.txt');
    expect(mod?.diff).toContain('+new line');
    expect(mod?.diff).toContain(' old'); // 上下文行

    const untracked = byPath.get('untracked.txt');
    expect(untracked?.change_type).toBe('added');
    expect(untracked?.added).toBe(2);
    expect(untracked?.diff).toContain('--- /dev/null');
    expect(untracked?.diff).toContain('+hello');

    const del = byPath.get('del.txt');
    expect(del?.change_type).toBe('deleted');
    expect(del?.removed).toBe(1);
    expect(del?.diff).toContain('-bye');

    const bin = byPath.get('bin.dat');
    expect(bin?.change_type).toBe('added');
    expect(bin?.diff).toBeNull();
    expect(bin?.added).toBeNull();

    // 归一元数据：source/base_sha/capture_round/status
    for (const r of rows) {
      expect(r.source).toBe('git');
      expect(r.base_sha).toBe(headSha);
      expect(r.capture_round).toBe(1);
      expect(r.status).toBe('pending');
    }
    // keep.txt 与未变更的 sub/nested.txt 不入列
    expect(paths(rows)).not.toContain('keep.txt');
    expect(paths(rows)).not.toContain('sub/nested.txt');

    // 无自动 commit / index 不变（红线）
    expect(gitLogCount(root)).toBe(1);
    expect(indexClean(root)).toBe(true);
  });

  it('prepare 幂等：重复调用不覆盖 base SHA；改 pin 值被拒绝', () => {
    const root = tmp('oc-git-');
    initGitRepo(root);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    commitAll(root, 'base');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    const sha = taskRepo.getById(db, task.id)?.base_sha;
    prepareTaskCapture(db, task.id, dataDir); // 二次调用（追问轮同款）
    expect(taskRepo.getById(db, task.id)?.base_sha).toBe(sha);
    expect(() => fileChangesRepo.setTaskBaseSha(db, task.id, 'f'.repeat(40))).toThrow(/已 pin/);
  });

  it('无提交的库：一切皆新增（内容自合成 diff）', () => {
    const root = tmp('oc-git-');
    initGitRepo(root);
    writeFileSync(join(root, 'fresh.txt'), 'brand\n');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    expect(taskRepo.getById(db, task.id)?.base_sha).toBeNull();
    const rows = captureTaskChanges(db, task.id, dataDir);
    expect(paths(rows)).toEqual(['fresh.txt']);
    expect(rows[0].change_type).toBe('added');
    expect(rows[0].base_sha).toBeNull();
    expect(rows[0].diff).toContain('+brand');
    expect(gitLogCount(root)).toBe(0);
  });
});

// ── git 回滚/恢复往返 ─────────────────────────────────────────────────────

describe('git 回滚与恢复', () => {
  it('modified/added/deleted 三型往返 + 备份落位 + 无 commit', () => {
    const root = tmp('oc-git-');
    initGitRepo(root);
    writeFileSync(join(root, 'mod.txt'), 'old\n');
    writeFileSync(join(root, 'del.txt'), 'bye\n');
    commitAll(root, 'base');

    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    writeFileSync(join(root, 'mod.txt'), 'old\npatched\n');
    writeFileSync(join(root, 'added.txt'), 'new stuff\n');
    rmSync(join(root, 'del.txt'));

    const rows = captureTaskChanges(db, task.id, dataDir);
    const byPath = new Map(rows.map((r) => [r.path, r]));

    // modified 回滚 → 内容还原 → 恢复 → 改动回来
    rollbackChange(db, dataDir, byPath.get('mod.txt')!.id);
    expect(readFileSync(join(root, 'mod.txt'), 'utf8')).toBe('old\n');
    let row = fileChangesRepo.getById(db, byPath.get('mod.txt')!.id)!;
    expect(row.status).toBe('reverted');
    expect(row.snapshot_path).not.toBeNull();
    expect(readFileSync(row.snapshot_path!, 'utf8')).toBe('old\npatched\n');
    restoreChange(db, dataDir, row.id);
    expect(readFileSync(join(root, 'mod.txt'), 'utf8')).toBe('old\npatched\n');
    expect(fileChangesRepo.getById(db, row.id)?.status).toBe('pending');

    // added 回滚 → 文件消失 → 恢复 → 文件回来
    rollbackChange(db, dataDir, byPath.get('added.txt')!.id);
    expect(existsSync(join(root, 'added.txt'))).toBe(false);
    restoreChange(db, dataDir, byPath.get('added.txt')!.id);
    expect(readFileSync(join(root, 'added.txt'), 'utf8')).toBe('new stuff\n');

    // deleted 回滚 → 文件从 base 还原；恢复 → 再删除（回滚前不存在，snapshot_path=null）
    rollbackChange(db, dataDir, byPath.get('del.txt')!.id);
    expect(readFileSync(join(root, 'del.txt'), 'utf8')).toBe('bye\n');
    row = fileChangesRepo.getById(db, byPath.get('del.txt')!.id)!;
    expect(row.status).toBe('reverted');
    expect(row.snapshot_path).toBeNull();
    restoreChange(db, dataDir, row.id);
    expect(existsSync(join(root, 'del.txt'))).toBe(false);

    // 再回滚一次（备份槽覆盖语义）仍可恢复
    rollbackChange(db, dataDir, byPath.get('added.txt')!.id);
    restoreChange(db, dataDir, byPath.get('added.txt')!.id);
    expect(readFileSync(join(root, 'added.txt'), 'utf8')).toBe('new stuff\n');

    // 全程：无自动 commit，index 始终干净
    expect(gitLogCount(root)).toBe(1);
    expect(indexClean(root)).toBe(true);
  });

  it('子目录新增文件回滚后空目录被清理', () => {
    const root = tmp('oc-git-');
    initGitRepo(root);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    commitAll(root, 'base');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    mkdirSync(join(root, 'fresh'), { recursive: true });
    writeFileSync(join(root, 'fresh', 'n.txt'), 'n\n');
    const rows = captureTaskChanges(db, task.id, dataDir);
    expect(paths(rows)).toEqual(['fresh/n.txt']);
    rollbackChange(db, dataDir, rows[0].id);
    expect(existsSync(join(root, 'fresh'))).toBe(false);
    restoreChange(db, dataDir, rows[0].id);
    expect(readFileSync(join(root, 'fresh', 'n.txt'), 'utf8')).toBe('n\n');
  });

  it('决议状态守卫：非 pending 不可回滚/接受，非 reverted 不可恢复', () => {
    const root = tmp('oc-git-');
    initGitRepo(root);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    commitAll(root, 'base');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    writeFileSync(join(root, 'a.txt'), 'a2\n');
    const rows = captureTaskChanges(db, task.id, dataDir);
    const id = rows[0].id;
    acceptChange(db, id);
    expect(() => rollbackChange(db, dataDir, id)).toThrow(/仅待复查/);
    expect(() => restoreChange(db, dataDir, id)).toThrow(/仅已回滚/);
    expect(() => acceptChange(db, id)).toThrow(/仅待复查/);
  });
});

// ── pending supersede / accepted 复用 ─────────────────────────────────────

describe('多轮捕获语义（追问后重捕）', () => {
  it('pending 行 supersede；accepted 同 diff 不重复入列，diff 变化重新入列', () => {
    const root = tmp('oc-git-');
    initGitRepo(root);
    writeFileSync(join(root, 'a.txt'), 'a1\n');
    writeFileSync(join(root, 'b.txt'), 'b1\n');
    commitAll(root, 'base');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);

    // 轮 1：a、b 各改一处
    writeFileSync(join(root, 'a.txt'), 'a1\na2\n');
    writeFileSync(join(root, 'b.txt'), 'b1\nb2\n');
    const r1 = captureTaskChanges(db, task.id, dataDir);
    expect(paths(r1)).toEqual(['a.txt', 'b.txt']);
    expect(r1[0].capture_round).toBe(1);

    // 接受 a（工作区不动）；轮 2 前 b 再改
    acceptChange(db, r1.find((r) => r.path === 'a.txt')!.id);
    writeFileSync(join(root, 'b.txt'), 'b1\nb2\nb3\n');
    const r2 = captureTaskChanges(db, task.id, dataDir);
    // a 的 delta 未变且已 accepted → 不重复入列；b diff 变了 → 新 pending
    expect(paths(r2)).toEqual(['b.txt']);
    expect(r2[0].capture_round).toBe(2);
    const all = fileChangesRepo.listByTask(db, task.id);
    expect(all.filter((r) => r.path === 'a.txt')).toHaveLength(1); // accepted 历史保留
    expect(all.filter((r) => r.path === 'b.txt' && r.status === 'pending')).toHaveLength(1);

    // 轮 3：b 保持不动 → pending supersede（旧 pending 被同内容新行替换，不堆积）
    const r3 = captureTaskChanges(db, task.id, dataDir);
    expect(paths(r3)).toEqual(['b.txt']);
    expect(r3[0].capture_round).toBe(3);
    expect(
      fileChangesRepo.listByTask(db, task.id).filter((r) => r.status === 'pending'),
    ).toHaveLength(1);
  });
});

// ── 非 git 快照兜底（全同款） ──────────────────────────────────────────────

describe('非 git 快照兜底', () => {
  it('baseline 快照（排除 node_modules）+ 捕获归一 + 回滚/恢复往返', () => {
    const root = tmp('oc-ng-');
    writeFileSync(join(root, 'a.txt'), 'a1\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'b.txt'), 'b1\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.js'), 'x\n');

    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);

    // baseline 落位且遵循忽略规则
    expect(readFileSync(join(baselineDir(dataDir, task.id), 'a.txt'), 'utf8')).toBe('a1\n');
    expect(existsSync(join(baselineDir(dataDir, task.id), 'node_modules'))).toBe(false);
    expect(taskRepo.getById(db, task.id)?.base_sha).toBeNull(); // 非 git 不 pin

    // agent 工作
    writeFileSync(join(root, 'a.txt'), 'a1\na2\n');
    writeFileSync(join(root, 'c.txt'), 'see\n');
    rmSync(join(root, 'sub', 'b.txt'));
    writeFileSync(join(root, 'node_modules', 'pkg', 'y.js'), 'y\n'); // 忽略目录内变更不捕获
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x47]));

    const rows = captureTaskChanges(db, task.id, dataDir);
    expect(paths(rows)).toEqual(['a.txt', 'bin.dat', 'c.txt', 'sub/b.txt']);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get('a.txt')?.change_type).toBe('modified');
    expect(byPath.get('a.txt')?.diff).toContain('+a2');
    expect(byPath.get('a.txt')?.added).toBe(1);
    expect(byPath.get('c.txt')?.change_type).toBe('added');
    expect(byPath.get('sub/b.txt')?.change_type).toBe('deleted');
    expect(byPath.get('sub/b.txt')?.diff).toContain('-b1');
    expect(byPath.get('bin.dat')?.diff).toBeNull();
    for (const r of rows) {
      expect(r.source).toBe('snapshot');
      expect(r.base_sha).toBeNull();
    }

    // 回滚/恢复往返（与 git 同款断言）
    rollbackChange(db, dataDir, byPath.get('a.txt')!.id);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a1\n');
    restoreChange(db, dataDir, byPath.get('a.txt')!.id);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a1\na2\n');

    rollbackChange(db, dataDir, byPath.get('c.txt')!.id);
    expect(existsSync(join(root, 'c.txt'))).toBe(false);
    restoreChange(db, dataDir, byPath.get('c.txt')!.id);
    expect(readFileSync(join(root, 'c.txt'), 'utf8')).toBe('see\n');

    rollbackChange(db, dataDir, byPath.get('sub/b.txt')!.id);
    expect(readFileSync(join(root, 'sub', 'b.txt'), 'utf8')).toBe('b1\n');
    restoreChange(db, dataDir, byPath.get('sub/b.txt')!.id);
    expect(existsSync(join(root, 'sub', 'b.txt'))).toBe(false);

    // baseline 不被回滚污染
    expect(readFileSync(join(baselineDir(dataDir, task.id), 'a.txt'), 'utf8')).toBe('a1\n');
  });

  it('空工作区起步：baseline 空目录落位，agent 新增文件照常捕获', () => {
    const root = tmp('oc-ng-'); // 完全空的非 git workspace
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    // baseline 目录即使空也必须存在（否则捕获时补建会把现场当基准）
    expect(existsSync(baselineDir(dataDir, task.id))).toBe(true);
    writeFileSync(join(root, 'notes.md'), '# hi\n');
    const rows = captureTaskChanges(db, task.id, dataDir);
    expect(paths(rows)).toEqual(['notes.md']);
    expect(rows[0].change_type).toBe('added');
  });

  it('重复 prepare 不覆盖首轮 baseline', () => {
    const root = tmp('oc-ng-');
    writeFileSync(join(root, 'a.txt'), 'first\n');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    writeFileSync(join(root, 'a.txt'), 'second\n');
    prepareTaskCapture(db, task.id, dataDir); // 追问轮同款幂等
    expect(readFileSync(join(baselineDir(dataDir, task.id), 'a.txt'), 'utf8')).toBe('first\n');
  });
});

// ── 任务级整体操作（状态机接线） ────────────────────────────────────────────

describe('任务级整体操作', () => {
  it('全部接受：pending → accepted，awaiting_review → done（经状态机）', () => {
    const root = tmp('oc-ng-');
    writeFileSync(join(root, 'a.txt'), 'a1\n');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    writeFileSync(join(root, 'a.txt'), 'a1\na2\n');
    writeFileSync(join(root, 'b.txt'), 'b\n');
    captureTaskChanges(db, task.id, dataDir);
    taskRepo.updateStatus(db, task.id, 'awaiting_review');

    acceptAll(db, task.id);
    expect(taskRepo.getById(db, task.id)?.status).toBe('done');
    const rows = fileChangesRepo.listByTask(db, task.id);
    expect(rows.every((r) => r.status === 'accepted')).toBe(true);
    // 接受不改工作区
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a1\na2\n');
  });

  it('全部回滚：逐文件还原 + → done；非 awaiting_review 拒绝', () => {
    const root = tmp('oc-ng-');
    writeFileSync(join(root, 'a.txt'), 'a1\n');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    writeFileSync(join(root, 'a.txt'), 'a1\na2\n');
    writeFileSync(join(root, 'b.txt'), 'b\n');
    captureTaskChanges(db, task.id, dataDir);
    taskRepo.updateStatus(db, task.id, 'awaiting_review');

    rollbackAll(db, dataDir, task.id);
    expect(taskRepo.getById(db, task.id)?.status).toBe('done');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    const rows = fileChangesRepo.listByTask(db, task.id);
    expect(rows.every((r) => r.status === 'reverted')).toBe(true);
    // 备份已落 rollback-backup（done 后仍可恢复——快照期保留）
    expect(
      readFileSync(join(rollbackBackupDir(dataDir, task.id), 'b.txt'), 'utf8'),
    ).toBe('b\n');
    restoreChange(db, dataDir, rows.find((r) => r.path === 'b.txt')!.id);
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b\n');

    // done 后再做任务级操作：状态机拒绝
    expect(() => acceptAll(db, task.id)).toThrow(/非法任务状态迁移/);
  });
});

// ── turn_end → 捕获挂钩（agentEvents 接线） ────────────────────────────────

describe('turn_end 捕获挂钩', () => {
  it('completed 触发捕获并入 awaiting_review；failed 不触发；挂钩抛错不阻塞迁移', async () => {
    const { createAgentEventDispatcher } = await import('../src/main/agentEvents');
    const root = tmp('oc-ng-');
    writeFileSync(join(root, 'a.txt'), 'a1\n');
    const { db, dataDir, task } = setup(root);
    prepareTaskCapture(db, task.id, dataDir);
    writeFileSync(join(root, 'a.txt'), 'a1\na2\n');

    let captured = 0;
    const dispatch = createAgentEventDispatcher({
      db,
      broadcastTasksChanged: () => {},
      onTurnEndCompleted: (taskId) => {
        captured += 1;
        captureTaskChanges(db, taskId, dataDir);
      },
    });
    dispatch(task.id, { type: 'turn_end', status: 'completed' });
    expect(captured).toBe(1);
    expect(taskRepo.getById(db, task.id)?.status).toBe('awaiting_review');
    expect(paths(fileChangesRepo.listByTask(db, task.id))).toEqual(['a.txt']);

    // 追问 → failed 轮：不触发捕获
    taskRepo.updateStatus(db, task.id, 'running');
    dispatch(task.id, { type: 'turn_end', status: 'failed', reason: 'x' });
    expect(captured).toBe(1);
    expect(taskRepo.getById(db, task.id)?.status).toBe('failed');

    // 挂钩抛错：状态机照常迁移（捕获失败 ≠ 轮次失败）
    taskRepo.updateStatus(db, task.id, 'ready');
    taskRepo.updateStatus(db, task.id, 'running');
    const dispatchThrow = createAgentEventDispatcher({
      db,
      broadcastTasksChanged: () => {},
      onTurnEndCompleted: () => {
        throw new Error('捕获炸了');
      },
    });
    dispatchThrow(task.id, { type: 'turn_end', status: 'completed' });
    expect(taskRepo.getById(db, task.id)?.status).toBe('awaiting_review');
  });
});

// ── 迁移 006 additive ─────────────────────────────────────────────────────
describe('迁移 006 additive', () => {
  it('老库（仅 001 + 存量 file_changes 行）升级：新列存在且可空，数据保留', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(m001.sql);
      db.pragma('user_version = 1');
      const now = Date.now();
      db.prepare(
        'INSERT INTO workspaces (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)',
      ).run('w1', '/tmp/oc-006', 'oc-006', now, now);
      db.prepare(
        `INSERT INTO tasks (id, workspace_id, title, prompt, agent_type, status, created_at, updated_at)
         VALUES ('t1', 'w1', '存量', 'p', 'pi', 'ready', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO file_changes (id, task_id, path, change_type, diff, status, created_at)
         VALUES ('fc1', 't1', 'a.txt', 'modified', 'd', 'pending', ?)`,
      ).run(now);

      runMigrations(db);
      const cols = (db.pragma('table_info(file_changes)') as { name: string }[]).map(
        (c) => c.name,
      );
      for (const c of ['added', 'removed', 'source', 'base_sha', 'capture_round', 'snapshot_path']) {
        expect(cols).toContain(c);
      }
      const row = db.prepare('SELECT * FROM file_changes WHERE id = ?').get('fc1') as Record<
        string,
        unknown
      >;
      expect(row.path).toBe('a.txt');
      expect(row.status).toBe('pending');
      expect(row.added).toBeNull();
      expect(row.source).toBeNull();
      expect(row.capture_round).toBeNull();
    } finally {
      db.close();
    }
  });
});
