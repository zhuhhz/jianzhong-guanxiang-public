import { decode, type TiffIfd } from 'tiff';
import { LIMITS, QuickViewError } from './shared';
import type { PngRowSource } from './png-stream';
import type { PhotoshopRegion } from './photoshop-preview';
import { ICC_MAX_BYTES, inspectTiffIcc, type IccColor } from './icc';

type Read = (offset: number, length: number) => Promise<Uint8Array>;
const invalid = () => new QuickViewError('INVALID_TIFF', 'TIFF 区段或条带数据无效，已停止读取。');
const numbers = (ifd: TiffIfd, tag: number): number[] => {
  const value = ifd.get(tag);
  return typeof value === 'number' ? [value] : Array.from((value ?? []) as ArrayLike<number>);
};

// Repack only bounded numeric first-page tags for the existing TIFF library.
// Pixel offsets still point into the original file. No EXIF, layers or next IFD
// are followed, and no allocation depends on the full source file size.
export async function inspectTiffFile(read: Read, size: number): Promise<{ ifd: TiffIfd; little: boolean; morePages: boolean; color: IccColor }> {
  const exact = async (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > 65536 || offset > size - length) throw invalid();
    const bytes = await read(offset, length);
    if (bytes.length !== length) throw invalid();
    return bytes;
  };
  const head = await exact(0, 8), little = head[0] === 73 && head[1] === 73;
  if (!little && !(head[0] === 77 && head[1] === 77)) throw invalid();
  const header = new DataView(head.buffer, head.byteOffset, head.length);
  if (header.getUint16(2, little) !== 42) throw new QuickViewError('UNSUPPORTED_TIFF', '暂不支持 BigTIFF 文件。');
  const offset = header.getUint32(4, little);
  if (offset < 8) throw invalid();
  const countBytes = await exact(offset, 2);
  const count = new DataView(countBytes.buffer, countBytes.byteOffset, 2).getUint16(0, little);
  if (count < 1 || count > 256) throw invalid();
  const directory = await exact(offset, 2 + count * 12 + 4);
  const source = new DataView(directory.buffer, directory.byteOffset, directory.length);
  const compact = new Uint8Array(8 + directory.length + 2 * 65536);
  compact.set(head); compact.set(directory, 8);
  const target = new DataView(compact.buffer);
  target.setUint32(4, 8, little);
  target.setUint32(8 + 2 + count * 12, 0, little);
  const limits = new Map([[256, 1], [257, 1], [258, 8], [259, 1], [262, 1], [266, 1],
    [273, 4096], [274, 1], [277, 1], [278, 1], [279, 4096], [284, 1], [317, 1], [338, 7], [339, 8]]);
  const seen = new Set<number>();
  let profile: Uint8Array | undefined;
  let used = 8 + directory.length;
  for (let pos = 2; pos < 2 + count * 12; pos += 12) {
    const tag = source.getUint16(pos, little), max = limits.get(tag);
    if (tag === 34675) {
      const type = source.getUint16(pos + 2, little), length = source.getUint32(pos + 4, little), start = source.getUint32(pos + 8, little);
      if (seen.has(tag) || type !== 7 || length < 132 || length > ICC_MAX_BYTES || start < 8 || start > size - length) {
        throw new QuickViewError('INVALID_ICC', 'TIFF ICC 配置的类型、长度或位置无效。');
      }
      seen.add(tag);
      profile = new Uint8Array(length);
      for (let at = 0; at < length; at += 65536) profile.set(await exact(start + at, Math.min(65536, length - at)), at);
    }
    if ([322, 323, 324, 325].includes(tag)) throw new QuickViewError('UNSUPPORTED_TIFF', '暂不支持分块存储的 TIFF。');
    if (!max) { target.setUint16(8 + pos + 2, 0, little); continue; }
    const type = source.getUint16(pos + 2, little), length = source.getUint32(pos + 4, little);
    if (seen.has(tag) || ![3, 4].includes(type) || length < 1 || length > max) throw invalid();
    seen.add(tag);
    const bytes = length * (type === 3 ? 2 : 4);
    if (bytes > 4) {
      const start = source.getUint32(pos + 8, little);
      if (start < 8 || used + bytes > compact.length) throw invalid();
      compact.set(await exact(start, bytes), used);
      target.setUint32(8 + pos + 8, used, little); used += bytes;
    }
  }
  try {
    const [ifd] = decode(compact.buffer, { pages: [0], ignoreImageData: true });
    return { ifd, little, morePages: source.getUint32(2 + count * 12, little) !== 0, color: inspectTiffIcc(profile, ifd.type) };
  } catch (error) { if (error instanceof QuickViewError) throw error; throw invalid(); }
}

