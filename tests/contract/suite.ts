import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentDriver, AgentEvent, AlwaysAllowRule, DriverStartParams, PermissionDecision, PermissionRequestPayload } from '../../src/agent/events';

/**
 * 表驱动 contract 测试套件（ticket #19，测试接缝 1 的消费端）。
 *
 * 每个 driver 跑同一组用例（本票只有 claude 一家；#22 codex/opencode、#23 pi
 * 新增 driver 时只需在本文件底部的 DRIVER_MATRIX 追加一行 + 对应 fake 脚本格式）。
 *
 * 用例表（票面要求）：
 *  1. 会话生命周期：start → session_started → turn_end → done(completed)；
 *  2. 事件归一：text_delta / thinking_delta / tool_call(running→done|error) /
 *     permission_request→response / usage / turn_end 每类至少一例；
 *  3. 取消：运行中 cancel → 进程终止 + turn_end(cancelled) + done(cancelled)；
 *  4. 异常退出 → failed（含原因）；
 *  5. 流式分片边界：多分片 text_delta 顺序拼接 = 原文。
 *
 * 驱动方式：fake agent harness（tests/fake-agent/）按 JSONL 脚本输出 wire 格式；
 * driver 以真实 CLI 调用方式 spawn 它（executablePath 注入）。
 */

/** 被测 driver 的装配描述（每家一行） */
export interface DriverHarnessEntry {
  /** driver id（与注册表一致） */
  id: string;
  /** 创建 driver 实例 */
  create: () => AgentDriver;
  /** 拼装该 driver 的 start 参数（cwd/prompt 由用例给，这里给 wire 格式接线） */
  makeParams: (scriptPath: string) => Partial<DriverStartParams>;
  /**
   * 审批能力（ticket #23 additive）：缺省 'native'（有运行时审批 wire，跑原生审批用例）；
   * 'degraded'（pi——无审批 wire，审批走启动期静态策略）跳过原生审批用例，
   * 静态策略覆盖在各家的 contract 文件内（翻译纯函数 + 启动旗标断言）。
   */
  approval?: 'native' | 'degraded';
}

export interface CollectedEvents {
  events: AgentEvent[];
  byType: <T extends AgentEvent['type']>(type: T) => Extract<AgentEvent, { type: T }>[];
}

export function writeScript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-contract-'));
  const file = join(dir, 'script.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

/** 跑一个会话并收集全部归一事件（timeoutMs 兜底防挂死） */
export async function runSession(
  entry: DriverHarnessEntry,
  scriptPath: string,
  opts: {
    prompt?: string;
    permissionDecision?: PermissionDecision;
    /** ticket #20：自定义审批钩子（fail-closed 用例：抛错/永不决议）；缺省回 permissionDecision 桩 */
    permissionHandler?: (req: PermissionRequestPayload) => Promise<PermissionDecision>;
    /** ticket #20：审批等待超时（毫秒，超时=deny fail-closed）；缺省 driver 默认 120s */
    permissionTimeoutMs?: number;
    /** ticket #31（additive）：注入「总是允许」规则集（driver 层规则预过滤用例）；缺省空 */
    alwaysAllowRules?: AlwaysAllowRule[];
    afterStart?: (session: {
      cancel: () => Promise<void>;
      sendFollowup: (text: string) => Promise<void>;
    }) => void;
    /** 每个归一事件到达时的钩子（可驱动追问/取消，免去裸 sleep） */
    onEvent?: (
      event: AgentEvent,
      session: { cancel: () => Promise<void>; sendFollowup: (text: string) => Promise<void> },
    ) => void;
    timeoutMs?: number;
  } = {},
): Promise<{ collected: CollectedEvents; end: { reason: string; error?: string } }> {
  const events: AgentEvent[] = [];
  const driver = entry.create();
  const sessionRef: { current: Parameters<NonNullable<typeof opts.onEvent>>[1] | null } = {
    current: null,
  };
  const session = driver.start(
    {
      taskId: `contract-${entry.id}`,
      prompt: opts.prompt ?? '测试需求',
      cwd: process.cwd(),
      model: null,
      ...entry.makeParams(scriptPath),
      permissionHandler:
        opts.permissionHandler ??
        (async () => opts.permissionDecision ?? { behavior: 'allow' }),
      ...(typeof opts.permissionTimeoutMs === 'number'
        ? { permissionTimeoutMs: opts.permissionTimeoutMs }
        : {}),
      ...(opts.alwaysAllowRules ? { alwaysAllowRules: opts.alwaysAllowRules } : {}),
    },
    (e) => {
      events.push(e);
      if (sessionRef.current) opts.onEvent?.(e, sessionRef.current);
    },
  );
  sessionRef.current = session;
  opts.afterStart?.(session);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const end = await Promise.race([
    session.done,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`会话超时（${timeoutMs}ms）未结束`)), timeoutMs),
    ),
  ]);
  return {
    collected: {
      events,
      byType: (type) => events.filter((e) => e.type === type) as never,
    },
    end,
  };
}

