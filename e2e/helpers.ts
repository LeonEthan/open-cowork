import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * ticket #36：e2e 共享 helper——建任务流程从侧栏表单迁移到首页 composer。
 *
 * 旧流程（已退场）：new-task-toggle → new-task-form（task-workspace-select /
 * task-prompt-input / task-agent-select / task-create-submit）。
 * 新流程：new-task-toggle（聚焦中区 composer）→（可选）agent-model-picker-toggle
 * 打开合并 picker（task-agent-select / task-provider-select / task-model-select
 * 保留在弹出层内）→ composer-input 输入 → send-button 发送
 * = createTask + agent.start 一步到位（创建即开跑）。
 */

/** 添加 workspace（bridge 直给路径，原生 dialog 不可驱动）并 reload 让侧栏见效 */
export async function addWorkspaceViaBridge(win: Page, wsDir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await window.openCowork?.workspaces.addByPath(p);
  }, wsDir);
  await win.reload();
  await expect(win.getByTestId('workspace-item')).toHaveCount(1);
}

/** 侧栏「新建任务」功能行 → 文档视图 + 取消任务选中 + 聚焦首页 composer */
export async function focusHomeComposer(win: Page): Promise<void> {
  await win.getByTestId('new-task-toggle').click();
  await expect(win.getByTestId('composer-input')).toBeVisible();
}

/** 打开动作行右侧的 agent+provider+model 合并 picker 弹出层 */
export async function openAgentModelPicker(win: Page): Promise<void> {
  await win.getByTestId('agent-model-picker-toggle').click();
  await expect(win.getByTestId('task-agent-select')).toBeVisible();
}

/** 关闭合并 picker 弹出层（再次点击 toggle） */
export async function closeAgentModelPicker(win: Page): Promise<void> {
  await win.getByTestId('agent-model-picker-toggle').click();
  await expect(win.getByTestId('agent-model-popover')).toHaveCount(0);
}

export interface ComposerTaskOpts {
  prompt: string;
  /** task-agent-select 的 option value（缺省 = 探测回填的第一个可用 agent） */
  agent?: string;
  /** task-provider-select 的 value 或 { label }（缺省 = agent 默认 provider） */
  provider?: string | { label: string };
  /** task-model-select 的 value（缺省 = 默认 model） */
  model?: string;
  /** 选择 model 前等待 model 下拉的 option 总数（清单异步加载） */
  awaitModelOptions?: number;
  /** 选择 model 前等待指定 value 的 option 出现 */
  awaitModelValue?: string;
  /** 上下文行 worktree chip 切到「worktree 隔离」（git workspace 才可用） */
  worktree?: boolean;
  /** 发送前设定权限档位（附录 B 弹层：chip → radio 选项；缺省不动 = auto） */
  permissionMode?: 'readonly' | 'auto' | 'full';
}

/**
 * 经首页 composer 建任务并开跑（create+start 一步到位）：
 * 聚焦 composer →（按需）合并 picker 选择 agent/provider/model →（按需）worktree chip /
 * 权限档位 → 输入需求 → 发送；断言侧栏出现任务行即返回（状态迁移由调用方继续断言）。
 */
export async function createTaskViaComposer(win: Page, opts: ComposerTaskOpts): Promise<void> {
  await focusHomeComposer(win);
  if (opts.agent || opts.provider || opts.model) {
    await openAgentModelPicker(win);
    const select = win.getByTestId('task-agent-select');
    await expect(select).toBeEnabled({ timeout: 10_000 });
    if (opts.agent) await select.selectOption(opts.agent);
    if (opts.provider) await win.getByTestId('task-provider-select').selectOption(opts.provider);
    if (opts.awaitModelOptions) {
      await expect(win.getByTestId('task-model-select').locator('option')).toHaveCount(
        opts.awaitModelOptions,
        { timeout: 10_000 },
      );
    }
    if (opts.awaitModelValue) {
      await expect(
        win.getByTestId('task-model-select').locator(`option[value="${opts.awaitModelValue}"]`),
      ).toHaveCount(1, { timeout: 10_000 });
    }
    if (opts.model) await win.getByTestId('task-model-select').selectOption(opts.model);
    await closeAgentModelPicker(win);
  }
  if (opts.worktree) {
    const chip = win.getByTestId('composer-worktree-toggle');
    // git workspace：worktree chip 可用（探测经 IPC，自动等待 enabled）
    await expect(chip).toBeEnabled();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  }
  if (opts.permissionMode) {
    // 附录 B：chip 点击展开 radio 弹层，选定档位后弹层自闭
    await win.getByTestId('permission-mode-chip').click();
    await win
      .locator(`[data-testid="permission-mode-option"][data-mode="${opts.permissionMode}"]`)
      .click();
    await expect(win.getByTestId('permission-mode-chip')).toHaveAttribute(
      'data-mode',
      opts.permissionMode,
    );
  }
  await win.getByTestId('composer-input').fill(opts.prompt);
  const send = win.getByTestId('send-button');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(win.getByTestId('task-item')).toHaveCount(1);
}
