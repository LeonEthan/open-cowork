/**
 * 手写增量 SSE 解析器（ticket #22，opencode /event 事件流；不引依赖，ARCHITECTURE §2）。
 *
 * 按行解析 `event:` / `data:` / `:` 注释行，空行派发一帧：
 * - 多行 data: 以 '\n' 连接（RFC 7575）；
 * - 任意 chunk 边界安全（feed 按字符串喂，跨 chunk 行缓存拼合）；
 * - \r\n 兼容；BOM 剥除。
 *
 * opencode 实际只用 `data: {json}` 帧（事件类型在 JSON 载荷的 type 字段），
 * 但 parser 保持通用，frame.event 留给标准 `event:` 字段。
 */

export interface SseFrame {
  /** `event:` 字段；缺省 null */
  event: string | null;
  /** 多行 data: 以 \n 连接 */
  data: string;
}

export interface SseParser {
  feed: (chunk: string) => void;
  /** 流结束时冲刷末尾无空行收尾的残帧 */
  end: () => void;
}

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
  let lineBuffer = '';
  let dataLines: string[] = [];
  let eventField: string | null = null;
  let bomStripped = false;

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      // 无 data 的帧（纯注释/心跳空行）：不派发
      eventField = null;
      return;
    }
    onFrame({ event: eventField, data: dataLines.join('\n') });
    dataLines = [];
    eventField = null;
  };

  const processLine = (raw: string): void => {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // 注释/心跳
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventField = value;
    // id:/retry: 本票不消费
  };

  return {
    feed(chunk) {
      if (!bomStripped) {
        bomStripped = true;
        if (chunk.startsWith('﻿')) chunk = chunk.slice(1);
      }
      lineBuffer += chunk;
      let idx: number;
      while ((idx = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        processLine(line);
      }
    },
    end() {
      if (lineBuffer.length > 0) {
        processLine(lineBuffer);
        lineBuffer = '';
      }
      dispatch();
    },
  };
}