/** 共享用例组：entry 由各家测试文件注入 */
export function defineContractSuite(entry: DriverHarnessEntry): void {
  describe(`contract: ${entry.id}`, () => {
    it('会话生命周期：session_started → turn_end(completed) → done(completed)', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        { action: 'emit', event: { kind: 'text', text: '你好' } },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed', result: 'done' } },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script);
      expect(end.reason).toBe('completed');
      const types = collected.events.map((e) => e.type);
      expect(types[0]).toBe('session_started');
      expect(types).toContain('turn_end');
      expect(types.indexOf('session_started')).toBeLessThan(types.indexOf('turn_end'));
      const started = collected.byType('session_started')[0];
      expect(started.sessionId).toBeTruthy();
    });

    it('事件归一：text/thinking/tool_call/usage 全类覆盖', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        { action: 'emit', event: { kind: 'thinking', text: '先想一下' } },
        { action: 'emit', event: { kind: 'text', text: '# 标题\n正文' } },
        { action: 'emit', event: { kind: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } } },
        { action: 'emit', event: { kind: 'tool_result', id: 'toolu_1', output: 'all green' } },
        { action: 'emit', event: { kind: 'tool_call', id: 'toolu_2', name: 'Edit', input: { file_path: '/tmp/a.ts' } } },
        { action: 'emit', event: { kind: 'tool_result', id: 'toolu_2', output: 'boom', isError: true } },
        {
          action: 'emit',
          event: { kind: 'turn_end', status: 'completed', usage: { inputTokens: 11, outputTokens: 22 } },
        },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script);
      expect(end.reason).toBe('completed');

      const thinking = collected.byType('thinking_delta').map((e) => e.delta).join('');
      expect(thinking).toBe('先想一下');
      const text = collected.byType('text_delta').map((e) => e.delta).join('');
      expect(text).toBe('# 标题\n正文');

      const calls = collected.byType('tool_call');
      const bashStart = calls.find((c) => c.call.id === 'toolu_1' && c.call.status === 'running');
      expect(bashStart?.call.name).toBe('Bash');
      expect(bashStart?.call.target).toBe('npm test');
      const bashDone = calls.find((c) => c.call.id === 'toolu_1' && c.call.status === 'done');
      expect(bashDone?.call.output).toBe('all green');
      const editErr = calls.find((c) => c.call.id === 'toolu_2' && c.call.status === 'error');
      expect(editErr?.call.target).toBe('/tmp/a.ts');

      const usage = collected.byType('usage')[0];
      expect(usage.usage.inputTokens).toBe(11);
      expect(usage.usage.outputTokens).toBe(22);
    });

    // #23：degraded driver（pi）无运行时审批 wire——原生审批用例跳过，
    // 审批覆盖走启动期静态策略路径（各家 contract 文件内的翻译/旗标断言）
    const nativeApproval = entry.approval !== 'degraded';

    // ── ticket #27：用量归一断言（共享套件——每家 driver 入组即被本用例覆盖）──

    it('用量归一：usage 事件字段齐全且数值正确，且先于 turn_end 到达', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        { action: 'emit', event: { kind: 'text', text: '干活' } },
        {
          action: 'emit',
          event: {
            kind: 'turn_end',
            status: 'completed',
            usage: {
              inputTokens: 1200,
              outputTokens: 340,
              cacheReadTokens: 800,
              cacheWriteTokens: 50,
              model: 'fake-model-1',
            },
          },
        },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script);
      expect(end.reason).toBe('completed');

      const usages = collected.byType('usage');
      expect(usages).toHaveLength(1);
      const u = usages[0].usage;
      expect(u.inputTokens).toBe(1200);
      expect(u.outputTokens).toBe(340);
      expect(u.cacheReadTokens).toBe(800);
      expect(u.cacheWriteTokens).toBe(50);
      expect(u.model).toBe('fake-model-1');

      // 结算顺序约定：usage 先于 turn_end（main 侧先落用量再迁移任务状态）
      const types = collected.events.map((e) => e.type);
      expect(types.indexOf('usage')).toBeGreaterThan(-1);
      expect(types.indexOf('usage')).toBeLessThan(types.lastIndexOf('turn_end'));
    });

    it('用量归一：turn_end 缺 usage 载荷时仍归一出零值 usage（口径不缺失）', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        { action: 'emit', event: { kind: 'text', text: '无用量一轮' } },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script);
      expect(end.reason).toBe('completed');
      const usage = collected.byType('usage')[0];
      expect(usage).toBeTruthy();
      expect(typeof usage.usage.inputTokens).toBe('number');
      expect(typeof usage.usage.outputTokens).toBe('number');
    });

    if (nativeApproval) {
      it('事件归一：permission_request → handler → permission_response（allow 与 deny）', async () => {
      for (const decision of [
        { behavior: 'allow' } as PermissionDecision,
        { behavior: 'deny', message: '太危险' } as PermissionDecision,
      ]) {
        const script = writeScript([
          { action: 'expect_stdin' },
          {
            action: 'emit',
            event: {
              kind: 'permission_request',
              id: 'perm_1',
              toolName: 'Bash',
              input: { command: 'rm -rf build' },
              reason: '需要删除构建产物',
            },
          },
          { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
          { action: 'exit', code: 0 },
        ]);
        const { collected, end } = await runSession(entry, script, {
          permissionDecision: decision,
        });
        expect(end.reason).toBe('completed');
        const req = collected.byType('permission_request')[0];
        expect(req.request.toolName).toBe('Bash');
        expect(req.request.target).toBe('rm -rf build');
        expect(req.request.reason).toBe('需要删除构建产物');
        expect(req.request.options).toContain('allow_always');
        const res = collected.byType('permission_response')[0];
        expect(res.requestId).toBe(req.request.id);
        expect(res.decision.behavior).toBe(decision.behavior);
        if (decision.behavior === 'deny') expect(res.decision.message).toBe('太危险');
      }
      });
    }

    it('取消：运行中 cancel → turn_end(cancelled) + done(cancelled)，进程终止', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        { action: 'emit', event: { kind: 'text', text: '开始长篇输出' } },
        { action: 'sleep', ms: 60_000 }, // 挂住等待被取消
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script, {
        onEvent: (event, session) => {
          // 首批流式事件到达（= 运行中）即取消
          if (event.type === 'text_delta') void session.cancel();
        },
      });
      expect(end.reason).toBe('cancelled');
      const turnEnds = collected.byType('turn_end');
      expect(turnEnds.some((t) => t.status === 'cancelled')).toBe(true);
    });

    it('异常退出：非零 exit → error(fatal) + turn_end(failed) + done(failed)', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        { action: 'emit', event: { kind: 'text', text: '跑到一半' } },
        { action: 'exit', code: 1 },
      ]);
      const { collected, end } = await runSession(entry, script);
      expect(end.reason).toBe('failed');
      expect(end.error).toBeTruthy();
      expect(collected.byType('turn_end').some((t) => t.status === 'failed')).toBe(true);
    });

    it('异常归一：agent 报 error result → turn_end(failed) 带原因', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        { action: 'emit', event: { kind: 'error', message: 'API 限流了' } },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script);
      expect(end.reason).toBe('completed'); // 进程正常退出；失败语义在轮次上
      const turnEnd = collected.byType('turn_end')[0];
      expect(turnEnd.status).toBe('failed');
      expect(turnEnd.reason).toBeTruthy();
    });

    it('流式分片边界：多分片 text_delta 顺序拼接 = 原文（含空文本）', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        { action: 'emit', event: { kind: 'text', text: '分片一分片二分片三', chunks: 5 } },
        { action: 'emit', event: { kind: 'thinking', text: '甲乙丙丁戊', chunks: 4 } },
        { action: 'emit', event: { kind: 'text', text: '尾段' } },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      const { collected } = await runSession(entry, script);
      const text = collected.byType('text_delta').map((e) => e.delta).join('');
      expect(text).toBe('分片一分片二分片三尾段');
      const thinking = collected.byType('thinking_delta').map((e) => e.delta).join('');
      expect(thinking).toBe('甲乙丙丁戊');
    });

    it('多轮会话：followup 复用同一会话推进第二轮', async () => {
      const script = writeScript([
        { action: 'expect_stdin', match: '第一轮' },
        { action: 'emit', event: { kind: 'text', text: '第一轮回复' } },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'expect_stdin', match: '第二轮' },
        { action: 'emit', event: { kind: 'text', text: '第二轮回复' } },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      let followedUp = false;
      const { collected, end } = await runSession(entry, script, {
        prompt: '第一轮需求',
        onEvent: (event, session) => {
          // 第一轮 turn_end 到达后精确追问一次（事件驱动，无裸 sleep）
          if (!followedUp && event.type === 'turn_end') {
            followedUp = true;
            void session.sendFollowup('第二轮追问');
          }
        },
      });
      expect(followedUp).toBe(true);
      expect(end.reason).toBe('completed');
      expect(collected.byType('turn_end')).toHaveLength(2);
      const text = collected.byType('text_delta').map((e) => e.delta).join('');
      expect(text).toBe('第一轮回复第二轮回复');
    });

    // ── ticket #20：审批 fail-closed 与回执形状（fake 脚本 expectResponse 做 wire 级断言）──
    // #23：degraded driver（pi）无审批 wire，以下原生用例跳过（静态策略路径覆盖审批面）

    if (nativeApproval) {
      it('审批 fail-closed：handler 抛错 → deny 且理由回传 agent（ARCHITECTURE §10）', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        {
          action: 'emit',
          event: {
            kind: 'permission_request',
            id: 'perm_throw',
            toolName: 'Bash',
            input: { command: 'rm -rf build' },
            // wire 级断言：agent 实际收到 deny + 原始错误消息
            expectResponse: { behavior: 'deny', message: '审批链路炸了' },
          },
        },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script, {
        permissionHandler: async () => {
          throw new Error('审批链路炸了');
        },
      });
      // fake 内 expectResponse 断言通过才会走到 turn_end（否则脚本失败非零退出 → failed）
      expect(end.reason).toBe('completed');
      const res = collected.byType('permission_response')[0];
      // 归一 requestId 由 driver 生成（与 wire request_id 不同源）——对应关系经
      // permission_request 事件 id 断言，wire 级正确性由 fake 的 expectResponse 保证
      const req = collected.byType('permission_request')[0];
      expect(res.requestId).toBe(req.request.id);
      expect(res.decision.behavior).toBe('deny');
      expect(res.decision.message).toBe('审批链路炸了');
    });

    it('审批 fail-closed：handler 永不决议 → permissionTimeoutMs 超时 deny', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        {
          action: 'emit',
          event: {
            kind: 'permission_request',
            id: 'perm_slow',
            toolName: 'Bash',
            input: { command: 'npm test' },
            expectResponse: { behavior: 'deny' },
          },
        },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script, {
        permissionTimeoutMs: 300,
        permissionHandler: () => new Promise<PermissionDecision>(() => {}), // 悬挂
      });
      expect(end.reason).toBe('completed');
      const res = collected.byType('permission_response')[0];
      expect(res.decision.behavior).toBe('deny');
      expect(res.decision.message).toContain('超时');
    });

    it('审批回执形状：allow_once 不带 updatedPermissions；allow_always + suggestions 原样回写', async () => {
      // destination='session'：session 目的地是各家都放行的最小公分母——
      // claude 对非 session 目的地有过滤白名单（audit phase-g，不碰全局红线），
      // 非 session 目的地的丢弃行为见 claude.contract.test.ts 专备用例。
      const SUGGESTIONS = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm *' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];
      // allow_once：回执允许但不回写任何权限
      {
        const script = writeScript([
          { action: 'expect_stdin' },
          {
            action: 'emit',
            event: {
              kind: 'permission_request',
              id: 'perm_once',
              toolName: 'Bash',
              input: { command: 'npm install' },
              suggestions: SUGGESTIONS,
              expectResponse: { behavior: 'allow', updatedPermissions: null },
            },
          },
          { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
          { action: 'exit', code: 0 },
        ]);
        const { collected, end } = await runSession(entry, script, {
          permissionDecision: { behavior: 'allow' },
        });
        expect(end.reason).toBe('completed');
        expect(collected.byType('permission_response')[0].decision).toEqual({ behavior: 'allow' });
      }
      // allow_always：suggestions 经 updatedPermissions 原样回写 agent 侧（ARCHITECTURE §6）
      {
        const script = writeScript([
          { action: 'expect_stdin' },
          {
            action: 'emit',
            event: {
              kind: 'permission_request',
              id: 'perm_always',
              toolName: 'Bash',
              input: { command: 'npm install' },
              suggestions: SUGGESTIONS,
              expectResponse: { behavior: 'allow', updatedPermissions: SUGGESTIONS },
            },
          },
          { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
          { action: 'exit', code: 0 },
        ]);
        const { collected, end } = await runSession(entry, script, {
          permissionDecision: { behavior: 'allow', always: true },
        });
        expect(end.reason).toBe('completed');
        expect(collected.byType('permission_response')[0].decision).toEqual({
          behavior: 'allow',
          always: true,
        });
      }
      });
    }

    // ── ticket #31（additive）：多行命令的规则匹配安全语义 ──
    // 匹配层正确性的 driver 侧保证：permission_request payload.input 携带完整未截断
    // 命令（首行/截断投影只在 target 展示字段）；driver 层规则预过滤用完整命令，
    // 首行命中的规则不得放行多行全文，逐行全命中才 auto_allow。

    if (nativeApproval) {
      it('#31：permission_request payload.input 保留完整多行命令（不截断不投影）', async () => {
      const FULL = 'npm install\nrm -rf ~';
      const script = writeScript([
        { action: 'expect_stdin' },
        {
          action: 'emit',
          event: {
            kind: 'permission_request',
            id: 'perm_multiline',
            toolName: 'Bash',
            input: { command: FULL },
            reason: '多行命令',
          },
        },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      const { collected, end } = await runSession(entry, script);
      expect(end.reason).toBe('completed');
      const req = collected.byType('permission_request')[0];
      // 核心断言：完整多行命令原样进 payload.input（匹配层的输入保证）
      expect((req.request.input as { command?: unknown } | null)?.command).toBe(FULL);
      // target 是展示投影，形状各家不同（claude/codex 取首行；opencode/acp 持 wire 原文）——
      // 两种形态都合法，因为它永不进匹配链（#31 后匹配一律从 input 取完整文本）
      expect(req.request.target === 'npm install' || req.request.target === FULL).toBe(true);
      const res = collected.byType('permission_response')[0];
      expect(res.decision.behavior).toBe('allow');
      });

      it('#31 绕过剧本：首行命中的精确规则不得放行多行命令（降级 handler 逐条决议）', async () => {
      const FULL = 'npm install\nrm -rf ~';
      const script = writeScript([
        { action: 'expect_stdin' },
        {
          action: 'emit',
          event: {
            kind: 'permission_request',
            id: 'perm_bypass',
            toolName: 'Bash',
            input: { command: FULL },
            reason: '多行命令',
          },
        },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      let handlerCalls = 0;
      const { collected, end } = await runSession(entry, script, {
        // 只命中首行的无通配精确规则——修复前会 auto_allow 整段多行命令
        alwaysAllowRules: [{ tool: 'Bash', targetPattern: 'npm install' }],
        permissionHandler: async () => {
          handlerCalls += 1;
          return { behavior: 'allow' }; // 模拟用户逐条批准一次
        },
      });
      expect(end.reason).toBe('completed');
      // 修复核心：规则不得 auto_allow——必须降级到 handler（托盘逐条审批）
      expect(handlerCalls).toBe(1);
      const res = collected.byType('permission_response')[0];
      expect(res.decision).toEqual({ behavior: 'allow' }); // allow_once：无 always 字段
      });

      it('#31 多行全命中：每一行都命中同一条通配规则才 auto_allow（不调 handler）', async () => {
      const script = writeScript([
        { action: 'expect_stdin' },
        {
          action: 'emit',
          event: {
            kind: 'permission_request',
            id: 'perm_all_hit',
            toolName: 'Bash',
            input: { command: 'npm install\nnpm test' },
            reason: '多行命令',
          },
        },
        { action: 'emit', event: { kind: 'turn_end', status: 'completed' } },
        { action: 'exit', code: 0 },
      ]);
      let handlerCalls = 0;
      const { collected, end } = await runSession(entry, script, {
        alwaysAllowRules: [{ tool: 'Bash', targetPattern: 'npm *' }],
        permissionHandler: async () => {
          handlerCalls += 1;
          return { behavior: 'deny', message: '不应到达（规则应直放）' };
        },
      });
      expect(end.reason).toBe('completed');
      expect(handlerCalls).toBe(0); // 规则直放，不打扰用户
      const res = collected.byType('permission_response')[0];
      expect(res.decision).toEqual({ behavior: 'allow', always: true });
      });
    }
  });
}
