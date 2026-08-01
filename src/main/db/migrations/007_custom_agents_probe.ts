/**
 * 迁移 007（ticket #26，additive）：custom_agents 补「最近一次探测结果」列。
 *
 * 表本体在迁移 001 已有（id/name/command/args_json/protocol/env_json/created_at）；
 * 本迁移只新增可空列 last_probe_json——探测结果快照（{ok, resolvedPath, version, error, at}），
 * 供 agents:list 合并自定义 agent 时零 spawn 直读（实时重探测走 agents:refresh /
 * custom-agents:reprobe / custom-agents:create 写回本列）。
 */
export default {
  name: 'custom-agents-last-probe',
  sql: `
ALTER TABLE custom_agents ADD COLUMN last_probe_json TEXT;
`,
};
