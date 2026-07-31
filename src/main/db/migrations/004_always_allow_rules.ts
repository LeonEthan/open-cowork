/**
 * 迁移 004（ticket #20）：权限审批流持久化。
 * - always_allow_rules：「总是允许」规则（工具 + 目标模式，如 `Bash: npm *`，
 *   ARCHITECTURE §6），全局作用域（不限定 task/workspace——规则语义是用户级信任记忆）；
 *   (tool, target_pattern) 唯一约束兜底幂等插入。
 * - tasks.permission_mode 列已由迁移 001 建好（三档 CHECK 约束），本迁移无需触碰。
 * 纯 additive：仅 CREATE 新表，不动既有表结构与数据。
 */
export default {
  name: 'always-allow-rules',
  sql: `
CREATE TABLE always_allow_rules (
  id             TEXT PRIMARY KEY,
  tool           TEXT NOT NULL,
  target_pattern TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (tool, target_pattern)
);
CREATE INDEX idx_always_allow_rules_tool ON always_allow_rules(tool);
`,
};
