/**
 * 迁移 002（ticket #18）：tasks 表补 session_id 列——Task 与 agent session 严格 1:1
 * （PRD §6 / ARCHITECTURE §5）。本票只留位（可空、不填值），#19 接入 agent 运行时写入。
 * 纯 additive：仅新增可空列，不动既有列与数据。
 */
export default {
  name: 'task-session-id',
  sql: `
ALTER TABLE tasks ADD COLUMN session_id TEXT;
`,
};
