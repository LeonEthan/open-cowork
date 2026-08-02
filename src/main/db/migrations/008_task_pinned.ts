/**
 * 迁移 008（二期 Pinned 置顶任务，DESIGN.md 附录 A 延期项，additive）：
 * tasks 补 pinned 列（0/1，默认 0）——侧栏任务树「置顶」分组的数据源。
 *
 * additive：只新增带默认值的列，不动既有列与存量行；
 * 置顶切换不涉状态机（任何状态下可 pin/unpin），与权限档位同例。
 */
export default {
  name: 'task-pinned',
  sql: `
ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
`,
};
