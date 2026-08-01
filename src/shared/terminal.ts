/**
 * 终端会话协议常量（ticket #38 收口：main pty/sessions.ts 与 renderer stores/ui.ts 的单一来源）。
 * 无任务选中时的 pty 会话 key（wire 契约：pty:create / pty:list / pty:session 均以此字面量通信）。
 */
export const TERMINAL_GLOBAL_KEY = 'global';
