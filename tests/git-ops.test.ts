import { describe, expect, it } from 'vitest';
import {
  commitAll,
  compareWithBase,
  parseNameStatus,
  parseShortStat,
  push,
  workingSummary,
} from '../src/main/git';
import type { GitExec } from '../src/main/worktree/worktree';

/**
 * 检查栏 git 操作（ticket #39）纯逻辑 vitest：
 * exec 注入（不碰真 git），覆盖——
 * - workingSummary：非 git / 无 upstream（ahead·behind=null）/ 有 ahead-behind 三例；
 * - compareWithBase：name-status + shortstat + untracked 的解析口径；
 * - commitAll：无改动 reject（'没有可提交的改动'）+ 空信息校验 + 成功路径；
 * - push：失败剥 stderr 首行。
 */

/** 造一个按 args 路由的 exec：miss 时抛错（模拟 git 失败） */
function fakeExec(routes: Array<{ match: string[]; out?: string; err?: string }>): GitExec {
  return (_cwd, args) => {
    for (const r of routes) {
      if (r.match.every((m, i) => args[i] === m)) {
        if (r.err !== undefined) {
          const e = new Error(`Command failed: git ${args.join(' ')}`) as Error & {
            stderr?: string;
          };
          e.stderr = r.err;
          throw e;
        }
        return r.out ?? '';
      }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

describe('workingSummary', () => {
  it('非 git 目录：isGitRepo=false，其余全 null', () => {
    const exec = fakeExec([{ match: ['rev-parse', '--is-inside-work-tree'], out: '' }]);
    expect(workingSummary('/x', exec)).toEqual({
      isGitRepo: false,
      branch: null,
      ahead: null,
      behind: null,
    });
  });

  it('git 命令失败（非仓）：同样按非 git 处理，不抛', () => {
    const exec = fakeExec([
      { match: ['rev-parse', '--is-inside-work-tree'], err: 'fatal: not a git repository' },
    ]);
    expect(workingSummary('/x', exec).isGitRepo).toBe(false);
  });

  it('无 upstream：分支正常，ahead/behind 为 null', () => {
    const exec = fakeExec([
      { match: ['rev-parse', '--is-inside-work-tree'], out: 'true\n' },
      { match: ['symbolic-ref', '--short', '-q', 'HEAD'], out: 'main\n' },
      {
        match: ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        err: 'fatal: no upstream configured for branch \'main\'',
      },
    ]);
    expect(workingSummary('/x', exec)).toEqual({
      isGitRepo: true,
      branch: 'main',
      ahead: null,
      behind: null,
    });
  });

  it('有 upstream：解析 behind/ahead（左=behind，右=ahead）', () => {
    const exec = fakeExec([
      { match: ['rev-parse', '--is-inside-work-tree'], out: 'true\n' },
      { match: ['symbolic-ref', '--short', '-q', 'HEAD'], out: 'feat/x\n' },
      { match: ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], out: '2\t3\n' },
    ]);
    expect(workingSummary('/x', exec)).toEqual({
      isGitRepo: true,
      branch: 'feat/x',
      ahead: 3,
      behind: 2,
    });
  });
});

describe('commitAll', () => {
  it('无改动：reject Error(\'没有可提交的改动\')', () => {
    const exec = fakeExec([{ match: ['status', '--porcelain'], out: '' }]);
    expect(() => commitAll('/x', 'msg', exec)).toThrow('没有可提交的改动');
  });

  it('空白提交信息：reject 且不碰 git', () => {
    const exec = fakeExec([]);
    expect(() => commitAll('/x', '   ', exec)).toThrow('提交信息不能为空');
  });

  it('成功路径：add -A + commit 后返回 rev-parse 的 SHA', () => {
    const calls: string[][] = [];
    const exec: GitExec = (_cwd, args) => {
      calls.push(args);
      if (args[0] === 'status') return ' M a.ts\n';
      if (args[0] === 'rev-parse') return 'abc123def456\n';
      return '';
    };
    expect(commitAll('/x', '  提交一下  ', exec)).toEqual({ ok: true, sha: 'abc123def456' });
    expect(calls).toEqual([
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', '提交一下'], // trim 后的信息
      ['rev-parse', 'HEAD'],
    ]);
  });
});

describe('push', () => {
  it('失败：剥 stderr 首行，面向用户可读', () => {
    const exec = fakeExec([
      {
        match: ['push', '-u', 'origin', 'HEAD'],
        err: 'error: failed to push some refs to \'origin\'\nhint: Updates were rejected',
      },
    ]);
    expect(() => push('/x', exec)).toThrow(
      "推送失败：error: failed to push some refs to 'origin'",
    );
  });

  it('成功：ok', () => {
    const exec = fakeExec([{ match: ['push', '-u', 'origin', 'HEAD'], out: '' }]);
    expect(push('/x', exec)).toEqual({ ok: true });
  });
});

describe('compareWithBase 解析', () => {
  it('name-status：M/A/D/R 各态 + R 取新路径标 renamed；untracked 一律 added', () => {
    const exec = fakeExec([
      { match: ['rev-parse', '--short', 'base123'], out: 'base123\n' },
      {
        match: ['diff', '--name-status', 'base123'],
        out: 'M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.ts\nR100\told/name.ts\tnew/name.ts\n',
      },
      {
        match: ['diff', '--shortstat', 'base123'],
        out: ' 4 files changed, 10 insertions(+), 4 deletions(-)\n',
      },
      { match: ['ls-files', '--others', '--exclude-standard'], out: 'scratch/note.md\n' },
    ]);
    const r = compareWithBase('/x', 'base123', exec);
    expect(r.supported).toBe(true);
    expect(r.baseLabel).toBe('base123');
    expect(r.insertions).toBe(10);
    expect(r.deletions).toBe(4);
    // 排序后：new/name.ts 在 scratch/note.md 前（localeCompare）
    expect(r.files).toEqual([
      { path: 'new/name.ts', status: 'renamed' },
      { path: 'scratch/note.md', status: 'added' }, // untracked → added
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/c.ts', status: 'deleted' },
    ]);
  });

  it('shortstat 缺段（仅 insertions）与空输出均解析为对应值', () => {
    expect(parseShortStat(' 1 file changed, 5 insertions(+)')).toEqual({
      insertions: 5,
      deletions: 0,
    });
    expect(parseShortStat(' 1 file changed, 2 deletions(-)')).toEqual({
      insertions: 0,
      deletions: 2,
    });
    expect(parseShortStat('')).toEqual({ insertions: 0, deletions: 0 });
  });

  it('name-status 单测：空行忽略，C(copy) 按 added 新路径', () => {
    expect(parseNameStatus('C80\tsrc/a.ts\tsrc/b.ts\n\n')).toEqual([
      { path: 'src/b.ts', status: 'added' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });

  it('diff 失败：reject 带 stderr 首行', () => {
    const exec = fakeExec([
      { match: ['rev-parse', '--short', 'bad'], out: 'bad\n' },
      {
        match: ['diff', '--name-status', 'bad'],
        err: "fatal: ambiguous argument 'bad': unknown revision",
      },
    ]);
    expect(() => compareWithBase('/x', 'bad', exec)).toThrow(
      "对比 base 失败：fatal: ambiguous argument 'bad': unknown revision",
    );
  });
});
