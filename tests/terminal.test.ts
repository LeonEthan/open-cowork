import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/main/db/database';
import { resolveTerminalCwd } from '../src/main/pty/cwd';
import { PtySessionManager } from '../src/main/pty/sessions';
import { resolveLoginShell } from '../src/main/pty/shell';

/**
 * ticket #28 内置终端：cwd 解析（seed DB 逐级跟随）+ node-pty echo 往返 + shell 解析。
 * node-pty 为 N-API（单一二进制跨运行时，见 scripts/postinstall.mjs），vitest 直接用主包。
 */

function seedDb(): {
  db: Database;
  wsDir: string;
  wtDir: string;
  plainTaskId: string;
  wtTaskId: string;
} {
  const db = openDatabase(':memory:');
  const wsDir = mkdtempSync(join(tmpdir(), 'oc-ws-'));
  const wtDir = mkdtempSync(join(tmpdir(), 'oc-wt-'));
  const now = Date.now();
  db.prepare(
    'INSERT INTO workspaces (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)',
  ).run('ws1', wsDir, 'ws1', now, now);
  // 普通任务：无 worktree
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, agent_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
  ).run('task-plain', 'ws1', 'plain', 'claude-code', now, now);
  // worktree 任务：worktree_path 非空
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, agent_type, status, use_worktree, worktree_path, base_sha, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ready', 1, ?, 'deadbeef', ?, ?)`,
  ).run('task-wt', 'ws1', 'wt', 'claude-code', wtDir, now, now);
  return { db, wsDir, wtDir, plainTaskId: 'task-plain', wtTaskId: 'task-wt' };
}

describe('resolveTerminalCwd（ticket #28：cwd 跟随当前任务）', () => {
  let db: Database | null = null;
  afterEach(() => {
    db?.close();
    db = null;
  });

  it('普通任务 → 其 workspace.path', () => {
    const s = seedDb();
    db = s.db;
    expect(resolveTerminalCwd(s.db, s.plainTaskId)).toBe(s.wsDir);
  });

  it('worktree 任务 → worktree_path（优先于 workspace.path）', () => {
    const s = seedDb();
    db = s.db;
    expect(resolveTerminalCwd(s.db, s.wtTaskId)).toBe(s.wtDir);
  });

  it('无选中任务（null）→ home', () => {
    const s = seedDb();
    db = s.db;
    expect(resolveTerminalCwd(s.db, null, () => '/fake-home')).toBe('/fake-home');
  });

  it('未知任务 id → home', () => {
    const s = seedDb();
    db = s.db;
    expect(resolveTerminalCwd(s.db, 'no-such-task', () => '/fake-home')).toBe('/fake-home');
  });

  it('worktree_path 已失效（手动清理）→ 回退 workspace.path', () => {
    const s = seedDb();
    db = s.db;
    s.db
      .prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?')
      .run('/nonexistent/worktree-gone', s.wtTaskId);
    expect(resolveTerminalCwd(s.db, s.wtTaskId)).toBe(s.wsDir);
  });

  it('worktree 与 workspace 均失效 → 回退 home', () => {
    const s = seedDb();
    db = s.db;
    s.db
      .prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?')
      .run('/nonexistent/worktree-gone', s.wtTaskId);
    s.db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run('/nonexistent/ws-gone', 'ws1');
    expect(resolveTerminalCwd(s.db, s.wtTaskId, () => '/fake-home')).toBe('/fake-home');
  });
});

