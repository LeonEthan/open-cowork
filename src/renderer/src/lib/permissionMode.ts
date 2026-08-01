import type { PermissionMode } from '../../../shared/api';

/**
 * 权限三档（只读/自动/放权）的呈现常量（ticket #20 立法；ticket #36 抽出共享——
 * 任务内 composer 与首页 composer 同口径引用，语义不变仅视觉归属动作行）。
 */
export const MODE_NEXT: Record<PermissionMode, PermissionMode> = {
  readonly: 'auto',
  auto: 'full',
  full: 'readonly',
};
export const MODE_LABELS: Record<PermissionMode, string> = {
  readonly: '只读',
  auto: '自动',
  full: '放权',
};
export const MODE_TITLES: Record<PermissionMode, string> = {
  readonly: '权限档位：只读——写/命令类请求一律自动拒绝',
  auto: '权限档位：自动——命中「总是允许」规则放行，其余逐条审批',
  full: '权限档位：完全放权——一律放行，不再打扰',
};
