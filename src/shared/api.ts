/**
 * preload 暴露给 renderer 的 API 形状（contextBridge）。
 * renderer 侧通过 window.openCowork 访问；类型声明见 src/renderer/src/env.d.ts。
 */
export interface OpenCoworkApi {
  /** 请求建立 renderer ⇄ utility 的 MessageChannel 直连；port 经 window 'message' 事件送达 */
  requestAgentPort: () => void;
  /** 应用数据根目录（OPEN_COWORK_DATA_DIR 覆盖后的实际值） */
  getDataDir: () => Promise<string>;
  platform: string;
  versions: { electron: string; chrome: string; node: string };

  // ── ticket #28: 内置终端 tab ─────────────────────────────────────────
  /** 创建（或复用）per-task 终端会话；key=taskId 或 'global'；懒启动——首次调用才起 shell */
  ptyCreate: (
    key: string,
    cols: number,
    rows: number,
  ) => Promise<{ ok: boolean; cwd: string; created: boolean }>;
  ptyWrite: (key: string, data: string) => void;
  ptyResize: (key: string, cols: number, rows: number) => void;
  ptyDispose: (key: string) => void;
  /** 订阅会话输出 / 退出；均返回取消订阅函数 */
  onPtyData: (key: string, cb: (data: string) => void) => () => void;
  onPtyExit: (key: string, cb: (exitCode: number) => void) => () => void;
  // ── ticket #28 end ────────────────────────────────────────────────────
}
