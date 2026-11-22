import { decode, type TiffIfd } from 'tiff';
import { Inflate } from 'pako';
import { checkFileSize } from './files';
import { checkImageBudget, LIMITS, QuickViewError } from './shared';
import type { PngRowSource } from './png-stream';
import { ICC_MAX_BYTES, inspectTiffIcc } from './icc';

const invalid = () => new QuickViewError('INVALID_TIFF', 'TIFF 结构或图像数据损坏，无法安全预览。');
const unsupported = () => new QuickViewError('UNSUPPORTED_TIFF', '此 TIFF 暂不支持。请使用标准方向、条带存储的 8/16 位 RGB 或灰度 TIFF（无压缩、LZW 或 Deflate）。');
const values = (ifd: TiffIfd, tag: number): number[] => {
  const value: unknown = ifd.get(tag);
  return typeof value === 'number' ? [value] : Array.from((value ?? []) as ArrayLike<number>);
};

// Give the library only first-page raster tags. In particular, it must not follow
// arbitrary EXIF/GPS IFD pointers or allocate Photoshop layer/metadata payloads.
function rasterBuffer(bytes: Uint8Array): { buffer: ArrayBuffer; morePages: boolean; profile?: Uint8Array } {
  if (bytes.length < 8) throw invalid();
  const little = bytes[0] === 73 && bytes[1] === 73;
  if (!little && !(bytes[0] === 77 && bytes[1] === 77)) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) throw unsupported();
  const offset = view.getUint32(4, little);
  if (offset < 8 || offset > bytes.length - 2) throw invalid();
  const count = view.getUint16(offset, little), end = offset + 2 + count * 12;
  if (count < 1 || count > 256 || end > bytes.length - 4) throw invalid();
  const buffer = bytes.slice().buffer as ArrayBuffer;
  const safe = new DataView(buffer);
  const tags = new Map<number, number>([
    [256, 1], [257, 1], [258, 8], [259, 1], [262, 1], [266, 1],
    [273, 4096], [274, 1], [277, 1], [278, 1], [279, 4096],
    [284, 1], [317, 1], [338, 7], [339, 8],
  ]);
  const seen = new Set<number>();
  let profile: Uint8Array | undefined;
  for (let pos = offset + 2; pos < end; pos += 12) {
    const tag = view.getUint16(pos, little), maxCount = tags.get(tag);
    if (tag === 34675) {
      const type = view.getUint16(pos + 2, little), length = view.getUint32(pos + 4, little), start = view.getUint32(pos + 8, little);
      if (seen.has(tag) || type !== 7 || length < 132 || length > ICC_MAX_BYTES || start < 8 || start > bytes.length - length) {
        throw new QuickViewError('INVALID_ICC', 'TIFF ICC 配置的类型、长度或位置无效。');
      }
      seen.add(tag); profile = bytes.subarray(start, start + length);
    }
    if ([322, 323, 324, 325].includes(tag)) throw unsupported(); // Tiled TIFF.
    if (!maxCount) { safe.setUint16(pos + 2, 0, little); continue; }
    const type = view.getUint16(pos + 2, little), length = view.getUint32(pos + 4, little);
    if (seen.has(tag) || ![3, 4].includes(type) || length < 1 || length > maxCount) throw invalid();
    seen.add(tag);
    const size = length * (type === 3 ? 2 : 4);
    const start = size > 4 ? view.getUint32(pos + 8, little) : pos + 8;
    if (start < 8 || start > bytes.length - size) throw invalid();
  }
  const morePages = view.getUint32(end, little) !== 0;
  safe.setUint32(end, 0, little);
  return { buffer, morePages, profile };
}

