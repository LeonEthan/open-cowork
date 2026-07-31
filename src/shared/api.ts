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
}
