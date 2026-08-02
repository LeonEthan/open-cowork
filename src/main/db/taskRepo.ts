import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import type { Task, TaskStatus, PermissionMode } from './entities';
import { assertTransition } from './taskStateMachine';

/**
 * Task 仓储（ticket #18）：创建即入库为 ready；状态迁移一律经状态机把关
 * （taskStateMachine.assertTransition），非法迁移抛错、不落库。
 * 纯 Node 无 Electron 依赖，vitest 可直接用 ':memory:' 跑。
 */

export interface CreateTaskInput {
  workspaceId: string;
  /** 需求描述（初始 prompt） */
  prompt: string;
  /** 标题可选——缺省时从 prompt 首行截取 */
  title?: string;
  /** claude-code / codex / opencode / pi / custom:<id> */
  agentType: string;
  providerId?: string | null;
  model?: string | null;
  // ── ticket #25（additive）：创建时 opt-in worktree 隔离（默认 false = 共享原目录） ──
  useWorktree?: boolean;
}

/** 侧栏/文档流列表项：附带 workspace 名 + provider 名（元信息展示用，DESIGN.md §1） */
export type TaskListItem = Task & { workspace_name: string; provider_name: string | null };

/** 从需求描述派生标题：取首行、压缩空白、截断 40 字 */
export function deriveTitle(prompt: string): string {
  const firstLine = prompt.split('\n').find((l) => l.trim().length > 0) ?? '';
  const compact = firstLine.trim().replace(/\s+/g, ' ');
  if (compact.length === 0) return '未命名任务';
  return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact;
}

export function create(db: Database, input: CreateTaskInput, now: number = Date.now()): Task {
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(input.workspaceId) as
    | { id: string }
    | undefined;
  if (!ws) throw new Error(`workspace 不存在: ${input.workspaceId}`);

  const prompt = input.prompt.trim();
  if (prompt.length === 0) throw new Error('需求描述不能为空');

  const task: Task = {
    id: randomUUID(),
    workspace_id: input.workspaceId,
    title: input.title?.trim() || deriveTitle(prompt),
    prompt,
    agent_type: input.agentType,
    provider_id: input.providerId ?? null,
    model: input.model ?? null,
    permission_mode: 'auto',
    status: 'ready',
    // #25：opt-in 落列；worktree 本体由 services/tasks.ts 在入库后创建（失败回滚任务行）
    use_worktree: input.useWorktree ? 1 : 0,
    worktree_path: null,
    base_sha: null,
    session_id: null,
    fail_reason: null,
    pinned: 0,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, prompt, agent_type, provider_id, model,
                        permission_mode, status, use_worktree, worktree_path, base_sha,
                        session_id, fail_reason, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.workspace_id,
    task.title,
    task.prompt,
    task.agent_type,
    task.provider_id,
    task.model,
    task.permission_mode,
    task.status,
    task.use_worktree,
    task.worktree_path,
    task.base_sha,
    task.session_id,
    task.fail_reason,
    task.pinned,
    task.created_at,
    task.updated_at,
  );
  return task;
}

