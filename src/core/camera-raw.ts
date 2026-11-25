/**
 * TIFF-family embedded-preview selection adapted from extract-raw-preview:
 * https://github.com/radenkovic/extract-raw-preview (src/ifd.ts, formats/shared.ts).
 * Copyright (c) 2026 Dan Radenkovic, MIT; see licenses/extract-raw-preview.txt.
 * Range I/O and explicit budgets replace the upstream whole-buffer reader.
 * This reads camera JPEGs only; it does not demosaic sensor data or apply XMP.
 */
import { checkImageBudget, QuickViewError } from './shared';
import { checkJpegHeader } from './photoshop-thumbnail';
import { opaqueRawDirectory, jpegByteLength, type RawJpegCandidate } from './raw-containers';

const invalid = () => new QuickViewError('INVALID_RAW', 'RAW 内嵌预览目录、偏移或数据损坏，已停止读取。');
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const RAW_LIMITS = Object.freeze({ jpegBytes: 8 * 1024 * 1024, readBytes: 64 * 1024,
  totalBytes: 32 * 1024 * 1024, ifds: 32, entries: 512, depth: 8, candidates: 16 });

export async function readCameraRawDirectory(read: (offset: number, length: number) => Promise<Uint8Array>,
  size: number, isCurrent: () => boolean = () => true) {
  let consumed = 0;
  const current = () => { if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消 RAW 预览。'); };
  const range = async (offset: number, length: number) => {
    current();
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 1 || length > size - offset) throw invalid();
    if (length > RAW_LIMITS.jpegBytes || consumed + length > RAW_LIMITS.totalBytes) {
      throw new QuickViewError('RAW_BUDGET', 'RAW 预览超过安全读取预算。');
    }
    consumed += length;
    const output = new Uint8Array(length);
    for (let i = 0; i < length; i += RAW_LIMITS.readBytes) {
      current();
      const n = Math.min(RAW_LIMITS.readBytes, length - i), bytes = await read(offset + i, n);
      current();
      if (bytes.byteLength !== n) throw invalid();
      output.set(bytes, i);
    }
    return output;
  };
  const head = await range(0, Math.min(16, size)), little = head[0] === 73 && head[1] === 73;
  if (head.length < 8) throw invalid();
  const opaque = await opaqueRawDirectory(head, size, range, RAW_LIMITS.jpegBytes);
  if (opaque) return { range, ...opaque, directories: [] as { offset: number; bytes: Uint8Array }[], isRaw: true, sony: false };
  if (!little && !(head[0] === 77 && head[1] === 77) || view(head).getUint16(2, little) !== 42) {
    throw new QuickViewError('UNSUPPORTED_RAW', '暂不支持此 RAW 容器或变体（包括 BigTIFF 或无文件头的原始像素）。');
  }
  const queue = [{ offset: view(head).getUint32(4, little), depth: 0 }], seen = new Set<number>();
  const candidates: RawJpegCandidate[] = [];
  const directories: { offset: number; bytes: Uint8Array }[] = [];
  const cr2 = head.length >= 12 && head[8] === 67 && head[9] === 82 && head[10] === 2 && head[11] === 0;
  let isRaw = cr2, kind = cr2 ? 'CR2' : 'TIFF/CFA RAW', sony = false;
  let orientation = 1, orientationKnown = false;
  while (queue.length) {
    const item = queue.shift()!;
    if (!item.offset) continue;
    if (seen.has(item.offset)) throw invalid();
    if (seen.size >= RAW_LIMITS.ifds || item.depth > RAW_LIMITS.depth) throw new QuickViewError('RAW_BUDGET', 'RAW 目录数量或深度超过安全预算。');
    seen.add(item.offset);
    const count = view(await range(item.offset, 2)).getUint16(0, little);
    if (count > RAW_LIMITS.entries) throw new QuickViewError('RAW_BUDGET', 'RAW 目录项目过多。');
    const bytes = await range(item.offset + 2, count * 12 + 4), data = view(bytes);
    directories.push({ offset: item.offset, bytes });
    const tags = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const at = i * 12, tag = data.getUint16(at, little);
      const tagType = data.getUint16(at + 2, little), tagCount = data.getUint32(at + 4, little);
      if (tag === 262 && tagCount === 1 && [3, 4].includes(tagType)) {
        const value = tagType === 3 ? data.getUint16(at + 8, little) : data.getUint32(at + 8, little);
        if ([32803, 34892].includes(value)) isRaw = true;
      }
      if (tag === 50706 && tagType === 1 && tagCount === 4 && bytes[at + 8] === 1) { isRaw = true; kind = 'DNG'; }
      // Only the bounded camera make is compared internally; no EXIF/GPS or model is exposed.
      if (tag === 271 && tagType === 2 && tagCount > 0 && tagCount <= 32) {
        const make = tagCount <= 4 ? bytes.subarray(at + 8, at + 8 + tagCount) : await range(data.getUint32(at + 8, little), tagCount);
        sony ||= String.fromCharCode(...make).replace(/\0.*$/, '').trim().toUpperCase() === 'SONY';
      }
      // No sensor pixels, MakerNotes, GPS or arbitrary metadata reads.
      if (![259, 273, 274, 279, 330, 513, 514].includes(tag)) continue;
      if (tags.has(tag)) throw invalid();
      const type = data.getUint16(at + 2, little), n = data.getUint32(at + 4, little);
      const unit = type === 3 ? 2 : [4, 13].includes(type) ? 4 : 0;
      if (!unit || !n || n > RAW_LIMITS.ifds || ![330, 273, 279].includes(tag) && n !== 1) throw invalid();
      const payload = n * unit <= 4 ? bytes.subarray(at + 8, at + 8 + n * unit)
        : await range(data.getUint32(at + 8, little), n * unit);
      const values = view(payload);
      tags.set(tag, Array.from({ length: n }, (_, j) => unit === 2 ? values.getUint16(j * unit, little) : values.getUint32(j * unit, little)));
    }
    const first = (tag: number) => tags.get(tag)?.[0];
    if (item.depth === 0 && first(274) !== undefined) { orientation = first(274)!; orientationKnown = true; }
    const direction = first(274) ?? orientation;
    if (direction < 1 || direction > 8) throw invalid();
    const offset = first(513) ?? ([6, 7].includes(first(259)!) ? first(273) : undefined);
    const length = first(514) ?? ([6, 7].includes(first(259)!) ? first(279) : undefined);
    if (offset !== undefined && length !== undefined) {
      if (!Number.isSafeInteger(offset) || offset < 8 || length < 4 || length > size - offset) throw invalid();
      // Strip-based previews must be a single complete JPEG; sensor strip arrays are ignored.
      const single = first(513) !== undefined || tags.get(273)?.length === 1 && tags.get(279)?.length === 1;
      if (single && length <= RAW_LIMITS.jpegBytes) candidates.push({ offset, length, orientation: first(274) !== undefined || orientationKnown ? direction : 0 });
      if (candidates.length > RAW_LIMITS.candidates) throw new QuickViewError('RAW_BUDGET', 'RAW 内嵌预览数量过多。');
    }
    for (const offset of [data.getUint32(count * 12, little), ...(tags.get(330) || [])]) {
      if (offset) queue.push({ offset, depth: item.depth + 1 });
    }
  }
  return { range, candidates, directories, isRaw, kind, sony };
}

