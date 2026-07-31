import * as approvalRepo from '../db/approvalRepo';
import * as taskRepo from '../db/taskRepo';
import type { Database } from '../db/database';
import type { PermissionDecision, PermissionRequestPayload } from '../../agent/events';
import { decidePermission, deriveAlwaysAllowRule } from './policy';

/**
 * 审批服务（ticket #20）：main 侧的审批回路中枢。
 *
 * 回路：utility permissionHandler（permission-ask，parentPort）→ 本服务
 *   → 策略引擎裁决（policy.ts，三档 + 规则）→
 *   - auto_allow / auto_deny：立即经 utility 回 driver（agent-command permission-respond）；
 *   - ask：登记 pending（首个 pending：running → awaiting_approval），
 *     等 renderer 托盘 IPC（agent:permission-respond → respond()）决议后回 driver
 *     （全部结清：awaiting_approval → running）。
 *
 * fail-closed（ARCHITECTURE §10）贯穿：
 * - 任务不存在/状态不允许等异常路径一律回 deny；
 * - 终止路径（turn_end/session_ended/cancel/utility 崩溃）cancelForTask 清账：
 *   pending 请求回 deny（driver 不再悬挂）+ approvals 行 pending → denied；
 * - driver 层另有 permissionTimeoutMs 超时 deny 兜底（#19 已就位，与本层双保险）。
 *
 * 幂等：重复 respond（双击/重连补发）安全——未知 requestId 一律 no-op。
 * 落库分工：请求/决议行由事件流（agentEvents.ts）落；本服务只写
 *   规则（always_allow_rules）、rule_pattern 标注与终止清账（denyPendingApprovals）。
 */

export interface PendingApproval {
  taskId: string;
  request: PermissionRequestPayload;
  askedAt: number;
}

export interface ApprovalServiceDeps {
  db: Database;
  /** 向 utility 发消息（agent-command 通道）；进程未就绪时应抛错，由调用方捕获 */
  postToAgent: (msg: unknown) => void;
  /** 任务行变更广播（tasks:changed → renderer 重拉） */
  broadcastTasksChanged: () => void;
}

export interface RespondInput {
  taskId: string;
  requestId: string;
  decision: PermissionDecision;
}

export interface ApprovalService {
  /** utility → main：permissionHandler 转发来的审批询问（策略引擎裁决入口） */
  handleAsk: (taskId: string, request: PermissionRequestPayload) => void;
  /** renderer 托盘决议（IPC agent:permission-respond 的唯一入口） */
  respond: (input: RespondInput) => { ok: true; settled: boolean };
  /** 终止路径清账（幂等）：该任务全部 pending 回 deny + 落库 denied */
  cancelForTask: (taskId: string, reason: string) => void;
  /** utility 进程级故障：全部任务清账（cancelForTask 的全量版） */
  cancelAll: (reason: string) => void;
  /** 某任务当前 pending 列表（测试与排障用） */
  listPending: (taskId: string) => PendingApproval[];
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const pending = new Map<string, PendingApproval>();

  const pendingCountForTask = (taskId: string): number => {
    let n = 0;
    for (const p of pending.values()) if (p.taskId === taskId) n += 1;
    return n;
  };