function rawTiffLayout(size: number, metadata: Awaited<ReturnType<typeof inspectTiffFile>>) {
  const { ifd } = metadata;
  const { width, height, bitsPerSample: bits, components, type } = ifd;
  const colors = type === 2 ? 3 : 1, extras = numbers(ifd, 338);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 300000 || height > 300000) throw invalid();
  if (![8, 16].includes(bits) || ![0, 1, 2].includes(type) || components < colors || components > 8
    || ifd.compression !== 1 || ifd.planarConfiguration !== 1 || ifd.predictor !== 1 || ifd.fillOrder !== 1 || (ifd.orientation ?? 1) !== 1
    || numbers(ifd, 258).length !== components || numbers(ifd, 258).some(value => value !== bits)
    || numbers(ifd, 339).some(value => value !== 1)
    || extras.length !== components - colors || extras.some(value => value !== 0 && value !== 1 && value !== 2)
    || extras.slice(1).some(value => value !== 0)) {
    throw new QuickViewError('UNSUPPORTED_TIFF', '此 TIFF 暂不支持分段预览：需要标准方向、无预测、交错存储的 RGB/灰度 8/16 位 Raw 数据。');
  }
  const bytesPerRow = width * components * bits / 8;
  if (bytesPerRow > 512 * 1024) throw new QuickViewError('MEMORY_BUDGET', 'TIFF 单行数据超过安全读取预算。');
  const offsets = ifd.stripOffsets, counts = ifd.stripByteCounts, rows = ifd.rowsPerStrip;
  const strips = Math.ceil(height / rows);
  if (!Number.isSafeInteger(rows) || rows < 1 || !offsets || !counts || offsets.length !== strips || counts.length !== strips) throw invalid();
  for (let i = 0; i < strips; i++) {
    const expected = bytesPerRow * Math.min(rows, height - i * rows);
    if (!Number.isSafeInteger(offsets[i]) || offsets[i] < 8 || counts[i] !== expected || offsets[i] > size - expected) throw invalid();
  }
  return { width, height, bits, components, type, colors, extras, bytesPerRow, offsets, rows };
}

export function rawTiffRows(read: Read, size: number, metadata: Awaited<ReturnType<typeof inspectTiffFile>>): PngRowSource {
  const { width, height, bits, components, type, colors, extras, bytesPerRow, offsets, rows } = rawTiffLayout(size, metadata);
  const alphaKind = extras[0] ?? 0, channels = alphaKind ? 4 : 3;
  const max = bits === 16 ? 65535 : 255;
  const { color } = metadata;
  const batchRows = Math.min(16, Math.floor(512 * 1024 / bytesPerRow));
  return {
    width, height, nativeChannels: channels, nativeSrgb: color.kind !== 'unmanaged',
    async readRows(consume, options = {}) {
      const current = () => {
        if (options.isCurrent && !options.isCurrent()) throw new QuickViewError('CANCELLED', '已取消 TIFF PNG 导出。');
      };
      const output = new Uint8Array(width * channels);
      const values = new Float64Array(3);
      for (let y = 0; y < height;) {
        current();
        const strip = Math.floor(y / rows), inStrip = y % rows;
        const count = Math.min(batchRows, rows - inStrip, height - y);
        const bytes = await read(offsets[strip] + inStrip * bytesPerRow, count * bytesPerRow);
        current();
        if (bytes.length !== count * bytesPerRow) throw invalid();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        for (let row = 0; row < count; row++, y++) {
          current();
          if (bits === 8 && components === 3 && type === 2 && !color.convert) {
            output.set(bytes.subarray(row * bytesPerRow, (row + 1) * bytesPerRow));
          } else {
            for (let x = 0; x < width; x++) {
              const src = row * bytesPerRow + x * components * bits / 8;
              const sample = (c: number) => bits === 8 ? view.getUint8(src + c) : view.getUint16(src + c * 2, metadata.little);
              const alpha = alphaKind ? sample(colors) : max;
              for (let c = 0; c < 3; c++) {
                const value = sample(colors === 3 ? c : 0), raw = type === 0 ? max - value : value;
                const straight = alphaKind === 1 ? (alpha ? Math.min(max, raw * max / alpha) : 0) : raw;
                values[c] = straight / max;
              }
              const rgb = color.convert ? color.convert(values[0], values[1], values[2]) : values;
              for (let c = 0; c < 3; c++) output[x * channels + c] = Math.round(rgb[c] * 255);
              if (alphaKind) output[x * channels + 3] = Math.round(alpha * 255 / max);
            }
          }
          await consume({ y, data: output });
          current();
        }
      }
    },
  };
}

