/** Bounded RAF/BMFF adaptation of extract-raw-preview (MIT, Dan Radenkovic).
 * References: src/formats/{cr3,raf}.ts and src/bmff.ts; see licenses/extract-raw-preview.txt.
 * Only box headers and known preview prefixes are read; mdat sensor data is never walked.
 */
import { QuickViewError } from './shared';

export interface RawJpegCandidate { offset: number; length: number; orientation: number; trim?: boolean }
type Read = (offset: number, length: number) => Promise<Uint8Array>;
const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const invalid = () => new QuickViewError('INVALID_RAW', 'RAW 容器区段、长度或预览偏移无效。');

export async function opaqueRawDirectory(head: Uint8Array, size: number, read: Read, jpegLimit: number) {
  const candidates: RawJpegCandidate[] = [];
  if (text(head, 0, 16) === 'FUJIFILMCCD-RAW ') {
    const header = await read(0, 92), offset = view(header).getUint32(84), length = view(header).getUint32(88);
    if (offset < 92 || length < 4 || length > size - offset) throw invalid();
    if (length <= jpegLimit) candidates.push({ offset, length, orientation: 0, trim: true });
    return { kind: 'RAF', candidates };
  }
  if (text(head, 4, 4) !== 'ftyp') return;
  const ftypSize = view(head).getUint32(0);
  if (ftypSize < 16 || ftypSize > 4096 || ftypSize > size || ftypSize % 4) throw invalid();
  const ftyp = await read(0, ftypSize), brands = [text(ftyp, 8, 4)];
  for (let i = 16; i < ftypSize; i += 4) brands.push(text(ftyp, i, 4));
  if (!brands.includes('crx ')) return;
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'udta', 'meta', 'iprp', 'ipco', 'CRAW']);
  let count = 0;
  async function walk(start: number, end: number, depth: number): Promise<void> {
    if (depth > 8) throw new QuickViewError('RAW_BUDGET', 'CR3 容器嵌套超过预算。');
    for (let at = start; at < end;) {
      if (++count > 256) throw new QuickViewError('RAW_BUDGET', 'CR3 区段数量超过预算。');
      if (end - at < 8) throw invalid();
      const bytes = await read(at, Math.min(32, end - at)), data = view(bytes);
      const type = text(bytes, 4, 4); let length = data.getUint32(0), header = 8;
      if (length === 1) {
        if (bytes.length < 16) throw invalid();
        length = data.getUint32(8) * 0x100000000 + data.getUint32(12); header = 16;
      } else if (length === 0) length = end - at;
      if (!Number.isSafeInteger(length) || length < header || length > end - at) throw invalid();
      const payload = at + header, payloadLength = length - header;
      // Canon PRVW/THMB and preview UUID carry short prefixes before the JPEG.
      if (['THMB', 'PRVW', 'uuid', 'mdat'].includes(type) && payloadLength >= 3) {
        const prefix = await read(payload, Math.min(64, payloadLength));
        for (let i = 0; i + 2 < prefix.length; i++) if (prefix[i] === 255 && prefix[i + 1] === 216 && prefix[i + 2] === 255) {
          candidates.push({ offset: payload + i, length: Math.min(payloadLength - i, jpegLimit), orientation: 0, trim: true }); break;
        }
      }
      if (containers.has(type) && payloadLength > (type === 'meta' ? 4 : 0)) {
        await walk(payload + (type === 'meta' ? 4 : 0), at + length, depth + 1);
      } else if (type === 'uuid' && payloadLength > 24) {
        // Recurse only when the UUID's content actually starts with bounded child boxes.
        const child = await read(payload + 16, 8), n = view(child).getUint32(0);
        if (n >= 8 && n <= payloadLength - 16 && ['PRVW', 'THMB', 'CMT1', 'CMT2', 'CCTP'].includes(text(child, 4, 4))) {
          await walk(payload + 16, at + length, depth + 1);
        }
      }
      if (candidates.length > 16) throw new QuickViewError('RAW_BUDGET', 'RAW 预览候选数量超过预算。');
      at += length;
    }
  }
  await walk(0, size, 0);
  return { kind: 'CR3', candidates };
}

/** Complete-JPEG boundary walk, adapted from upstream jpegByteLength; APP payloads
 * (including nested EXIF thumbnails) cannot supply a false outer EOI. */
export function jpegByteLength(bytes: Uint8Array): number | undefined {
  if (bytes[0] !== 255 || bytes[1] !== 216) return;
  let at = 2, scan = false;
  while (at + 1 < bytes.length) {
    if (scan) {
      while (at + 1 < bytes.length && bytes[at] !== 255) at++;
      if (bytes[at + 1] === 0 || bytes[at + 1] >= 208 && bytes[at + 1] <= 215) { at += 2; continue; }
      if (bytes[at + 1] === 255) { at++; continue; }
      scan = false;
    }
    if (bytes[at] !== 255) return;
    const marker = bytes[at + 1];
    if (marker === 255) { at++; continue; }
    if (marker === 217) return at + 2;
    if (marker === 1 || marker === 216 || marker >= 208 && marker <= 215) { at += 2; continue; }
    if (at + 3 >= bytes.length) return;
    const n = (bytes[at + 2] << 8) | bytes[at + 3];
    if (n < 2 || n > bytes.length - at - 2) return;
    at += n + 2; scan = marker === 218;
  }
}
