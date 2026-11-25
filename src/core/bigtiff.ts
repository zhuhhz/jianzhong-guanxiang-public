import { TiffIfd } from 'tiff';
import { ICC_MAX_BYTES, inspectTiffIcc } from './icc';
import { QuickViewError } from './shared';
import { TIFF_RANGE_TAG_LIMITS, type TiffRangeMetadata } from './tiff-preview';

type Read = (offset: number, length: number) => Promise<Uint8Array>;
const invalid = () => new QuickViewError('INVALID_TIFF', 'BigTIFF 区段或条带数据无效，已停止读取。');
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const HEADER_BYTES = 16, ENTRY_BYTES = 20, RANGE_BYTES = 65536;

/** Inspect only bounded numeric raster tags and ICC in the first BigTIFF IFD.
 * See https://libtiff.gitlab.io/libtiff/specification/bigtiff.html. */
export async function inspectBigTiffFile(read: Read, size: number): Promise<TiffRangeMetadata> {
  const exact = async (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length)
      || length < 1 || length > RANGE_BYTES || offset > size - length) throw invalid();
    const bytes = await read(offset, length);
    if (bytes.length !== length) throw invalid();
    return bytes;
  };
  if (!Number.isSafeInteger(size) || size < HEADER_BYTES) throw invalid();
  const header = view(await exact(0, HEADER_BYTES));
  const order = header.getUint16(0), little = order === 0x4949;
  if ((!little && order !== 0x4d4d) || header.getUint16(2, little) !== 43) throw invalid();
  if (header.getUint16(4, little) !== 8 || header.getUint16(6, little) !== 0) throw invalid();
  const uint64 = (data: DataView, at: number) => {
    const high = data.getUint32(at + (little ? 4 : 0), little);
    if (high > 0x1fffff) throw invalid();
    return high * 0x100000000 + data.getUint32(at + (little ? 0 : 4), little);
  };
  const first = uint64(header, 8);
  if (first < HEADER_BYTES) throw invalid();
  const count = uint64(view(await exact(first, 8)), 0);
  if (count < 1 || count > 256) throw invalid();
  const directory = view(await exact(first + 8, count * ENTRY_BYTES + 8));
  const next = uint64(directory, count * ENTRY_BYTES);
  if (next && (next < HEADER_BYTES || next > size - 8 || next === first)) throw invalid();

  const ifd = new TiffIfd();
  let profile: Uint8Array | undefined;
  for (let pos = 0; pos < count * ENTRY_BYTES; pos += ENTRY_BYTES) {
    const tag = directory.getUint16(pos, little);
    if (tag >= 322 && tag <= 325) throw new QuickViewError('UNSUPPORTED_TIFF', '暂不支持分块存储的 BigTIFF。');
    const max = TIFF_RANGE_TAG_LIMITS.get(tag);
    if (tag !== 34675 && !max) continue; // Leave all other tags and pointers untouched.
    const type = directory.getUint16(pos + 2, little), length = uint64(directory, pos + 4), valueAt = pos + 12;
    if (tag === 34675) {
      const start = uint64(directory, valueAt);
      if (profile || type !== 7 || length < 132 || length > ICC_MAX_BYTES || start < HEADER_BYTES || start > size - length) {
        throw new QuickViewError('INVALID_ICC', 'BigTIFF ICC 配置的类型、长度或位置无效。');
      }
      profile = new Uint8Array(length);
      for (let at = 0; at < length; at += RANGE_BYTES) {
        profile.set(await exact(start + at, Math.min(RANGE_BYTES, length - at)), at);
      }
      continue;
    }

    const stripTag = tag === 273 || tag === 279;
    const step = type === 3 ? 2 : type === 4 ? 4 : type === 16 && stripTag ? 8 : 0;
    if (!max || ifd.fields.has(tag) || !step || length < 1 || length > max) throw invalid();
    const bytes = step * length, inline = bytes <= 8;
    const offset = inline ? valueAt : uint64(directory, valueAt);
    if (!inline && offset < HEADER_BYTES) throw invalid();
    const data = inline ? directory : view(await exact(offset, bytes));
    const values = new Array<number>(length);
    for (let index = 0; index < length; index++) {
      const at = (inline ? offset : 0) + index * step;
      values[index] = step === 2 ? data.getUint16(at, little) : step === 4 ? data.getUint32(at, little) : uint64(data, at);
    }
    if (tag === 273 && values.some(value => value < HEADER_BYTES)) throw invalid();
    // TiffIfd defaults some absent scalars to 1. An explicit zero is malformed.
    if ([259, 266, 274, 277, 278, 284, 317].includes(tag) && values[0] === 0) throw invalid();
    ifd.fields.set(tag, length === 1 ? values[0] : values);
  }
  if (ifd.compression !== 1) {
    throw new QuickViewError('UNSUPPORTED_TIFF', '目前 BigTIFF 仅支持未压缩条带。');
  }
  return { ifd, little, morePages: next !== 0, color: inspectTiffIcc(profile, ifd.type) };
}
