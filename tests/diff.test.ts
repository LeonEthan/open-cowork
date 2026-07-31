import { describe, expect, it } from 'vitest';
import { countDiffLines, createUnifiedDiff, isBinaryBuffer, splitLines } from '../src/main/changes/diff';

/**
 * 统一 diff 生成器（ticket #24 seam 2）：Myers 行 diff + hunk 分组 + 退化兜底。
 * 语义锁定：头部格式、hunk 区间格式（git 惯例）、+/- 统计、上下文合并。
 */

describe('splitLines / countDiffLines / isBinaryBuffer', () => {
  it('末尾换行不产生空行；空文本零行', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
  });

  it('countDiffLines 跳过 ---/+++ 文件头', () => {
    const d = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n';
    expect(countDiffLines(d)).toEqual({ added: 1, removed: 1 });
  });

  it('二进制探测：前 8000 字节内 NUL', () => {
    expect(isBinaryBuffer(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(isBinaryBuffer(Buffer.from('plain text\n', 'utf8'))).toBe(false);
  });
});

describe('createUnifiedDiff', () => {
  it('新增文件：/dev/null → b/path，全 + 行', () => {
    const d = createUnifiedDiff('new.txt', null, 'l1\nl2\n');
    expect(d.text).toContain('diff --git a/new.txt b/new.txt');
    expect(d.text).toContain('new file mode');
    expect(d.text).toContain('--- /dev/null');
    expect(d.text).toContain('+++ b/new.txt');
    expect(d.text).toContain('@@ -0,0 +1,2 @@');
    expect(d.text).toContain('+l1');
    expect(d.text).toContain('+l2');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
  });

  it('删除文件：a/path → /dev/null，全 - 行', () => {
    const d = createUnifiedDiff('gone.txt', 'x\ny\nz\n', null);
    expect(d.text).toContain('deleted file mode');
    expect(d.text).toContain('--- a/gone.txt');
    expect(d.text).toContain('+++ /dev/null');
    expect(d.text).toContain('@@ -1,3 +0,0 @@');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(3);
  });

  it('修改单行：-旧 +新，上下文 3 行包裹', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n') + '\n';
    const newT = ['a', 'B2', 'c', 'd', 'e', 'f', 'g'].join('\n') + '\n';
    const d = createUnifiedDiff('m.txt', old, newT);
    expect(d.text).toContain('@@ -1,5 +1,5 @@'); // b 行 + 两侧各 3 行上下文（顶到文件头）
    expect(d.text).toContain('-b');
    expect(d.text).toContain('+B2');
    expect(d.text).toContain(' a');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it('相隔 >6 行的两处变更 → 两个 hunk', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const newT = Array.from({ length: 20 }, (_, i) => (i === 2 || i === 15 ? `L${i + 1}` : `l${i + 1}`)).join('\n') + '\n';
    const d = createUnifiedDiff('m.txt', old, newT);
    const hunks = d.text.split('\n').filter((l) => l.startsWith('@@'));
    expect(hunks).toHaveLength(2);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
  });

  it('相邻变更（间隔 ≤6 行上下文）合并为一个 hunk', () => {
    const old = ['1', '2', '3', '4', '5'].join('\n') + '\n';
    const newT = ['1', '2', 'X', '4', 'Y'].join('\n') + '\n';
    const d = createUnifiedDiff('m.txt', old, newT);
    const hunks = d.text.split('\n').filter((l) => l.startsWith('@@'));
    expect(hunks).toHaveLength(1);
  });

  it('末尾插入行：hunk 区间落在末行', () => {
    const d = createUnifiedDiff('m.txt', 'a\nb\n', 'a\nb\nc\n');
    expect(d.text).toContain('@@ -1,2 +1,3 @@');
    expect(d.text).toContain('+c');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
  });

  it('空新文件：仅头部无 hunk，added=0', () => {
    const d = createUnifiedDiff('empty.txt', null, '');
    expect(d.text).not.toContain('@@');
    expect(d.added).toBe(0);
  });

  it('无差异：无 hunk', () => {
    const d = createUnifiedDiff('same.txt', 'a\nb\n', 'a\nb\n');
    expect(d.text).not.toContain('@@');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it('大文件全改（D 超上限）→ 退化整文件替换单 hunk', () => {
    const old = Array.from({ length: 900 }, (_, i) => `old-${i}`).join('\n') + '\n';
    const newT = Array.from({ length: 900 }, (_, i) => `new-${i}`).join('\n') + '\n';
    const d = createUnifiedDiff('big.txt', old, newT);
    const hunks = d.text.split('\n').filter((l) => l.startsWith('@@'));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toBe('@@ -1,900 +1,900 @@');
    expect(d.added).toBe(900);
    expect(d.removed).toBe(900);
    // 退化形态：先全删后全增（无 keep 行）
    expect(d.text).not.toContain('\n ');
  });

  it('Myers 中间行插入不制造多余删除', () => {
    const d = createUnifiedDiff('m.txt', 'a\nc\n', 'a\nb\nc\n');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.text).toContain('+b');
  });
});
