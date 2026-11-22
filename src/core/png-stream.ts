import { Deflate } from 'pako';
import { QuickViewError } from './shared';

export interface PngRow { y: number; data: Uint8Array }
export interface PngRowSource {
  readonly width: number;
  readonly height: number;
  readonly nativeChannels: 3 | 4;
  readonly nativeSrgb: boolean;
  readRows(consume: (row: PngRow) => Promise<void>, options?: { isCurrent?: () => boolean }): Promise<void>;
}
export type PngRows = AsyncIterable<PngRow> | ((consume: (row: PngRow) => Promise<void>) => Promise<void>);
export interface PngStreamOptions {
  isCurrent?: () => boolean;
  onProgress?: (rowsWritten: number) => void;
  /** Omit the sRGB chunk when the source color space could not be established. */
  srgb?: boolean;
}

const INPUT_BYTES = 64 * 1024, OUTPUT_BYTES = 16 * 1024;
const QUEUE_BYTES = 256 * 1024, MAX_ROW_BYTES = 8 * 1024 * 1024;
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[i] = crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.byteLength + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i++) bytes[i + 4] = type.charCodeAt(i);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

/** A single zlib stream. The sink is awaited before another input fragment is accepted. */
export async function writePngRows(
  width: number, height: number, channels: 3 | 4,
  rows: PngRows, write: (bytes: Uint8Array) => Promise<void>,
  options: PngStreamOptions = {},
): Promise<{ rowsWritten: number; bytesWritten: number; idatChunks: number; maxQueuedBytes: number }> {
  const rowBytes = width * channels;
  if (![width, height, rowBytes].every(Number.isSafeInteger) || width < 1 || height < 1 ||
      width > 0x7fffffff || height > 0x7fffffff || ![3, 4].includes(channels) || rowBytes > MAX_ROW_BYTES ||
      !Number.isSafeInteger((rowBytes + 1) * height)) {
    throw new QuickViewError('PNG_DIMENSIONS', '原尺寸 PNG 的尺寸或扫描行超出安全范围。');
  }
  const check = () => {
    if (options.isCurrent && !options.isCurrent()) throw new QuickViewError('CANCELLED', '已取消原尺寸 PNG 导出。');
  };
  const stats = { rowsWritten: 0, bytesWritten: 0, idatChunks: 0, maxQueuedBytes: 0 };
  const output = async (bytes: Uint8Array) => {
    check(); await write(bytes); check(); stats.bytesWritten += bytes.byteLength;
    if (!Number.isSafeInteger(stats.bytesWritten)) throw new QuickViewError('PNG_SIZE', 'PNG 文件大小超出安全范围。');
  };
  check();
  await output(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  const header = new Uint8Array(13), ihdr = new DataView(header.buffer);
  ihdr.setUint32(0, width); ihdr.setUint32(4, height);
  header[8] = 8; header[9] = channels === 3 ? 2 : 6;
  await output(chunk('IHDR', header));
  if (options.srgb !== false) await output(chunk('sRGB', new Uint8Array([0])));

  const deflate = new Deflate({ level: 1, chunkSize: OUTPUT_BYTES });
  const queue: Uint8Array[] = [];
  let queuedBytes = 0, endStatus: number | undefined;
  // pako's default callbacks retain the complete result. Neither is used here.
  deflate.onData = bytes => {
    queuedBytes += bytes.byteLength;
    if (queuedBytes > QUEUE_BYTES) throw new QuickViewError('PNG_QUEUE', 'PNG 压缩输出超出有界写入队列。');
    stats.maxQueuedBytes = Math.max(stats.maxQueuedBytes, queuedBytes);
    queue.push(bytes);
  };
  deflate.onEnd = status => { endStatus = status; };
  const push = async (bytes: Uint8Array, finish = false) => {
    check();
    if (!deflate.push(bytes, finish) || (endStatus !== undefined && endStatus !== 0)) {
      throw new QuickViewError('PNG_ENCODING', 'PNG 压缩失败。');
    }
    // No new input, source read or compressor push can occur while the sink is pending.
    while (queue.length) {
      const part = queue.shift()!;
      queuedBytes -= part.byteLength;
      await output(chunk('IDAT', part)); stats.idatChunks++;
    }
  };
  try {
    const filterNone = new Uint8Array([0]);
    const consume = async (row: PngRow) => {
      check();
      if (stats.rowsWritten >= height || row?.y !== stats.rowsWritten || row.data?.byteLength !== rowBytes) {
        const actualY = Number.isSafeInteger(row?.y) ? row.y : typeof row?.y;
        const actualBytes = Number.isSafeInteger(row?.data?.byteLength) ? row.data.byteLength : typeof row?.data?.byteLength;
        throw new QuickViewError('PNG_ROW', `PNG 扫描行校验失败：预期行号 ${stats.rowsWritten}、${rowBytes} 字节，实际行号 ${actualY}、${actualBytes} 字节。请重新选择文件后重试。`);
      }
      await push(filterNone);
      for (let start = 0; start < rowBytes; start += INPUT_BYTES) {
        await push(row.data.subarray(start, Math.min(rowBytes, start + INPUT_BYTES)));
      }
      stats.rowsWritten++; options.onProgress?.(stats.rowsWritten);
      // Yield even if an adapter resolves writes synchronously; cancellation and UI
      // events must not wait for an entire CPU-bound export to finish.
      if (stats.rowsWritten % 32 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); }
    };
    // WeChat's delivery path uses a serial callback, without async-iterator lowering.
    // Keep the iterable interface for existing consumers and independent verification.
    if (typeof rows === 'function') await rows(consume);
    else for await (const row of rows) await consume(row);
    if (stats.rowsWritten !== height) throw new QuickViewError('PNG_ROW', 'PNG 扫描行数量不完整。');
    await push(new Uint8Array(0), true);
    if (endStatus !== 0 || !deflate.ended) throw new QuickViewError('PNG_ENCODING', 'PNG 压缩流未完整结束。');
    await output(chunk('IEND', new Uint8Array(0)));
    return stats;
  } finally {
    queue.length = 0;
  }
}
