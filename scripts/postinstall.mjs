#!/usr/bin/env node
/**
 * 原生模块双 ABI 处理（ticket #17）
 *
 * 问题：better-sqlite3 / node-pty 是原生模块，ABI 与运行时绑定。
 *   - vitest 跑在 Node 上，需要 Node ABI 二进制；
 *   - 应用跑在 Electron 上，需要 Electron ABI 二进制；
 *   两者落在同一 build/Release 目录会互相覆盖。
 *
 * 方案（prebuild + electron-rebuild）：
 *   1. 复制整包为 node_modules/<pkg>-node/ 作为 Node ABI 副本（供 vitest 用）；
 *      以「能否被当前 Node 实际加载」校验副本 ABI，不行就在副本内就地编译（prebuild-install / node-gyp）。
 *   2. 再用 @electron/rebuild 把原始包重编译为 Electron ABI（供应用 dev/e2e/打包用）。
 *      - `*-node` 副本不在 package.json dependencies 中，electron-rebuild 不会触碰。
 *   3. vitest 通过 vitest.config.ts 的 resolve.alias 把 'better-sqlite3' 指到副本。
 *      （node-pty 为 N-API，单一二进制可跨运行时；better-sqlite3 非 N-API，必须双份。）
 *
 * 验证方式见 README「原生模块」一节。重跑：npm run rebuild:native
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

const NATIVE_PACKAGES = ['better-sqlite3', 'node-pty'];

/** 各包 Node ABI 就地编译命令（在副本目录内执行） */
const NATIVE_BUILD_CMD = {
  'better-sqlite3': 'npx prebuild-install || npx node-gyp rebuild',
  'node-pty': 'node scripts/prebuild.js || npx node-gyp rebuild',
};

/** 该目录下的包能否被当前 Node 实际使用（ABI 校验，比文件存在性可靠）。
 *  注意 better-sqlite3 v12 延迟到实例化时才加载 .node，故对函数型导出要真建一个内存库。 */