describe('resolveLoginShell（ticket #28：登录 shell 解析）', () => {
  it('macOS：读 SHELL，兜底 /bin/zsh -l', () => {
    expect(resolveLoginShell('darwin', {})).toEqual({ file: '/bin/zsh', args: ['-l'] });
    expect(resolveLoginShell('darwin', { SHELL: '/bin/fish' })).toEqual({
      file: '/bin/fish',
      args: ['-l'],
    });
    expect(resolveLoginShell('darwin', { SHELL: '  ' })).toEqual({
      file: '/bin/zsh',
      args: ['-l'],
    });
  });

  it('linux：兜底 /bin/bash -l；win32：ComSpec / powershell', () => {
    expect(resolveLoginShell('linux', {})).toEqual({ file: '/bin/bash', args: ['-l'] });
    expect(resolveLoginShell('win32', {}).file).toBe('powershell.exe');
    expect(resolveLoginShell('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }).file).toBe(
      'C:\\Windows\\System32\\cmd.exe',
    );
  });
});

describe('PtySessionManager（ticket #28：node-pty 会话）', () => {
  const managers: PtySessionManager[] = [];
  afterEach(() => {
    for (const m of managers.splice(0)) m.disposeAll();
  });

  it('keys() 快照（ticket #38：pty:list 数据源）：创建登记、dispose 移除', () => {
    const m = new PtySessionManager();
    managers.push(m);
    expect(m.keys()).toEqual([]);
    m.getOrCreate('task-a', { cols: 80, rows: 24, shell: '/bin/cat', shellArgs: [] });
    m.getOrCreate('global', { cols: 80, rows: 24, shell: '/bin/cat', shellArgs: [] });
    expect(m.keys().sort()).toEqual(['global', 'task-a']);
    m.dispose('task-a');
    expect(m.keys()).toEqual(['global']);
  });

  it('echo 往返：写入的数据经 pty 回到 onData；per key 复用', async () => {
    const m = new PtySessionManager();
    managers.push(m);
    let acc = '';
    const echoed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`echo 超时，已收到: ${JSON.stringify(acc)}`)),
        10_000,
      );
      const first = m.getOrCreate(
        'echo-1',
        { cols: 80, rows: 24, cwd: process.cwd(), shell: '/bin/cat', shellArgs: [] },
        {
          onData: (d) => {
            acc += d;
            if (acc.includes('oc-marker-42')) {
              clearTimeout(timer);
              resolve(acc);
            }
          },
        },
      );
      expect(first.created).toBe(true);
    });
    // 同 key 再取：复用而非重启
    expect(m.getOrCreate('echo-1', { cols: 80, rows: 24 }).created).toBe(false);
    expect(m.has('echo-1')).toBe(true);

    m.write('echo-1', 'oc-marker-42\n');
    const out = await echoed;
    expect(out).toContain('oc-marker-42');

    m.dispose('echo-1');
    expect(m.has('echo-1')).toBe(false);
  });

  it('两个 key 各自独立会话（多任务并存模型）', () => {
    const m = new PtySessionManager();
    managers.push(m);
    m.getOrCreate('task-a', { cols: 80, rows: 24, shell: '/bin/cat', shellArgs: [] });
    m.getOrCreate('task-b', { cols: 80, rows: 24, shell: '/bin/cat', shellArgs: [] });
    expect(m.size()).toBe(2);
    m.dispose('task-a');
    expect(m.has('task-a')).toBe(false);
    expect(m.has('task-b')).toBe(true);
  });

  it('会话 cwd 生效：shell 内 pwd 输出指定目录', async () => {
    // macOS /var → /private/var 符号链接：统一用 realpath 比较
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'oc-cwd-')));
    const m = new PtySessionManager();
    managers.push(m);
    let acc = '';
    const sawPwd = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`pwd 超时，已收到: ${JSON.stringify(acc)}`)),
        10_000,
      );
      m.getOrCreate(
        'cwd-1',
        { cols: 80, rows: 24, cwd: dir, shell: '/bin/sh', shellArgs: ['-i'] },
        {
          onData: (d) => {
            acc += d;
            if (acc.includes(dir)) {
              clearTimeout(timer);
              resolve();
            }
          },
        },
      );
    });
    // pty 输入缓冲：sh 起来后会读到并执行
    m.write('cwd-1', 'pwd\n');
    await sawPwd;
  });

  it('resize / dispose 对未知 key 静默，不抛异常', () => {
    const m = new PtySessionManager();
    managers.push(m);
    expect(() => {
      m.write('nope', 'x');
      m.resize('nope', 100, 40);
      m.dispose('nope');
    }).not.toThrow();
  });
});
