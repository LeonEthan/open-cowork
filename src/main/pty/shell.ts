/**
 * 登录 shell 解析（ticket #28 内置终端）。
 * macOS / Linux：起登录 shell（-l，加载用户 profile，PATH 与交互式体验一致），
 * 读 SHELL 环境变量，macOS 兜底 /bin/zsh、Linux 兜底 /bin/bash。
 * Windows 非 MVP 优先平台，给最小可用分支，不为其妥协设计（ARCHITECTURE §1）。
 */
export interface ShellSpec {
  file: string;
  args: string[];
}

export function resolveLoginShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellSpec {
  if (platform === 'win32') {
    return { file: env.ComSpec?.trim() || 'powershell.exe', args: [] };
  }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const file = env.SHELL?.trim() || fallback;
  return { file, args: ['-l'] };
}
