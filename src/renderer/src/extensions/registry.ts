import type { ComponentType } from 'react';

/**
 * renderer 侧扩展点统一注册表：新增文件即注册、零编辑共享文件。
 *
 * 三个扩展面（后续票据在并行 worktree 中各自新增文件，互不冲突）：
 *   extensions/inspector-tabs/     检查栏 tab（DESIGN.md §1.2 修订：变更单栏，单 tab 时 tab 条退场；
 *                                  文件复查并入变更 tab，不单设文件 tab；终端已迁底部抽屉）
 *   extensions/settings-sections/  设置页区块
 *   extensions/sidebar-sections/   任务侧栏区块
 *
 * ── 如何新增一个扩展（三个面通用）──
 * 1. 在对应目录新建 <name>.tsx；
 * 2. 默认导出一个自描述对象（见下方三个接口）：{ id, title, order, component }；
 * 3. 完成。import.meta.glob 自动收集，按 order（再按 id）排序渲染。
 *
 * 约束：id 全局唯一（冲突时后注册者覆盖前者并告警）；
 * 组件实现必须遵守 DESIGN.md（只用 token、零阴影、动效白名单）。
 */

export interface InspectorTabDef {
  id: string;
  /** tab 栏显示的短标题（如「变更」「终端」） */
  title: string;
  order: number;
  component: ComponentType;
}

export interface SettingsSectionDef {
  id: string;
  /** 设置页区块标题 */
  title: string;
  order: number;
  component: ComponentType;
}

export interface SidebarSectionDef {
  id: string;
  /**
   * 侧栏区块标题（§1：克制，无多余装饰）。
   * ticket #26（additive）：空串 = 无标题的裸区块（如 agent 横幅——健康时组件返回
   * null，整区块在 DOM 中完全消失；渲染分支见 components/Sidebar.tsx）。
   */
  title: string;
  order: number;
  component: ComponentType;
}

function collect<T extends { id: string; order: number; component: unknown }>(
  modules: Record<string, { default?: T }>,
  kind: string,
): T[] {
  const byId = new Map<string, T>();
  for (const [path, mod] of Object.entries(modules)) {
    const def = mod.default;
    if (!def?.id || typeof def.order !== 'number' || !def.component) {
      console.warn(`[extensions] ${kind} ${path} 缺少默认导出 { id, title, order, component }，已跳过`);
      continue;
    }
    if (byId.has(def.id)) {
      console.warn(`[extensions] ${kind} id 冲突: "${def.id}"（${path} 覆盖先注册者）`);
    }
    byId.set(def.id, def);
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export const inspectorTabs: InspectorTabDef[] = collect(
  import.meta.glob('./inspector-tabs/*.tsx', { eager: true }),
  'inspector-tab',
);

export const settingsSections: SettingsSectionDef[] = collect(
  import.meta.glob('./settings-sections/*.tsx', { eager: true }),
  'settings-section',
);

export const sidebarSections: SidebarSectionDef[] = collect(
  import.meta.glob('./sidebar-sections/*.tsx', { eager: true }),
  'sidebar-section',
);