export async function readCameraRawPreview(read: (offset: number, length: number) => Promise<Uint8Array>,
  size: number, isCurrent: () => boolean = () => true, known?: Awaited<ReturnType<typeof readCameraRawDirectory>>) {
  const { range, candidates, directories } = known || await readCameraRawDirectory(read, size, isCurrent);
  const current = () => { if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消 RAW 预览。'); };
  type Image = { jpeg: Uint8Array; width: number; height: number; orientation: number };
  let best: Image | undefined, overview: Image | undefined;
  for (const candidate of candidates) {
    current();
    const bytes = await range(candidate.offset, candidate.length);
    try {
      const length = candidate.trim ? jpegByteLength(bytes) : bytes.length;
      if (!length) continue;
      const jpeg = bytes.subarray(0, length);
      const dimensions = checkJpegHeader(jpeg);
      if (!dimensions.width || !dimensions.height) continue;
      const orientation = candidate.orientation || jpegDirectionField(jpeg)?.direction || 1;
      const image = { jpeg, ...dimensions, orientation };
      if (!best || dimensions.width * dimensions.height > best.width * best.height) best = image;
      // Saving compressed bytes does not allocate full-resolution pixels. Only the
      // bounded Canvas/auto overview needs the old whole-image decoding budget.
      try {
        checkImageBudget(dimensions.width, dimensions.height, jpeg.length, 3);
        if (!overview || dimensions.width * dimensions.height > overview.width * overview.height) overview = image;
      } catch (error) { if (!(error instanceof QuickViewError)) throw error; }
    } catch (error) {
      if (!(error instanceof QuickViewError)) throw error;
      // A damaged, lossless-JPEG or over-budget candidate may have a usable smaller sibling.
    }
  }
  if (!best) throw new QuickViewError('RAW_PREVIEW_UNAVAILABLE', '此 RAW 没有当前可用的内嵌 JPEG 预览（需完整的 8 位标准 JPEG 且在安全读取预算内）；不进行传感器显影。');
  return { ...(overview || best), highest: best, overviewSafe: !!overview, directories };
}

function jpegDirectionField(jpeg: Uint8Array, detectMalformed = false):
  { at: number; little: boolean; direction: number } | null | undefined {
  let at = 2;
  while (at + 4 < jpeg.length) {
    if (jpeg[at++] !== 255) return;
    while (jpeg[at] === 255) at++;
    const marker = jpeg[at++]; if (marker === 218 || marker === 217) return null;
    if (marker === 1) continue;
    const n = view(jpeg).getUint16(at); if (n < 2 || n > jpeg.length - at) return;
    if (marker === 225 && n >= (detectMalformed ? 8 : 16)
      && String.fromCharCode(...jpeg.subarray(at + 2, at + 8)) === 'Exif\0\0') {
      if (n < 16) return;
      const bytes = jpeg.subarray(at + 8, at + n), data = view(bytes);
      const little = bytes[0] === 73 && bytes[1] === 73;
      if ((!little && !(bytes[0] === 77 && bytes[1] === 77)) || data.getUint16(2, little) !== 42) return;
      const offset = data.getUint32(4, little);
      if (offset > bytes.length - 2) return;
      const count = data.getUint16(offset, little);
      if (count > 512 || count * 12 > bytes.length - offset - 2) return;
      for (let i = 0; i < count; i++) {
        const entry = offset + 2 + i * 12;
        if (data.getUint16(entry, little) !== 274) continue;
        if (data.getUint16(entry + 2, little) !== 3 || data.getUint32(entry + 4, little) !== 1) {
          if (detectMalformed) return;
          continue;
        }
        const direction = data.getUint16(entry + 8, little);
        return direction >= 1 && direction <= 8 ? { at: at + 8 + entry + 8, little, direction } : undefined;
      }
    }
    at += n;
  }
}

/** Carry the authoritative container orientation to the native JPEG viewer, without re-encoding pixels.
 * Patch a valid existing EXIF orientation, otherwise write a canonical orientation block;
 * keep ICC/other segments and compressed scan bytes without changing the source buffer.
 */
export function rawPreviewJpeg(jpeg: Uint8Array, orientation: number,
  options: { preserveUpright?: boolean } = {}): Uint8Array {
  checkJpegHeader(jpeg);
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw invalid();
  const field = jpegDirectionField(jpeg, options.preserveUpright);
  // An upright JPEG with no orientation tag already displays correctly. A malformed
  // EXIF block is different from an absent tag and still gets a canonical replacement.
  if (options.preserveUpright && (field?.direction === orientation || field === null && orientation === 1)) return jpeg;
  if (field) {
    // Preserve existing EXIF color information and all other bytes when only
    // the orientation needs patching. No source buffer or scan data is changed.
    const copy = Uint8Array.from(jpeg); view(copy).setUint16(field.at, orientation, field.little); return copy;
  }
  const parts: Uint8Array[] = [jpeg.subarray(0, 2)];
  const exif = new Uint8Array(36), data = view(exif);
  exif.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0]);
  data.setUint16(18, 1, true); data.setUint16(20, 274, true); data.setUint16(22, 3, true);
  data.setUint32(24, 1, true); data.setUint16(28, orientation, true);
  parts.push(exif);
  let at = 2;
  while (at < jpeg.length - 2) {
    const start = at++;
    while (jpeg[at] === 255) at++;
    const marker = jpeg[at++];
    if (marker === 218) { parts.push(jpeg.subarray(start)); break; }
    if (marker === 1) { parts.push(jpeg.subarray(start, at)); continue; }
    const length = view(jpeg).getUint16(at);
    const isExif = marker === 225 && length >= 8
      && jpeg[at + 2] === 69 && jpeg[at + 3] === 120 && jpeg[at + 4] === 105 && jpeg[at + 5] === 102
      && jpeg[at + 6] === 0 && jpeg[at + 7] === 0;
    at += length;
    if (!isExif) parts.push(jpeg.subarray(start, at));
  }
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
