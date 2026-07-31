/**
 * 统一 diff 生成（ticket #24，stdlib 零依赖）。
 *
 * 非 git 快照兜底与 git untracked 内容的 diff 文本都由本模块产出，
 * 格式对齐 git unified diff（`diff --git` 头 + `@@` hunk），
 * 供 FileChange.diff 与检查栏内嵌渲染统一消费（ARCHITECTURE §7 归一）。
 *
 * 算法：Myers O(ND) 逐行 diff（trace 回溯，Int32Array 省内存）。
 * 有界保障（大文件不炸）：行数 N+M > 4000 或编辑距离 D > 1500 时
 * 退化为「整文件替换」单 hunk（旧行全删 + 新行全增）——结果仍是合法 diff，
 * 只是不再最小。语义由 tests/diff.test.ts 锁定。
 *
 * 简化约定：不产出「\ No newline at end of file」标记（呈现层无需此精度）。
 */

export interface UnifiedDiffResult {
  /** unified diff 文本（末尾带换行；无 hunk 时仅头部） */
  text: string;
  /** hunk 内 '+' 行数 */
  added: number;
  /** hunk 内 '-' 行数 */
  removed: number;
}

const MAX_LINES_TOTAL = 4000;
const MAX_EDIT_DISTANCE = 1500;
const CONTEXT = 3;

type Op = 'keep' | 'del' | 'ins';

/** 文本 → 行数组；末尾换行符不产生末尾空行（空文本 = 零行） */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** git 风格 diff 文本的 +/- 行统计（跳过 ---/+++ 文件头） */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

/** 二进制探测：前 8000 字节内含 NUL 即视为二进制（diff 置 NULL 的依据） */
export function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Myers O(ND) 编辑脚本；D 超上限返回 null（调用方退化整文件替换） */
function myersOps(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const width = 2 * max + 1;
  const offset = max;
  let v = new Int32Array(width);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    const cur = new Int32Array(width);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      cur[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(cur);
    if (found >= 0) break;
    if (d + 1 > MAX_EDIT_DISTANCE) return null;
    v = cur;
  }
  if (found < 0) return null;

  // 回溯出逐行编辑脚本（逆序追加后翻转）
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('keep');
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push('ins');
      y--;
    } else {
      ops.push('del');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('keep');
    x--;
    y--;
  }
  while (x > 0) {
    ops.push('del');
    x--;
  }
  while (y > 0) {
    ops.push('ins');
    y--;
  }
  ops.reverse();
  return ops;
}

interface Hunk {
  aStart: number; // 0-based 起始行（a 侧）
  aLen: number;
  bStart: number;
  bLen: number;
  lines: string[];
}

/** 编辑脚本 → hunk 列表（上下文 3 行；相邻变更间隔 ≤ 2*CONTEXT 合并为一个 hunk） */
function buildHunks(a: string[], b: string[], ops: Op[]): Hunk[] {
  const aIdx = new Array<number>(ops.length);
  const bIdx = new Array<number>(ops.length);
  let ai = 0;
  let bi = 0;
  for (let i = 0; i < ops.length; i++) {
    aIdx[i] = ai;
    bIdx[i] = bi;
    if (ops[i] !== 'ins') ai++;
    if (ops[i] !== 'del') bi++;
  }

  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] !== 'keep') changeIdx.push(i);
  }
  if (changeIdx.length === 0) return [];

  const groups: Array<[number, number]> = [];
  let gStart = changeIdx[0];
  let gEnd = changeIdx[0];
  for (let i = 1; i < changeIdx.length; i++) {
    const idx = changeIdx[i];
    if (idx - gEnd > 2 * CONTEXT) {
      groups.push([gStart, gEnd]);
      gStart = idx;
    }
    gEnd = idx;
  }
  groups.push([gStart, gEnd]);

  return groups.map(([s, e]) => {
    const from = Math.max(0, s - CONTEXT);
    const to = Math.min(ops.length, e + CONTEXT + 1);
    const lines: string[] = [];
    let aLen = 0;
    let bLen = 0;
    for (let i = from; i < to; i++) {
      const op = ops[i];
      if (op === 'keep') {
        lines.push(` ${a[aIdx[i]]}`);
        aLen++;
        bLen++;
      } else if (op === 'del') {
        lines.push(`-${a[aIdx[i]]}`);
        aLen++;
      } else {
        lines.push(`+${b[bIdx[i]]}`);
        bLen++;
      }
    }
    return { aStart: aIdx[from], aLen, bStart: bIdx[from], bLen, lines };
  });
}

/** git 风格的区间格式：len==1 省略 ",1"；len==0 时 start 指向前一行（0-based） */
function fmtRange(start: number, len: number): string {
  if (len === 1) return `${start + 1}`;
  return `${len === 0 ? start : start + 1},${len}`;
}

/**
 * 生成 unified diff（git 格式头部，路径经 a/ b/ 前缀）。
 * oldText=null → 新增文件（--- /dev/null）；newText=null → 删除文件（+++ /dev/null）。
 * 两侧同内容时返回仅头部的文本（调用方一般不会这样用——无差异不入列）。
 */
export function createUnifiedDiff(
  path: string,
  oldText: string | null,
  newText: string | null,
): UnifiedDiffResult {
  const a = oldText === null ? [] : splitLines(oldText);
  const b = newText === null ? [] : splitLines(newText);

  const header: string[] = [`diff --git a/${path} b/${path}`];
  if (oldText === null) header.push('new file mode 100644');
  else if (newText === null) header.push('deleted file mode 100644');
  header.push(`--- ${oldText === null ? '/dev/null' : `a/${path}`}`);
  header.push(`+++ ${newText === null ? '/dev/null' : `b/${path}`}`);

  let ops: Op[] | null;
  if (a.length + b.length > MAX_LINES_TOTAL) ops = null;
  else ops = myersOps(a, b);
  if (ops === null) {
    // 退化：整文件替换（旧全删 + 新全增），合法但非最小
    ops = [...a.map((): Op => 'del'), ...b.map((): Op => 'ins')];
  }

  const hunks = buildHunks(a, b, ops);
  let added = 0;
  let removed = 0;
  const body: string[] = [];
  for (const h of hunks) {
    body.push(`@@ -${fmtRange(h.aStart, h.aLen)} +${fmtRange(h.bStart, h.bLen)} @@`);
    for (const line of h.lines) {
      body.push(line);
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { text: `${[...header, ...body].join('\n')}\n`, added, removed };
}
