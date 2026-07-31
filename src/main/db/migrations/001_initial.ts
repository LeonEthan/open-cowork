/**
 * 迁移 001：十实体 schema（PRD §6 / ARCHITECTURE §5）+ Message FTS5。
 *
 * ── 如何新增一个迁移 ──
 * 在本目录新建 NNN_name.ts（编号严格递增），默认导出 { name, sql } 即可，
 * 无需修改任何其他文件；迁移 runner 按文件名排序、用 PRAGMA user_version 记录已执行版本，
 * 每个迁移在独立事务中执行。列设计约束见 entities.ts 顶部约定。
 */
export default {
  name: 'initial-ten-entities',
  sql: `
CREATE TABLE workspaces (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  title           TEXT NOT NULL,
  prompt          TEXT NOT NULL DEFAULT '',
  agent_type      TEXT NOT NULL,
  provider_id     TEXT REFERENCES providers(id),
  model           TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'auto'
                  CHECK (permission_mode IN ('readonly', 'auto', 'full')),
  status          TEXT NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('ready', 'running', 'awaiting_approval',
                                    'awaiting_review', 'done', 'failed', 'cancelled')),
  use_worktree    INTEGER NOT NULL DEFAULT 0,
  worktree_path   TEXT,
  base_sha        TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX idx_tasks_status    ON tasks(status);

CREATE TABLE turns (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  idx        INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running'
             CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX idx_turns_task ON turns(task_id, idx);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  turn_id    TEXT REFERENCES turns(id),
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  kind       TEXT NOT NULL DEFAULT 'text',
  content    TEXT NOT NULL DEFAULT '',
  seq        INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_task ON messages(task_id, seq);
CREATE INDEX idx_messages_turn ON messages(turn_id);

-- Message 内容全文索引（FTS5，external content，随 messages 触发器同步）
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  turn_id     TEXT REFERENCES turns(id),
  message_id  TEXT REFERENCES messages(id),
  name        TEXT NOT NULL,
  target      TEXT,
  input_json  TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'success', 'error', 'denied')),
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX idx_tool_calls_task ON tool_calls(task_id);

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  tool_call_id TEXT REFERENCES tool_calls(id),
  request_json TEXT NOT NULL DEFAULT '{}',
  decision     TEXT NOT NULL DEFAULT 'pending'
               CHECK (decision IN ('pending', 'approved_once', 'approved_always', 'denied')),
  reason       TEXT,
  rule_pattern TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);
CREATE INDEX idx_approvals_task ON approvals(task_id);

CREATE TABLE file_changes (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  path        TEXT NOT NULL,
  change_type TEXT NOT NULL
              CHECK (change_type IN ('added', 'modified', 'deleted', 'renamed')),
  diff        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'reverted')),
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_file_changes_task ON file_changes(task_id);

CREATE TABLE usage_records (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  turn_id            TEXT REFERENCES turns(id),
  provider_id        TEXT REFERENCES providers(id),
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  pricing_source     TEXT CHECK (pricing_source IN ('models.dev', 'subscription')),
  recorded_at        INTEGER NOT NULL
);
CREATE INDEX idx_usage_records_task ON usage_records(task_id);

CREATE TABLE providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('preset', 'custom')),
  base_url      TEXT NOT NULL,
  protocol      TEXT NOT NULL,
  credential_key TEXT,
  models_json   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE custom_agents (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  command    TEXT NOT NULL,
  args_json  TEXT NOT NULL DEFAULT '[]',
  protocol   TEXT NOT NULL DEFAULT 'acp' CHECK (protocol IN ('acp')),
  env_json   TEXT,
  created_at INTEGER NOT NULL
);
`,
};
