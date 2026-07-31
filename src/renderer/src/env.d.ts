/// <reference types="vite/client" />

import type { OpenCoworkApi } from '../../shared/api';

declare global {
  interface Window {
    /** preload contextBridge 暴露的桥 API；纯浏览器环境（无 preload）为 undefined */
    openCowork?: OpenCoworkApi;
  }
}

export {};
