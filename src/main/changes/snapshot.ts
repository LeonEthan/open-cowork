import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CapturedChange } from '../db/fileChangesRepo';
import { createUnifiedDiff, isBinaryBuffer } from './diff';

/**
 * 非 git 目录的快照兜底捕获（ticket #24 / ARCHITECTURE §7）：
 * 任务开始时把工作区拷贝到 <dataDir>/snapshots/<taskId>/baseline/（见 capture.ts），
 * turn_end 后逐文件对比「工作区 vs baseline」，归一为与 git 路径相同的 CapturedChange
 * （unified diff 由 ./diff.ts 自合成，格式与 git 输出对齐）。
 *
 * 忽略规则（默认排除，编排者附注 1）：目录 node_modules/.git/dist，
 * 文件 .DS_Store——快照体积与捕获噪音的主要来源。
 */

export const SNAPSHOT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
]);
export const SNAPSHOT_IGNORE_FILES: ReadonlySet<string> = new Set(['.DS_Store']);

/** 递归枚举文件：rel（posix，相对 root）→ abs。目录不可读/符号链接失效等跳过。 */
export function walkFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop() ?? '';
    const dir = rel ? join(root, rel) : root;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      const childRel = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (!SNAPSHOT_IGNORE_DIRS.has(it.name)) stack.push(childRel);
        continue;
      }
      if (SNAPSHOT_IGNORE_FILES.has(it.name)) continue;
      if (it.isFile() || it.isSymbolicLink()) out.set(childRel, join(dir, it.name));
    }
  }
  return out;
}

/**
 * 任务开始快照：拷贝工作区到 dest（幂等——已存在即跳过，
 * 重复 prepare（追问轮 / 重启后重试）不覆盖首轮基准）。
 * 空工作区也必须落 dest 目录本身：目录存在性即「已快照」标记——
 * 否则捕获时的补建兜底会把 agent 改动后的现场当基准，delta 全丢。
 */
export function createBaseline(root: string, dest: string): void {
  if (existsSync(dest)) return;
  mkdirSync(dest, { recursive: true });
  for (const [rel, abs] of walkFiles(root)) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    try {
      copyFileSync(abs, to);
    } catch (err) {
      console.warn(`[changes] baseline 拷贝失败（跳过）: ${rel} — ${String(err)}`);
    }
  }
}

function readOrNull(abs: string): Buffer | null {
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
}

/**
 * 对比「工作区 vs baseline」归一 CapturedChange。
 * 读取失败的文件跳过（无法安全 diff）；二进制 → diff null。
 */
export function captureSnapshotChanges(root: string, baselineDir: string): CapturedChange[] {
  const current = walkFiles(root);
  const baseline = walkFiles(baselineDir);
  const paths = new Set<string>([...current.keys(), ...baseline.keys()]);
  const out: CapturedChange[] = [];

  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const inCurrent = current.has(path);
    const inBaseline = baseline.has(path);
    const newBuf = inCurrent ? readOrNull(current.get(path) ?? '') : null;
    const oldBuf = inBaseline ? readOrNull(baseline.get(path) ?? '') : null;
    // 存在但读不出来：不参与本轮捕获（防误判为 deleted）
    if ((inCurrent && newBuf === null) || (inBaseline && oldBuf === null)) continue;
    if (newBuf !== null && oldBuf !== null && newBuf.equals(oldBuf)) continue;

    const changeType: CapturedChange['changeType'] = !inBaseline
      ? 'added'
      : !inCurrent
        ? 'deleted'
        : 'modified';
    const sample = newBuf ?? oldBuf;
    if (sample !== null && isBinaryBuffer(sample)) {
      out.push({ path, changeType, diff: null, added: null, removed: null });
      continue;
    }
    const d = createUnifiedDiff(
      path,
      oldBuf === null ? null : oldBuf.toString('utf8'),
      newBuf === null ? null : newBuf.toString('utf8'),
    );
    out.push({ path, changeType, diff: d.text, added: d.added, removed: d.removed });
  }
  return out;
}