function loadableUnderNode(pkgDir) {
  try {
    execSync(
      `node -e "const M=require(process.argv[1]); if (typeof M === 'function') new M(':memory:');" "${pkgDir}"`,
      { stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

function copyForNodeAbi(pkg) {
  const src = join(root, 'node_modules', pkg);
  const dest = join(root, 'node_modules', `${pkg}-node`);
  if (!existsSync(src)) {
    console.warn(`[postinstall] ${pkg} 未安装，跳过 Node ABI 副本`);
    return;
  }
  // 主包可能已被 electron-rebuild 重编译为 Electron ABI，因此不能无条件重拷：
  // 副本已存在、版本一致且能被 Node 加载时直接保留，避免把 Electron ABI 盖进副本
  const srcVersion = require(`${pkg}/package.json`).version;
  const destPkgJson = join(dest, 'package.json');
  const destVersion = existsSync(destPkgJson)
    ? JSON.parse(readFileSync(destPkgJson, 'utf8')).version
    : null;
  if (destVersion !== srcVersion) {
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    console.log(`[postinstall] Node ABI 副本就绪: node_modules/${pkg}-node/`);
  }

  // 自愈：npm 11 allow-scripts 策略/安装中断/主包已被重编译，都可能让副本缺失或携带错误 ABI。
  // 以「能否被当前 Node 加载」为准，不行就在副本内就地编译 Node ABI。
  const build = NATIVE_BUILD_CMD[pkg];
  if (!loadableUnderNode(dest)) {
    console.log(`[postinstall] ${pkg}-node 不可被 Node 加载，就地编译 Node ABI…`);
    try {
      execSync(build, { cwd: dest, stdio: 'inherit' });
    } catch (err) {
      console.warn(`[postinstall] ${pkg}-node Node ABI 编译失败（vitest 若引用 ${pkg} 将受影响）:`, err?.message ?? err);
      return;
    }
    if (!loadableUnderNode(dest)) {
      console.warn(`[postinstall] ${pkg}-node 编译后仍不可被 Node 加载（vitest 若引用 ${pkg} 将受影响）`);
      return;
    }
    console.log(`[postinstall] ${pkg}-node Node ABI 编译完成`);
  }
}

/** electron 二进制兜底：install.js 被中断/拦截会留下残缺 dist（无 path.txt、无 Frameworks）。
 *  检测到残缺就自行重装：@electron/get 取 zip（ELECTRON_MIRROR 环境变量自动继承）→
 *  系统 unzip 解压（绕过 extract-zip 在个别环境下的静默失败）→ 写 path.txt → 上提 electron.d.ts。 */
function ensureElectronDist() {
  const electronDir = join(root, 'node_modules', 'electron');
  if (!existsSync(electronDir)) {
    console.warn('[postinstall] 未找到 electron 包，跳过二进制检查');
    return;
  }
  const platformPath =
    process.platform === 'darwin' || process.platform === 'mas'
      ? 'Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'electron.exe'
        : 'electron';
  const { version } = require('electron/package.json');
  const distDir = join(electronDir, 'dist');
  const healthy =
    existsSync(join(electronDir, 'path.txt')) &&
    existsSync(join(distDir, platformPath)) &&
    existsSync(join(distDir, 'version')) &&
    readFileSync(join(distDir, 'version'), 'utf8').replace(/^v/, '').trim() === version;
  if (healthy) return;

  console.log('[postinstall] electron 安装残缺，自行重装二进制…');
  const script = `
    const path = require('path');
    const { downloadArtifact } = require(path.join(${JSON.stringify(root)}, 'node_modules', '@electron', 'get'));
    downloadArtifact({
      version: ${JSON.stringify(version)},
      artifactName: 'electron',
      checksums: require(path.join(${JSON.stringify(electronDir)}, 'checksums.json')),
      platform: ${JSON.stringify(process.platform)},
      arch: ${JSON.stringify(process.arch)},
    }).then((zip) => { console.log(zip); }).catch((e) => { console.error(e); process.exit(1); });
  `;
  try {
    const zip = execSync(`node -e ${JSON.stringify(script)}`, { encoding: 'utf8' }).trim().split('\n').pop();
    rmSync(distDir, { recursive: true, force: true });
    execSync(`unzip -q ${JSON.stringify(zip)} -d ${JSON.stringify(distDir)}`);
    const typeDefSrc = join(distDir, 'electron.d.ts');
    if (existsSync(typeDefSrc)) {
      cpSync(typeDefSrc, join(electronDir, 'electron.d.ts'));
      rmSync(typeDefSrc, { force: true });
    }
    writeFileSync(join(electronDir, 'path.txt'), platformPath);
    console.log('[postinstall] electron 二进制重装完成');
  } catch (err) {
    console.warn('[postinstall] electron 二进制重装失败（可设 ELECTRON_MIRROR 后重跑 npm run rebuild:native）:', err?.message ?? err);
  }
}

async function rebuildForElectron() {
  let electronVersion;
  try {
    electronVersion = require('electron/package.json').version;
  } catch {
    console.warn('[postinstall] 未找到 electron，跳过 Electron ABI 重编译');
    return;
  }
  const { rebuild } = await import('@electron/rebuild');
  try {
    await rebuild({
      buildPath: root,
      electronVersion,
      arch: process.arch,
      onlyModules: [...NATIVE_PACKAGES],
      force: true,
    });
    console.log(`[postinstall] Electron ABI 重编译完成 (electron ${electronVersion}, ${process.arch})`);
  } catch (err) {
    console.warn('[postinstall] electron-rebuild 失败，尝试 better-sqlite3 electron prebuild 兜底：', err?.message ?? err);
    // 兜底：better-sqlite3 官方发布 electron prebuild，无需本地编译工具链
    try {
      execSync(`npx prebuild-install --runtime electron --target ${electronVersion}`, {
        cwd: join(root, 'node_modules', 'better-sqlite3'),
        stdio: 'inherit',
      });
      console.log('[postinstall] better-sqlite3 Electron ABI prebuild 兜底成功');
    } catch (fallbackErr) {
      console.warn('[postinstall] better-sqlite3 兜底失败（应用内 SQLite 将不可用）:', fallbackErr?.message ?? fallbackErr);
    }
    console.warn('[postinstall] 注：node-pty 为 N-API（ABI 稳定），通常不受 rebuild 失败影响');
  }
}

for (const pkg of NATIVE_PACKAGES) copyForNodeAbi(pkg);
ensureElectronDist();
await rebuildForElectron();
