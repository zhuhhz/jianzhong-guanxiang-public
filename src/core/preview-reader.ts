import { QuickViewError } from './shared';

type Read = (offset: number, length: number) => Promise<Uint8Array>;
/** One bounded read-ahead window for large-file overview sampling only.
 * Fewer filesystem bridge round trips, with the exact same bytes for each request.
 * The caller clears it before detail/export, so no cache survives a viewport/file.
 */
export function previewReader(read: Read, size: number, isCurrent: () => boolean = () => true,
  options: { adaptive?: boolean; now?: () => number } = {}) {
  const budget = 512 * 1024;
  let start = 0, block: Uint8Array | undefined;
  let probes = 0, elapsed = 0, enabled = !options.adaptive;
  const now = options.now || Date.now;
  const current = () => { if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消概览读取。'); };
  return {
    clear() { block = undefined; },
    async read(offset: number, length: number) {
      current();
      if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 1 || length > size - offset) throw new QuickViewError('INVALID_READ_RANGE', '概览文件读取范围无效。');
      // Measure awaited I/O only. Fast storage avoids unnecessary extra read volume.
      if (options.adaptive && (probes < 8 || !enabled)) {
        const before = now(), bytes = await read(offset, length); current();
        if (bytes.byteLength !== length) throw new QuickViewError('TRUNCATED', '概览文件读取不完整。');
        if (probes < 8) { elapsed += Math.max(0, now() - before); probes++; if (probes === 8) enabled = elapsed >= 8; }
        return bytes;
      }
      if (length > budget) {
        block = undefined;
        const bytes = await read(offset, length); current();
        if (bytes.byteLength !== length) throw new QuickViewError('TRUNCATED', '概览文件读取不完整。');
        return bytes;
      }
      if (block && offset >= start && length <= block.length - (offset - start)) return block.subarray(offset - start, offset - start + length);
      block = undefined;
      const count = Math.min(budget, size - offset), bytes = await read(offset, count);
      current();
      if (bytes.byteLength !== count) throw new QuickViewError('TRUNCATED', '概览预读不完整。');
      start = offset; block = bytes;
      return bytes.subarray(0, length);
    },
  };
}