// Count LZW output before the library allocates its expandable output buffer.
// This validates code widths, dictionary references, EOI and exact strip size.
function checkLzw(bytes: Uint8Array, expected: number): void {
  const lengths = new Uint16Array(4096);
  lengths.fill(1, 0, 256);
  let bit = 0, width = 9, next = 258, previous = 0, output = 0;
  while (bit + width <= bytes.length * 8) {
    let code = 0;
    for (let i = 0; i < width; i++, bit++) code = code * 2 + ((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1);
    if (code === 256) { width = 9; next = 258; previous = 0; continue; }
    if (code === 257) { if (output !== expected) throw invalid(); return; }
    const length = code < next ? lengths[code] : code === next && previous ? previous + 1 : 0;
    if (!length || output + length > expected || (!previous && code > 255)) throw invalid();
    output += length;
    if (previous) {
      if (next >= 4096) throw invalid();
      lengths[next++] = previous + 1;
      if (width < 12 && next === (1 << width) - 1) width++;
    }
    previous = length;
  }
  throw invalid();
}

function checkStrip(bytes: Uint8Array, expected: number, compression: number): void {
  if (compression === 1) { if (bytes.length !== expected) throw invalid(); return; }
  if (compression === 5) { checkLzw(bytes, expected); return; }
  // TIFF Deflate uses zlib, not gzip (whose trailer can claim a huge size).
  if (bytes.length < 6 || (bytes[0] & 15) !== 8 || ((bytes[0] << 8 | bytes[1]) % 31) !== 0 || (bytes[1] & 32)) throw invalid();
  let count = 0;
  const inflater = new Inflate({ chunkSize: 16384 });
  inflater.onData = chunk => { count += chunk.length; if (count > expected) throw invalid(); };
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    inflater.push(bytes.subarray(offset, offset + 16384), offset + 16384 >= bytes.length);
    if (inflater.err || (inflater.ended && offset + 16384 < bytes.length)) throw invalid();
  }
  if (!inflater.ended || count !== expected) throw invalid();
}

