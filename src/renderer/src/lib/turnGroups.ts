import type { FileChange } from '../../../shared/api';
import type { ConversationItem, TaskConversation } from '../stores/conversation';

/**
 * 按轮工作摘要（Codex 对齐改造，DESIGN.md 附录 B）：
 * 文档流条目按轮（turn）分组——user 消息为轮界；组内工具/思考/审批行折叠进
 * 「工作中 … / 已工作 …」摘要行，assistant 文本与用量灰字保持文档流原样。
 */

export interface TurnGroup {
  user: Extract<ConversationItem, { kind: 'user' }> | null;
  /** 折叠进工作摘要行的条目（工具 / 思考 / 审批，保持原序） */
  work: ConversationItem[];
  texts: Extract<ConversationItem, { kind: 'text' }>[];
  usage: Extract<ConversationItem, { kind: 'usage' }>[];
  errors: Extract<ConversationItem, { kind: 'error' }>[];
}

const newGroup = (user: TurnGroup['user']): TurnGroup => ({
  user,
  work: [],
  texts: [],
  usage: [],
  errors: [],
});

/** 平铺时间线 → 轮分组（user 消息开新轮；轮前残留归入 user=null 的首组） */
export function groupByTurn(items: ConversationItem[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const it of items) {
    if (it.kind === 'user') {
      groups.push(newGroup(it));
      continue;
    }
    if (groups.length === 0) groups.push(newGroup(null));
    const g = groups[groups.length - 1];
    if (it.kind === 'text') g.texts.push(it);
    else if (it.kind === 'usage') g.usage.push(it);
    else if (it.kind === 'error') g.errors.push(it);
    else g.work.push(it);
  }
  return groups;
}

/** 组 → 轮次元数据配对：第 k 个带 user 的组 ↔ turns[k]（idx 升序）；多出的尾组为 live 新轮（返回 null） */
export function matchGroupTurns(
  groups: TurnGroup[],
  turns: TaskConversation['turns'],
): Array<TaskConversation['turns'][number] | null> {
  let k = 0;
  return groups.map((g) => (g.user !== null ? (turns[k++] ?? null) : null));
}

/** 时长格式化（Codex 同款：42s / 4m 44s / 1h 03m） */
export function fmtDurationMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** 工作摘要行内的聚合小字（Codex「edited files, ran commands」）：按归一工具名归类计数 */
export function aggregateOf(work: ConversationItem[]): string | null {
  let edited = 0;
  let ran = 0;
  let read = 0;
  for (const it of work) {
    if (it.kind !== 'tool') continue;
    const n = it.call.name;
    if (/edit|write|patch/i.test(n)) edited += 1;
    else if (/bash|shell|terminal|command|exec/i.test(n)) ran += 1;
    else if (/read|grep|glob|search|list|view/i.test(n)) read += 1;
  }
  const parts: string[] = [];
  if (edited > 0) parts.push(`编辑 ${edited} 个文件`);
  if (ran > 0) parts.push(`运行 ${ran} 条命令`);
  if (read > 0) parts.push(`读取 ${read} 个文件`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** 任务级 diffstat（工作摘要行尾「N 个文件 +x −y」；FileChange.added/removed 为捕获期统计，NULL 不计） */
export function diffstatOf(changes: FileChange[]): { files: number; adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const c of changes) {
    adds += c.added ?? 0;
    dels += c.removed ?? 0;
  }
  return { files: changes.length, adds, dels };
}