  /** 回 driver 决议（经 utility agent-command；进程未就绪时静默——清账路径不抛错） */
  const postDecision = (taskId: string, requestId: string, decision: PermissionDecision): void => {
    try {
      deps.postToAgent({
        type: 'agent-command',
        command: { kind: 'permission-respond', taskId, requestId, decision },
      });
    } catch (err) {
      console.warn(
        `[approval] 决议回传失败（utility 未就绪；driver 超时 deny 兜底）: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  const handleAsk = (taskId: string, request: PermissionRequestPayload): void => {
    const task = taskRepo.getById(deps.db, taskId);
    if (!task) {
      // fail-closed：任务已消失（取消竞态等），一律拒绝
      postDecision(taskId, request.id, { behavior: 'deny', message: '任务不存在（fail-closed）' });
      return;
    }
    const rules = approvalRepo.listRules(deps.db);
    const verdict = decidePermission(task.permission_mode, rules, request);
    switch (verdict.kind) {
      case 'auto_allow': {
        if (verdict.rulePattern) {
          // 规则命中放行：标注审计（rule_pattern），决议 always=true（与规则语义一致）
          approvalRepo.setApprovalRulePattern(deps.db, request.id, verdict.rulePattern);
          postDecision(taskId, request.id, { behavior: 'allow', always: true });
        } else {
          postDecision(taskId, request.id, { behavior: 'allow', always: false });
        }
        return;
      }
      case 'auto_deny': {
        postDecision(taskId, request.id, { behavior: 'deny', message: verdict.reason });
        return;
      }
      case 'ask': {
        pending.set(request.id, { taskId, request, askedAt: Date.now() });
        // 首个 pending：running → awaiting_approval（状态机把关，幂等——非 running 态不迁）
        if (pendingCountForTask(taskId) === 1 && task.status === 'running') {
          try {
            taskRepo.updateStatus(deps.db, taskId, 'awaiting_approval');
          } catch (err) {
            console.warn(`[approval] 状态迁移跳过: ${err instanceof Error ? err.message : err}`);
          }
        }
        deps.broadcastTasksChanged();
        return;
      }
    }
  };

  const respond = (input: RespondInput): { ok: true; settled: boolean } => {
    const entry = pending.get(input.requestId);
    if (!entry || entry.taskId !== input.taskId) {
      // 幂等：重复决议/陌生请求一律 no-op（不抛错——托盘可重发）
      return { ok: true, settled: false };
    }
    pending.delete(input.requestId);

    const decision: PermissionDecision = {
      behavior: input.decision.behavior,
      // 降级 driver 可能不给 allow_always 选项——钳制，不给就不记忆（防御）；
      // deny 决议不带 always 字段（形状干净，driver 只读 message）
      ...(input.decision.behavior === 'allow'
        ? {
            always: Boolean(input.decision.always) && entry.request.options.includes('allow_always'),
          }
        : {}),
      ...(input.decision.message ? { message: input.decision.message } : {}),
    };

    if (decision.behavior === 'allow' && decision.always) {
      // 「总是允许」：生成工具 + 目标模式规则并持久化（幂等去重）；规则命中标注审计
      const rule = deriveAlwaysAllowRule(entry.request.toolName, entry.request.target);
      approvalRepo.insertRuleIfAbsent(deps.db, rule);
      approvalRepo.setApprovalRulePattern(deps.db, input.requestId, approvalRepo.ruleLabel(rule));
      // suggestions 回写 agent 侧（permissionUpdates）在 driver 层完成（#19 已就位）：
      // decision.always=true + request.suggestions 原样透传即可。
    }

    postDecision(input.taskId, input.requestId, decision);

    // 全部结清：awaiting_approval → running（幂等；并发取消等竞态下状态机把关）
    if (pendingCountForTask(input.taskId) === 0) {
      const task = taskRepo.getById(deps.db, input.taskId);
      if (task?.status === 'awaiting_approval') {
        try {
          taskRepo.updateStatus(deps.db, input.taskId, 'running');
        } catch (err) {
          console.warn(`[approval] 状态迁移跳过: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    deps.broadcastTasksChanged();
    return { ok: true, settled: true };
  };

  const cancelForTask = (taskId: string, reason: string): void => {
    const settled: string[] = [];
    for (const [id, p] of pending) {
      if (p.taskId !== taskId) continue;
      pending.delete(id);
      settled.push(id);
      // driver 可能仍在等回执——立即回 deny（fail-closed 快速结清，不等 120s 超时）
      postDecision(taskId, id, { behavior: 'deny', message: reason });
    }
    if (settled.length > 0) {
      // 落库清账（只动 pending 行；若 driver 随后补发 permission_response 则为同值覆盖，幂等）
      approvalRepo.denyPendingApprovals(deps.db, taskId, reason);
      deps.broadcastTasksChanged();
    }
  };

  const cancelAll = (reason: string): void => {
    const taskIds = new Set<string>();
    for (const p of pending.values()) taskIds.add(p.taskId);
    for (const taskId of taskIds) cancelForTask(taskId, reason);
  };

  return {
    handleAsk,
    respond,
    cancelForTask,
    cancelAll,
    listPending: (taskId) => [...pending.values()].filter((p) => p.taskId === taskId),
  };
}
