import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import type { Task, TaskStatus } from './entities';
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
}

/** 侧栏/文档流列表项：附带 workspace 名（元信息展示用，DESIGN.md §1） */
export type TaskListItem = Task & { workspace_name: string };

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
    use_worktree: 0,
    worktree_path: null,
    base_sha: null,
    session_id: null,
    fail_reason: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, prompt, agent_type, provider_id, model,
                        permission_mode, status, use_worktree, worktree_path, base_sha,
                        session_id, fail_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    task.created_at,
    task.updated_at,
  );
  return task;
}

/** 全部任务（新→旧），联表带 workspace 名 */
export function list(db: Database): TaskListItem[] {
  return db
    .prepare(
      `SELECT t.*, w.name AS workspace_name
       FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
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
