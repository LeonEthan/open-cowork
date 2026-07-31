/**
 * 十实体 TS 类型（PRD §6 / ARCHITECTURE §5）。
 *
 * 约定（下游票据直接依赖）：
 * - 列名 = sqlite 列名（snake_case），better-sqlite3 返回的行可直接断言为这些类型；
 * - id 一律 TEXT（应用层用 crypto.randomUUID() 生成）；
 * - 时间戳一律 INTEGER，Unix epoch 毫秒，由应用层写入（DB 层不设默认值）；
 * - JSON 载荷列以 TEXT 存储（*_json）。
 */

/** Task 六态状态机（+failed/cancelled）：ready → running ⇄ awaiting_approval → awaiting_review → done */
export type TaskStatus =
  | 'ready'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | 'cancelled';

/** per-task 权限档位（ARCHITECTURE §6） */
export type PermissionMode = 'readonly' | 'auto' | 'full';

export interface Workspace {
  id: string;
  /** 本地目录绝对路径（唯一） */
  path: string;
  name: string;
  created_at: number;
  last_opened_at: number;
}

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  /** 初始需求文本 */
  prompt: string;
  /** claude-code / codex / opencode / pi / custom:<id> */
  agent_type: string;
  provider_id: string | null;
  model: string | null;
  permission_mode: PermissionMode;
  status: TaskStatus;
  /** worktree 为 per-task opt-in（默认 0，ARCHITECTURE §8） */
  use_worktree: number;
  worktree_path: string | null;
  /** 创建 worktree 时 pin 的 base SHA */
  base_sha: string | null;
  /** Task 与 agent session 严格 1:1（迁移 002 / ticket #18 留位可空；#19 接入 agent 运行时写入） */
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

export type TurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Turn {
  id: string;
  task_id: string;
  /** 任务内轮次序号（从 1 开始） */
  idx: number;
  status: TurnStatus;
  started_at: number;
  ended_at: number | null;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  task_id: string;
  turn_id: string | null;
  role: MessageRole;
  /**
   * 消息类型：text 普通消息；thinking 思考过程（§4 折叠呈现）；tool-summary 等后续扩展。
   * content 为 markdown 文本，进入 messages_fts 全文索引。
   */
  kind: string;
  content: string;
  /** 任务内消息序号（从 1 开始，渲染顺序依据） */
  seq: number;
  created_at: number;
}

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error' | 'denied';

export interface ToolCall {
  id: string;
  task_id: string;
  turn_id: string | null;
  message_id: string | null;
  /** 工具名（如 Bash / Edit / Write） */
  name: string;
  /** 作用目标（文件路径 / 命令行），极简工具行展示用 */
  target: string | null;
  input_json: string;
  output_json: string | null;
  status: ToolCallStatus;
  started_at: number;
  ended_at: number | null;
}

export type ApprovalDecision = 'pending' | 'approved_once' | 'approved_always' | 'denied';

export interface Approval {
  id: string;
  task_id: string;
  tool_call_id: string | null;
  /** 原始审批请求载荷 */
  request_json: string;
  decision: ApprovalDecision;
  /** 拒绝理由（可选） */
  reason: string | null;
  /**
   * 「总是允许」命中的规则模式（工具 + 目标模式，如 `Bash: npm *`，ARCHITECTURE §6）；
   * 规则持久化在后续审批票据中实现，本表先留位。
   */
  rule_pattern: string | null;
  created_at: number;
  decided_at: number | null;
}

export type FileChangeType = 'added' | 'modified' | 'deleted' | 'renamed';
export type FileChangeStatus = 'pending' | 'accepted' | 'reverted';

export interface FileChange {
  id: string;
  task_id: string;
  path: string;
  change_type: FileChangeType;
  /** unified diff 文本（快照兜底方案同样归一为此，ARCHITECTURE §7） */
  diff: string | null;
  status: FileChangeStatus;
  created_at: number;
  resolved_at: number | null;
}

export interface UsageRecord {
  id: string;
  task_id: string;
  turn_id: string | null;
  provider_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** 按 models.dev 价折算的美元成本；订阅制为 NULL 且 pricing_source='subscription'（标注「仅供参考」） */
  cost_usd: number | null;
  pricing_source: 'models.dev' | 'subscription' | null;
  recorded_at: number;
}

export interface Provider {
  id: string;
  name: string;
  /** preset 内置六家 / custom 自定义 */
  kind: 'preset' | 'custom';
  base_url: string;
  /** 线协议：anthropic / openai-compatible / … */
  protocol: string;
  /**
   * 注入子进程的环境变量名（如 ANTHROPIC_API_KEY）。
   * 注意：密钥本体不入库——凭证经 Electron safeStorage / Keychain 加密存放（ARCHITECTURE §3），
   * 这里只存「凭证在保险箱里的键名」。
   */
  credential_key: string | null;
  /** models.dev 元数据缓存（上下文长度、价格等） */
  models_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface CustomAgent {
  id: string;
  name: string;
  /** 启动命令（自定义 ACP agent，PRD §4.5） */
  command: string;
  args_json: string;
  /** 适配协议，MVP 内固定 acp */
  protocol: 'acp';
  env_json: string | null;
  created_at: number;
}
