/**
 * 迁移 003（ticket #19）：agent 运行支撑。
 * - tasks.fail_reason：agent 异常 → failed 时的原因呈现（UI failed 态 + 「重试」）。
 * - tool_calls.seq：工具调用与消息共用同一任务内序号，文档流按单一时间线渲染
 *   （text 段 / thinking 段 / 工具行交错的真实顺序）。
 * 纯 additive：仅新增可空列，不动既有列与数据。
 */
export default {
  name: 'agent-runtime-support',
  sql: `
ALTER TABLE tasks ADD COLUMN fail_reason TEXT;
ALTER TABLE tool_calls ADD COLUMN seq INTEGER;
`,
};
