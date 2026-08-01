import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './hooks/useTheme';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/usage.css'; // ticket #27（additive 独立样式文件）

// 首帧主题（DESIGN.md §6）：index.html 的 data-theme="light" 只是静态兜底——
// render 之前同步按记忆偏好/系统主题改写，避免深色用户闪一帧浅色首绘。
applyTheme();

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