/** 全部任务（新→旧），联表带 workspace 名与 provider 名（#21 chip 展示） */
export function list(db: Database): TaskListItem[] {
  return db
    .prepare(
      `SELECT t.*, w.name AS workspace_name, p.name AS provider_name
       FROM tasks t
       JOIN workspaces w ON w.id = t.workspace_id
       LEFT JOIN providers p ON p.id = t.provider_id
       ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all() as TaskListItem[];
}

export function getById(db: Database, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  return row ?? null;
}

/**
 * 状态迁移：先经状态机校验（非法迁移抛错、不落库），合法则更新 status + updated_at。
 * failReason：迁入 failed 时必填（UI 呈现原因）；迁回 ready/running（重试/再跑）自动清空。
 * 返回迁移后的任务行。
 */
export function updateStatus(
  db: Database,
  id: string,
  to: TaskStatus,
  now: number = Date.now(),
  failReason?: string,
): Task {
  const task = getById(db, id);
  if (!task) throw new Error(`任务不存在: ${id}`);
  assertTransition(task.status, to);
  const reason =
    to === 'failed'
      ? (failReason ?? task.fail_reason ?? '未知错误')
      : to === 'ready' || to === 'running'
        ? null
        : task.fail_reason;
  db.prepare('UPDATE tasks SET status = ?, fail_reason = ?, updated_at = ? WHERE id = ?').run(
    to,
    reason,
    now,
    id,
  );
  return { ...task, status: to, fail_reason: reason, updated_at: now };
}

/** 写入 agent 原生 session id（session_started 时；1:1，只允许写一次或同值重写） */
export function setSessionId(db: Database, id: string, sessionId: string, now: number = Date.now()): void {
  db.prepare('UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?').run(sessionId, now, id);
}

// ── ticket #20：per-task 权限档位（additive；不涉状态机，任何状态下可切换） ──

const PERMISSION_MODES: readonly PermissionMode[] = ['readonly', 'auto', 'full'];

/** 切换权限档位（三档：readonly / auto / full，ARCHITECTURE §6；非法值抛错） */
export function setPermissionMode(
  db: Database,
  id: string,
  mode: PermissionMode,
  now: number = Date.now(),
): Task {
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`非法权限档位: ${mode}`);
  const task = getById(db, id);
  if (!task) throw new Error(`任务不存在: ${id}`);
  db.prepare('UPDATE tasks SET permission_mode = ?, updated_at = ? WHERE id = ?').run(mode, now, id);
  return { ...task, permission_mode: mode, updated_at: now };
}

// ── 二期 Pinned 置顶（additive；不涉状态机，任何状态下可切换） ──────────────

/** 置顶/取消置顶（pinned 0/1；任务不存在抛错）。返回更新后的任务行 */
export function setPinned(
  db: Database,
  id: string,
  pinned: boolean,
  now: number = Date.now(),
): Task {
  const task = getById(db, id);
  if (!task) throw new Error(`任务不存在: ${id}`);
  db.prepare('UPDATE tasks SET pinned = ?, updated_at = ? WHERE id = ?').run(
    pinned ? 1 : 0,
    now,
    id,
  );
  return { ...task, pinned: pinned ? 1 : 0, updated_at: now };
}

// ── Codex 对齐：任务重命名与删除（additive；不涉状态机） ────────────────────

/** 重命名任务（trim 后非空校验；任务不存在抛错；updated_at 刷新）。返回更新后的任务行 */
export function rename(
  db: Database,
  id: string,
  title: string,
  now: number = Date.now(),
): Task {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new Error('任务标题不能为空');
  const task = getById(db, id);
  if (!task) throw new Error(`任务不存在: ${id}`);
  db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?').run(trimmed, now, id);
  return { ...task, title: trimmed, updated_at: now };
}

/**
 * 删除任务：schema 未声明 ON DELETE CASCADE（迁移均为裸 REFERENCES），
 * 故与 workspaceRepo.remove 同口径——子表（按依赖逆序）显式清理后删任务行，单事务。
 * （messages 删除经 messages_ad 触发器自动同步 FTS5。）
 */
export function remove(db: Database, id: string): void {
  const task = getById(db, id);
  if (!task) throw new Error(`任务不存在: ${id}`);
  db.transaction(() => {
    for (const table of [
      'usage_records',
      'file_changes',
      'approvals',
      'tool_calls',
      'messages',
      'turns',
    ] as const) {
      db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(id);
    }
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  })();
}

// ── ticket #25：worktree 隔离（additive；不涉状态机） ─────────────────────

/**
 * 写入/清空 worktree 集中目录路径（创建成功落路径；手动清理置 null——
 * 终端 cwd / diff 捕获 / agent cwd 三处的 worktree_path ?? workspace.path 回退随之生效）。
 */
export function setWorktreePath(
  db: Database,
  id: string,
  path: string | null,
  now: number = Date.now(),
): Task {
  const task = getById(db, id);
  if (!task) throw new Error(`任务不存在: ${id}`);
  db.prepare('UPDATE tasks SET worktree_path = ?, updated_at = ? WHERE id = ?').run(path, now, id);
  return { ...task, worktree_path: path, updated_at: now };
}