export async function previewRawTiff(read: Read, size: number, metadata: Awaited<ReturnType<typeof inspectTiffFile>>,
  isCurrent: () => boolean, options: { region?: PhotoshopRegion; output?: { width: number; height: number } } = {},
): Promise<{ width: number; height: number; pixels: Uint8ClampedArray; warnings: string[] }> {
  const { little, morePages, color } = metadata;
  const { width, height, bits, components, type, colors, extras, bytesPerRow, offsets, rows } = rawTiffLayout(size, metadata);
  const region = options.region ?? { x: 0, y: 0, width, height };
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger)
    || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1
    || region.width > width - region.x || region.height > height - region.y) {
    throw new QuickViewError('INVALID_REGION', 'TIFF 高清区域超出原图范围。');
  }
  const ratio = Math.min(1, LIMITS.canvasSide / Math.max(region.width, region.height));
  const outWidth = options.output?.width ?? Math.max(1, Math.round(region.width * ratio));
  const outHeight = options.output?.height ?? Math.max(1, Math.round(region.height * ratio));
  if (![outWidth, outHeight].every(Number.isSafeInteger) || outWidth < 1 || outHeight < 1
    || outWidth > Math.min(region.width, LIMITS.canvasSide) || outHeight > Math.min(region.height, LIMITS.canvasSide)) {
    throw new QuickViewError('INVALID_REGION', 'TIFF 高清输出须不放大源像素，且单边不超过 1365 像素。');
  }
  const pixels = new Uint8ClampedArray(outWidth * outHeight * 4);
  const alphaKind = extras[0] ?? 0, max = bits === 16 ? 65535 : 255;
  const row = async (y: number) => {
    if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消 TIFF 预览。');
    const strip = Math.floor(y / rows), stride = components * bits / 8;
    const offset = offsets[strip] + (y % rows) * bytesPerRow + region.x * stride;
    const data = await read(offset, region.width * stride);
    if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消 TIFF 预览。');
    if (data.length !== region.width * stride) throw invalid();
    return new DataView(data.buffer, data.byteOffset, data.length);
  };
  const firstXs = new Uint32Array(outWidth), secondXs = new Uint32Array(outWidth);
  for (let x = 0; x < outWidth; x++) {
    firstXs[x] = Math.min(region.width - 1, Math.floor((x + 0.25) * region.width / outWidth));
    secondXs[x] = Math.min(region.width - 1, Math.floor((x + 0.75) * region.width / outWidth));
  }
  // Reuse one accumulator and sampler instead of allocating arrays/functions per tap.
  // Tap order and arithmetic stay identical, including associated alpha and RGB16 ICC.
  const sums = new Float64Array(4), sampleStride = components * bits / 8, step = bits / 8;
  const add = (line: DataView, x: number) => {
    const at = x * sampleStride;
    let red = bits === 8 ? line.getUint8(at) : line.getUint16(at, little);
    let green = colors === 3 ? bits === 8 ? line.getUint8(at + step) : line.getUint16(at + step, little) : red;
    let blue = colors === 3 ? bits === 8 ? line.getUint8(at + 2 * step) : line.getUint16(at + 2 * step, little) : red;
    const alpha = alphaKind ? (bits === 8 ? line.getUint8(at + colors * step) : line.getUint16(at + colors * step, little)) / max : 1;
    if (type === 0) { red = max - red; green = max - green; blue = max - blue; }
    if (alphaKind === 1) {
      red = alpha ? Math.min(max, red / alpha) : 0;
      green = alpha ? Math.min(max, green / alpha) : 0;
      blue = alpha ? Math.min(max, blue / alpha) : 0;
    }
    sums[0] += red / max * alpha; sums[1] += green / max * alpha;
    sums[2] += blue / max * alpha; sums[3] += alpha;
  };
  for (let y = 0; y < outHeight; y++) {
    const firstY = region.y + Math.min(region.height - 1, Math.floor((y + 0.25) * region.height / outHeight));
    const secondY = region.y + Math.min(region.height - 1, Math.floor((y + 0.75) * region.height / outHeight));
    const first = await row(firstY), second = firstY === secondY ? first : await row(secondY);
    for (let x = 0; x < outWidth; x++) {
      sums.fill(0);
      add(first, firstXs[x]); add(first, secondXs[x]); add(second, firstXs[x]); add(second, secondXs[x]);
      const [red, green, blue, sumAlpha] = sums;
      const dst = (y * outWidth + x) * 4;
      if (sumAlpha) {
        if (color.convert) {
          const rgb = color.convert(red / sumAlpha, green / sumAlpha, blue / sumAlpha);
          for (let c = 0; c < 3; c++) pixels[dst + c] = Math.round(rgb[c] * 255);
        } else {
          pixels[dst] = red * 255 / sumAlpha;
          pixels[dst + 1] = green * 255 / sumAlpha;
          pixels[dst + 2] = blue * 255 / sumAlpha;
        }
      }
      pixels[dst + 3] = sumAlpha * 255 / 4;
    }
    if (y % 32 === 31) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  const warnings = ['TIFF 第一页本地预览，未读取 Photoshop 图层。', color.warning];
  if (!options.region && ratio < 1) warnings.push(`降采样概览：${outWidth} × ${outHeight} px，每像素最多 2 × 2 取样；放大后按可见区域读取原图像素。`);
  if (morePages) warnings.push('此 TIFF 含后续页面，本次仅预览第一页。');
  if (bits === 16) warnings.push('16 位 TIFF 量化为 8 位显示。');
  if (extras.includes(0)) warnings.push('独立额外通道不作为 RGB 或透明度显示。');
  return { width: outWidth, height: outHeight, pixels, warnings };
}