export function decodeTiff(bytes: Uint8Array): {
  width: number; height: number; previewWidth: number; previewHeight: number;
  pixels: Uint8ClampedArray; bitDepth: number; colorMode: string; warnings: string[]; native: PngRowSource;
} {
  checkFileSize('TIFF', bytes.length);
  try {
    const { buffer, morePages, profile } = rasterBuffer(bytes);
    const [metadata] = decode(buffer, { pages: [0], ignoreImageData: true });
    const { width, height, components, bitsPerSample, compression, type } = metadata;
    const color = inspectTiffIcc(profile, type);
    checkImageBudget(width, height, bytes.length, components * 2);
    if (![8, 16].includes(bitsPerSample) || ![0, 1, 2].includes(type)
      || ![1, 5, 8, 32946].includes(compression) || (metadata.orientation ?? 1) !== 1
      || metadata.planarConfiguration !== 1 || metadata.fillOrder !== 1
      || ![1, 2].includes(metadata.predictor)
      || values(metadata, 258).length !== components || values(metadata, 258).some(value => value !== bitsPerSample)
      || values(metadata, 339).some(value => value !== 1)) throw unsupported();
    const colors = type === 2 ? 3 : 1;
    if (components !== colors && components !== colors + 1) throw unsupported();
    if (type === 0 && components > colors) throw unsupported();
    const alpha = values(metadata, 338);
    if (components === colors + 1 ? alpha.length !== 1 || ![1, 2].includes(alpha[0]) : alpha.length !== 0) throw unsupported();
    const decodedBytes = width * height * components * bitsPerSample / 8;
    // Library LZW strings use JS arrays; include their retained dictionary and
    // temporary strip/output copies in addition to the shared Canvas budget.
    const extra = compression === 5 ? Math.min(decodedBytes, 8388608) * 8 : decodedBytes * 2;
    if (checkImageBudget(width, height, bytes.length, components * 2) + extra + (profile ? ICC_MAX_BYTES : 0) > LIMITS.memoryBytes) {
      throw new QuickViewError('MEMORY_BUDGET', 'TIFF 解码预计超过 96 MiB 预算，请使用更小的文件。');
    }
    const offsets = metadata.stripOffsets, counts = metadata.stripByteCounts, rows = metadata.rowsPerStrip;
    const strips = Math.ceil(height / rows);
    if (!Number.isSafeInteger(rows) || rows < 1 || !offsets || !counts || offsets.length !== strips || counts.length !== strips) throw invalid();
    for (let strip = 0; strip < strips; strip++) {
      const start = offsets[strip], length = counts[strip];
      if (!Number.isSafeInteger(start) || start < 8 || !Number.isSafeInteger(length) || length < 1 || start > bytes.length - length) throw invalid();
      const expected = width * Math.min(rows, height - strip * rows) * components * bitsPerSample / 8;
      checkStrip(new Uint8Array(buffer, start, length), expected, compression);
    }
    const [image] = decode(buffer, { pages: [0] });
    if (image.data.length !== width * height * components) throw invalid();
    const scale = bitsPerSample === 16 ? 257 : 1;
    const ratio = Math.min(1, LIMITS.canvasSide / Math.max(width, height));
    const previewWidth = Math.max(1, Math.round(width * ratio)), previewHeight = Math.max(1, Math.round(height * ratio));
    const pixels = new Uint8ClampedArray(previewWidth * previewHeight * 4);
    // Area averaging is bounded by the already checked source pixel budget.
    // Weight RGB by alpha so transparent edges do not acquire dark fringes.
    for (let y = 0; y < previewHeight; y++) for (let x = 0; x < previewWidth; x++) {
      const left = x * width / previewWidth, right = (x + 1) * width / previewWidth;
      const top = y * height / previewHeight, bottom = (y + 1) * height / previewHeight;
      let red = 0, green = 0, blue = 0, alphaSum = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
        const weight = (Math.min(right, sx + 1) - Math.max(left, sx)) * (Math.min(bottom, sy + 1) - Math.max(top, sy));
        const src = (Math.min(height - 1, sy) * width + Math.min(width - 1, sx)) * components;
        const alpha = components > colors ? image.data[src + colors] / scale : 255;
        alphaSum += alpha * weight;
        red += image.data[src] / scale * alpha * weight;
        green += image.data[src + (colors === 3 ? 1 : 0)] / scale * alpha * weight;
        blue += image.data[src + (colors === 3 ? 2 : 0)] / scale * alpha * weight;
      }
      const dst = (y * previewWidth + x) * 4;
      if (alphaSum) {
        if (color.convert) {
          const rgb = color.convert(red / alphaSum / 255, green / alphaSum / 255, blue / alphaSum / 255);
          for (let c = 0; c < 3; c++) pixels[dst + c] = Math.round(rgb[c] * 255);
        } else {
          pixels[dst] = red / alphaSum; pixels[dst + 1] = green / alphaSum; pixels[dst + 2] = blue / alphaSum;
        }
      }
      pixels[dst + 3] = alphaSum / ((right - left) * (bottom - top));
    }
    const warnings = ['显示 TIFF 第一页的合成图，不重新渲染 Photoshop 图层。', color.warning];
    if (morePages) warnings.push('此 TIFF 包含后续页面，本次仅预览第一页。');
    if (bitsPerSample === 16) warnings.push('16 位 TIFF 已量化为 8 位预览。');
    if (ratio < 1) warnings.push(`降采样预览：${previewWidth} × ${previewHeight} px，并非原尺寸。`);
    const native: PngRowSource = {
      width, height, nativeChannels: components > colors ? 4 : 3, nativeSrgb: color.kind !== 'unmanaged',
      async readRows(consume, options = {}) {
        const channels = this.nativeChannels, row = new Uint8Array(width * channels);
        for (let y = 0; y < height; y++) {
          if (options.isCurrent && !options.isCurrent()) throw new QuickViewError('CANCELLED', '已取消 TIFF PNG 导出。');
          for (let x = 0; x < width; x++) {
            const src = (y * width + x) * components, dst = x * channels;
            const divisor = bitsPerSample === 16 ? 65535 : 255;
            const red = image.data[src] / divisor, green = image.data[src + (colors === 3 ? 1 : 0)] / divisor;
            const blue = image.data[src + (colors === 3 ? 2 : 0)] / divisor;
            const rgb = color.convert ? color.convert(red, green, blue) : [red, green, blue];
            for (let c = 0; c < 3; c++) row[dst + c] = Math.round(rgb[c] * 255);
            if (channels === 4) row[dst + 3] = Math.round(image.data[src + colors] / scale);
          }
          await consume({ y, data: row });
        }
      },
    };
    return { width, height, previewWidth, previewHeight, pixels, bitDepth: bitsPerSample, colorMode: type === 2 ? 'RGB' : '灰度', warnings, native };
  } catch (error) {
    if (error instanceof QuickViewError) throw error;
    throw invalid();
  }
}
