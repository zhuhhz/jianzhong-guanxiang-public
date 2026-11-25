import { photoshopDescription, type PhotoshopHeader } from './photoshop';
import { LIMITS, QuickViewError } from './shared';
import { readPhotoshopIcc, ICC_MAX_BYTES } from './icc';

type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;
export interface PhotoshopRegion { x: number; y: number; width: number; height: number }
export interface PhotoshopRaster { width: number; height: number; pixels: Uint8ClampedArray; warnings: string[] }
export interface CompositeSession {
  readonly width: number;
  readonly height: number;
  readonly nativeChannels: 3;
  readonly nativeSrgb: boolean;
  readonly nativeWarnings: readonly string[];
  /** Ordered, full-width RGB8 rows. The row buffer is reused after next() resumes. */
  rows(options?: { isCurrent?: () => boolean }): AsyncGenerator<{ y: number; data: Uint8Array }>;
  /** Await each consumer before reusing its row buffer or reading further stripes. */
  readRows(consume: (row: { y: number; data: Uint8Array }) => Promise<void>,
    options?: { isCurrent?: () => boolean }): Promise<void>;
  decodeRegion(region: PhotoshopRegion, output: { width: number; height: number },
    options?: { overview?: boolean; quality?: 'area'; isCurrent?: () => boolean }): Promise<PhotoshopRaster>;
}
const TABLE_CHUNK = 64 * 1024;
const MAX_TABLE_BYTES = 8 * 1024 * 1024;
const MAX_ROW_BYTES = 1024 * 1024;
const MAX_RAW_BATCH_BYTES = 512 * 1024;

function invalid(message: string): never { throw new QuickViewError('INVALID_PHOTOSHOP', message); }

/** Decode one independent PackBits scanline into a reused single-channel row. */
function unpackRow(encoded: Uint8Array, row: Uint8Array): void {
  let source = 0;
  let output = 0;
  while (source < encoded.length) {
    const command = encoded[source++];
    if (command < 128) {
      const count = command + 1;
      if (source + count > encoded.length || output + count > row.length) invalid('RLE 字面数据截断或行像素溢出。');
      row.set(encoded.subarray(source, source + count), output);
      source += count;
      output += count;
    } else if (command > 128) {
      const count = 257 - command;
      if (source >= encoded.length || output + count > row.length) invalid('RLE 重复数据截断或行像素溢出。');
      row.fill(encoded[source++], output, output + count);
      output += count;
    } // 128 is the PackBits no-op; it consumes no following byte.
  }
  if (output !== row.length) invalid('RLE 行像素数与图像宽度不符。');
}

/** Bounded saved-composite preview: RGB8 Raw/PackBits, with opt-in PSD RGB16 Raw.
 * Reads selected source rows; it neither reconstructs layers nor validates unsampled row packets.
 * PSD/PSB layout: https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
 */
export async function openPhotoshopComposite(read: RangeReader, fileSize: number, header: PhotoshopHeader,
  capabilities: { rgb16Raw?: boolean; rgb16RawBatchRows?: 1 | 8 | 16 | 32; cropRaw8?: boolean } = {}): Promise<CompositeSession> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 26) invalid('Photoshop 文件大小无效。');
  const sourceWidth = header.width;
  const sourceHeight = header.height;
  const dimensionLimit = header.version === 1 ? 30000 : 300000;
  if (![1, 2].includes(header.version) || ![sourceWidth, sourceHeight].every(Number.isSafeInteger)
    || sourceWidth < 1 || sourceHeight < 1 || sourceWidth > dimensionLimit || sourceHeight > dimensionLimit) {
    invalid('Photoshop 预览尺寸或版本无效。');
  }
  // Other callers must explicitly opt in; compression, channel layout and transparency are checked below.
  const rgb16 = capabilities.rgb16Raw === true && header.version === 1 && header.bitDepth === 16;
  const rawBatchRows = rgb16 ? capabilities.rgb16RawBatchRows ?? 1 : 1;
  if (![1, 8, 16, 32].includes(rawBatchRows)) invalid('RGB16 批量读取行数无效。');
  if (header.colorModeId !== 3 || (rgb16
    ? !Number.isInteger(header.channels) || header.channels < 3 || header.channels > 56
    : header.bitDepth !== 8 || header.channels !== 3)) {
    throw new QuickViewError('UNSUPPORTED_PHOTOSHOP', `此文件为 ${photoshopDescription(header)}；当前色彩、位深或通道布局暂不支持分段预览。请让发件人导出 PNG/JPG。`);
  }
  const endOf = (offset: number, length: number): number => {
    const end = offset + length;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || !Number.isSafeInteger(end)
      || offset < 0 || length < 0 || end > fileSize) invalid('Photoshop 区段或行数据超过文件边界。');
    return end;
  };
  const current = (isCurrent?: () => boolean): void => {
    if (isCurrent && !isCurrent()) throw new QuickViewError('CANCELLED', '视口已变化。');
  };
  const exact = async (offset: number, length: number, isCurrent?: () => boolean): Promise<Uint8Array> => {
    current(isCurrent);
    endOf(offset, length);
    const bytes = await read(offset, length);
    current(isCurrent);
    // Native bridges may return a typed array from a different JavaScript realm.
    if (bytes.byteLength !== length || bytes.length !== length) {
      throw new QuickViewError('TRUNCATED', 'Photoshop 分段读取不完整，请重新选择文件。');
    }
    return bytes;
  };
  let offset = 26;
  const skipSection = async (wide = false): Promise<void> => {
    const count = wide ? 8 : 4;
    const bytes = await exact(offset, count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, count);
    const length = wide ? view.getUint32(0) * 0x100000000 + view.getUint32(4) : view.getUint32(0);
    offset = endOf(endOf(offset, count), length);
  };
  await skipSection(); // Color mode data remains uint32 in PSB.
  await skipSection(); // Image resources remain uint32 in PSB.
  const layersStart = offset + (header.version === 2 ? 8 : 4);
  await skipSection(header.version === 2);
  const layersEnd = offset;
  const compressionBytes = await exact(offset, 2);
  const compression = new DataView(compressionBytes.buffer, compressionBytes.byteOffset, 2).getUint16(0);
  offset = endOf(offset, 2);
  if (compression !== 0 && compression !== 1) {
    throw new QuickViewError('UNSUPPORTED_COMPRESSION', `${photoshopDescription(header)}，压缩方式 ${compression === 2 ? 'ZIP' : compression === 3 ? 'ZIP Prediction' : compression}；分段预览仅支持 Raw / RLE。请让发件人导出 PNG/JPG。`);
  }
  if (rgb16 && compression !== 0) {
    throw new QuickViewError('UNSUPPORTED_COMPRESSION', `${photoshopDescription(header)}，RLE 压缩；16 位局部解码目前仅支持 PSD Raw 合成图。请让发件人导出 PNG/JPG，或改存未压缩合成图。`);
  }

  if (rgb16 && layersStart < layersEnd) {
    // RGB16 commonly puts the signed layer count in Lr16, not the empty primary
    // layer-info block. Extra saved channels alone never imply merged transparency.
    const layerBytes = async (at: number, length: number): Promise<Uint8Array> => {
      if (at < layersStart || endOf(at, length) > layersEnd) invalid('16 位图层透明标记超过区段边界。');
      return exact(at, length);
    };
    const primaryLengthBytes = await layerBytes(layersStart, 4);
    const primaryLength = new DataView(primaryLengthBytes.buffer, primaryLengthBytes.byteOffset, 4).getUint32(0);
    const layerCounts: number[] = [];
    const layerCount = async (at: number, length: number): Promise<void> => {
      if (length < 2 || endOf(at, length) > layersEnd) invalid('16 位图层计数或区段长度无效。');
      const bytes = await layerBytes(at, 2);
      layerCounts.push(new DataView(bytes.buffer, bytes.byteOffset, 2).getInt16(0));
    };
    if (primaryLength) await layerCount(layersStart + 4, primaryLength);
    let tagOffset = endOf(layersStart + 4, primaryLength);
    const maskBytes = await layerBytes(tagOffset, 4);
    const maskLength = new DataView(maskBytes.buffer, maskBytes.byteOffset, 4).getUint32(0);
    tagOffset = endOf(tagOffset + 4, maskLength);
    if (tagOffset > layersEnd) invalid('全局图层蒙版超过区段边界。');
    let tags = 0;
    let foundLr16 = false;
    while (tagOffset < layersEnd) {
      if (++tags > 4096) throw new QuickViewError('MEMORY_BUDGET', '16 位附加图层区段超过 4096 项。');
      const bytes = await layerBytes(tagOffset, 12);
      const signature = String.fromCharCode(...bytes.subarray(0, 4));
      if (signature !== '8BIM') invalid('16 位附加图层区段签名尚未支持或无效。');
      const key = String.fromCharCode(...bytes.subarray(4, 8));
      const length = new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(8);
      const dataStart = tagOffset + 12;
      const paddedEnd = endOf(dataStart, length + (4 - length % 4) % 4);
      if (paddedEnd > layersEnd) invalid('16 位附加图层数据或填充越界。');
      if (key === 'Lr16') {
        if (foundLr16) invalid('重复的 Lr16 透明标记。');
        await layerCount(dataStart, length);
        foundLr16 = true;
      }
      tagOffset = paddedEnd;
    }
    if (layerCounts.some(count => count < 0)) {
      throw new QuickViewError('UNSUPPORTED_PHOTOSHOP', '16 位合成透明度尚未验证，已停止局部解码；不会把额外通道误作透明度。');
    }
  }

  const sampleBytes = rgb16 ? 2 : 1;
  const entries = sourceHeight * header.channels;
  const entryBytes = header.version === 2 ? 4 : 2;
  const tableBytes = compression === 1 ? entries * entryBytes : 0;
  const indexBytes = compression === 1 ? (entries + 1) * 8 : 0;
  // Reserve only output/index/row buffers and range bridge copies, never the full source size.
  const workingBytes = LIMITS.canvasSide * LIMITS.canvasSide * 4 + indexBytes
    + sourceWidth * sampleBytes * 2 + 2 * MAX_ROW_BYTES + TABLE_CHUNK
    + LIMITS.canvasSide * LIMITS.canvasSide * 3 * 4 + sourceWidth * 8 + LIMITS.canvasSide * 8 + ICC_MAX_BYTES;
  if (tableBytes > MAX_TABLE_BYTES || workingBytes > LIMITS.memoryBytes) {
    throw new QuickViewError('MEMORY_BUDGET', 'Photoshop 分段预览的行索引或工作内存超过预算。');
  }
  let rowOffsets: Float64Array | undefined;
  if (compression === 0) {
    if (endOf(offset, sourceWidth * sourceHeight * header.channels * sampleBytes) !== fileSize) invalid('Raw 合成图长度与尺寸不符或包含多余数据。');
  } else {
    const dataStart = endOf(offset, tableBytes);
    rowOffsets = new Float64Array(entries + 1);
    rowOffsets[0] = dataStart;
    let indexed = 0;
    while (indexed < entries) {
      const count = Math.min(entries - indexed, TABLE_CHUNK / entryBytes);
      const bytes = await exact(offset + indexed * entryBytes, count * entryBytes);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < count; i++) {
        const length = entryBytes === 4 ? view.getUint32(i * 4) : view.getUint16(i * 2);
        if (!length) invalid('RLE 行长度不能为零。');
        if (length > MAX_ROW_BYTES) throw new QuickViewError('MEMORY_BUDGET', 'RLE 单行压缩数据超过 1 MiB 预览上限。');
        rowOffsets[indexed + i + 1] = endOf(rowOffsets[indexed + i], length);
      }
      indexed += count;
    }
    if (rowOffsets[entries] !== fileSize) invalid('RLE 合成图长度与行表不符或包含多余数据。');
  }

  const color = await readPhotoshopIcc(read, fileSize, header);
  const stride = sourceWidth * sampleBytes;
  const stripeRows = Math.max(1, Math.min(16, Math.floor(MAX_RAW_BATCH_BYTES / stride)));
  const readStripe = async (firstY: number, count: number, isCurrent?: () => boolean): Promise<Uint8Array[]> => {
    current(isCurrent);
    const planes: Uint8Array[] = [];
    for (let c = 0; c < 3; c++) {
      const entry = c * sourceHeight + firstY;
      if (rowOffsets) {
        const plane = new Uint8Array(count * stride);
        for (let y = 0; y < count; y++) {
          const index = entry + y;
          const encoded = await exact(rowOffsets[index], rowOffsets[index + 1] - rowOffsets[index], isCurrent);
          unpackRow(encoded, plane.subarray(y * stride, (y + 1) * stride));
        }
        planes.push(plane);
      } else planes.push(await exact(offset + entry * stride, count * stride, isCurrent));
    }
    return planes;
  };
  const fillRow = (planes: Uint8Array[], y: number, rgb: Uint8Array, values: Uint16Array, isCurrent?: () => boolean): void => {
    current(isCurrent);
    for (let x = 0; x < sourceWidth; x++) {
      if ((x & 4095) === 0) current(isCurrent);
      const at = y * stride + x * sampleBytes;
      if (!rgb16 && !color.convert) {
        rgb[x * 3] = planes[0][at];
        rgb[x * 3 + 1] = planes[1][at];
        rgb[x * 3 + 2] = planes[2][at];
        continue;
      }
      for (let c = 0; c < 3; c++) values[c] = rgb16 ? (planes[c][at] << 8) | planes[c][at + 1] : planes[c][at];
      if (color.convert) {
        const divisor = rgb16 ? 65535 : 255;
        const converted = color.convert(values[0] / divisor, values[1] / divisor, values[2] / divisor);
        for (let c = 0; c < 3; c++) rgb[x * 3 + c] = Math.round(converted[c] * 255);
      } else for (let c = 0; c < 3; c++) rgb[x * 3 + c] = rgb16 ? values[c] >>> 8 : values[c];
    }
  };
  return {
    width: sourceWidth,
    height: sourceHeight,
    nativeChannels: 3,
    nativeSrgb: color.kind !== 'unmanaged',
    nativeWarnings: [color.warning, ...(rgb16 ? ['RGB16 合成图经已有 ICC 路径转换后量化为 8 位；额外通道不作为透明度。'] : [])],
    async *rows(options = {}) {
      // Planar source data is read as at most three bounded stripes, then emitted
      // top-to-bottom. The RLE table and ICC session above are shared with preview.
      const rgb = new Uint8Array(sourceWidth * 3);
      const values = new Uint16Array(3);
      for (let firstY = 0; firstY < sourceHeight; firstY += stripeRows) {
        const count = Math.min(stripeRows, sourceHeight - firstY);
        const planes = await readStripe(firstY, count, options.isCurrent);
        for (let y = 0; y < count; y++) {
          fillRow(planes, y, rgb, values, options.isCurrent);
          yield { y: firstY + y, data: rgb };
          current(options.isCurrent);
        }
      }
    },
    async readRows(consume, options = {}) {
      const rgb = new Uint8Array(sourceWidth * 3), values = new Uint16Array(3);
      for (let firstY = 0; firstY < sourceHeight; firstY += stripeRows) {
        const count = Math.min(stripeRows, sourceHeight - firstY);
        const planes = await readStripe(firstY, count, options.isCurrent);
        for (let y = 0; y < count; y++) {
          fillRow(planes, y, rgb, values, options.isCurrent);
          await consume({ y: firstY + y, data: rgb });
          current(options.isCurrent);
        }
      }
    },
    async decodeRegion(region, output, options = {}) {
      current(options.isCurrent);
      if (![region.x, region.y, region.width, region.height].every(Number.isFinite)
        || region.width <= 0 || region.height <= 0) {
        throw new QuickViewError('INVALID_REGION', '原图预览区域无效。');
      }
      const left = Math.max(0, region.x);
      const top = Math.max(0, region.y);
      const right = Math.min(sourceWidth, region.x + region.width);
      const bottom = Math.min(sourceHeight, region.y + region.height);
      const regionWidth = right - left;
      const regionHeight = bottom - top;
      if (regionWidth <= 0 || regionHeight <= 0) throw new QuickViewError('INVALID_REGION', '预览区域未与原图相交。');
      const { width, height } = output;
      if (![width, height].every(Number.isSafeInteger) || width < 1 || height < 1) {
        throw new QuickViewError('INVALID_DIMENSIONS', '预览输出尺寸无效。');
      }
      if (width > LIMITS.canvasSide || height > LIMITS.canvasSide || width * height > LIMITS.pixels) {
        throw new QuickViewError('IMAGE_TOO_LARGE', '局部预览输出超过微信 Canvas 安全尺寸。');
      }
      const area = options.quality === 'area' && (regionWidth > width || regionHeight > height);

      // At most two sample rows and two sample columns per output pixel. This bounded
      // stratified approximation reduces overview aliasing without visiting every source row.
      const xTaps = regionWidth > width ? 2 : 1;
      const yTaps = regionHeight > height ? 2 : 1;
      const xFirst = new Uint32Array(width);
      const xSecond = new Uint32Array(width);
      for (let x = 0; x < width; x++) {
        xFirst[x] = Math.min(sourceWidth - 1, Math.floor(left + (x + (xTaps === 2 ? 0.25 : 0.5)) * regionWidth / width));
        xSecond[x] = xTaps === 2
          ? Math.min(sourceWidth - 1, Math.floor(left + (x + 0.75) * regionWidth / width)) : xFirst[x];
      }
      const pixels = new Uint8ClampedArray(width * height * 4);
      const precise = color.convert ? new Float32Array(width * height * 3) : undefined;
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
      // Only two full single-channel rows live per invocation; no row/result cache
      // survives a viewport request. A protected slot prevents eviction of row A
      // while loading row B for the same output scanline.
      // Raw data can crop columns at read time. RLE requires complete scanlines.
      const crop = rgb16 || (capabilities.cropRaw8 && !rowOffsets && !options.overview);
      const rowStart = crop ? area ? Math.floor(left) : xFirst[0] : 0;
      const rowWidth = crop ? (area ? Math.ceil(right) : xSecond[width - 1] + 1) - rowStart : sourceWidth;
      const rowBytes = rowWidth * sampleBytes;
      const rows = [new Uint8Array(rowBytes), new Uint8Array(rowBytes)];
      // A single request-local batch may include the unused columns between rows.
      // Overview sampling keeps single-row reads so it does not read every source row.
      const batchRows = options.overview && !area ? 1 : rawBatchRows;
      const stride = sourceWidth * sampleBytes;
      const lastY = area ? Math.ceil(bottom) - 1 : Math.min(sourceHeight - 1, Math.floor(top
        + (height - 1 + (yTaps === 2 ? 0.75 : 0.5)) * regionHeight / height));
      let rawBlock: { entry: number; count: number; bytes: Uint8Array } | undefined;
      const cachedEntries = [-1, -1];
      let nextSlot = 0;
      const loadRow = async (entry: number, protectedSlot = -1): Promise<number> => {
        current(options.isCurrent);
        const found = cachedEntries.indexOf(entry);
        if (found >= 0) return found;
        const slot = nextSlot === protectedSlot ? 1 - nextSlot : nextSlot;
        if (rowOffsets) {
          const encoded = await exact(rowOffsets[entry], rowOffsets[entry + 1] - rowOffsets[entry], options.isCurrent);
          unpackRow(encoded, rows[slot]);
        } else if (rgb16 && batchRows > 1) {
          if (!rawBlock || entry < rawBlock.entry || entry >= rawBlock.entry + rawBlock.count) {
            rawBlock = undefined;
            const firstY = entry % sourceHeight;
            const count = Math.min(batchRows, sourceHeight - firstY, lastY - firstY + 1,
              Math.floor((MAX_RAW_BATCH_BYTES - rowBytes) / stride) + 1);
            if (count < 1) throw new QuickViewError('MEMORY_BUDGET', 'RGB16 批量行读取超过缓冲区预算。');
            const bytes = await exact(offset + entry * stride + rowStart * sampleBytes,
              (count - 1) * stride + rowBytes, options.isCurrent);
            rawBlock = { entry, count, bytes };
          }
          const start = (entry - rawBlock.entry) * stride;
          rows[slot].set(rawBlock.bytes.subarray(start, start + rowBytes));
        } else {
          rows[slot].set(await exact(offset + (entry * sourceWidth + rowStart) * sampleBytes, rowBytes, options.isCurrent));
        }
        cachedEntries[slot] = entry;
        nextSlot = 1 - slot;
        return slot;
      };
      const sample = (row: Uint8Array, x: number): number => {
        if (!rgb16) return row[x - rowStart];
        const at = (x - rowStart) * 2;
        const value = (row[at] << 8) | row[at + 1];
        return precise || area ? value / 65535 * 255 : value >>> 8;
      };
      // Exact encoded-source Box integration: one prefix scanline and one output
      // accumulator. The planar traversal still reuses the same 16-row Raw16 batch.
      const prefix = area ? new Float64Array(rowWidth + 1) : undefined;
      const accumulated = area ? new Float64Array(width) : undefined;
      let prefixEntry = -1;
      for (let channel = 0; channel < 3; channel++) {
        for (let y = 0; y < height; y++) {
          current(options.isCurrent);
          if (area) {
            accumulated!.fill(0);
            const dy = regionHeight / height, dx = regionWidth / width;
            const y0 = top + y * dy, y1 = Math.min(bottom, top + (y + 1) * dy);
            for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
              const entry = channel * sourceHeight + sy, slot = await loadRow(entry);
              if (prefixEntry !== entry) {
                prefix![0] = 0;
                for (let sx = 0; sx < rowWidth; sx++) prefix![sx + 1] = prefix![sx] + sample(rows[slot], rowStart + sx);
                prefixEntry = entry;
              }
              const integral = (x: number) => {
                const at = Math.max(0, Math.min(rowWidth, x - rowStart)), i = Math.floor(at);
                return i === rowWidth ? prefix![i] : prefix![i] + (prefix![i + 1] - prefix![i]) * (at - i);
              };
              const weight = Math.min(y1, sy + 1) - Math.max(y0, sy);
              for (let x = 0; x < width; x++) accumulated![x] += weight
                * (integral(left + (x + 1) * dx) - integral(left + x * dx)) / dx;
            }
            for (let x = 0; x < width; x++) {
              const mean = accumulated![x] / dy;
              if (precise) precise[(y * width + x) * 3 + channel] = mean / 255;
              else pixels[(y * width + x) * 4 + channel] = Math.round(mean);
            }
            continue;
          }
          const firstY = Math.min(sourceHeight - 1, Math.floor(top + (y + (yTaps === 2 ? 0.25 : 0.5)) * regionHeight / height));
          const secondY = yTaps === 2
            ? Math.min(sourceHeight - 1, Math.floor(top + (y + 0.75) * regionHeight / height)) : firstY;
          const firstSlot = await loadRow(channel * sourceHeight + firstY);
          const secondSlot = secondY === firstY ? firstSlot : await loadRow(channel * sourceHeight + secondY, firstSlot);
          const firstRow = rows[firstSlot];
          const secondRow = rows[secondSlot];
          for (let x = 0; x < width; x++) {
            const sum = sample(firstRow, xFirst[x]) + sample(firstRow, xSecond[x])
              + sample(secondRow, xFirst[x]) + sample(secondRow, xSecond[x]);
            if (precise) precise[(y * width + x) * 3 + channel] = sum / (4 * 255);
            else pixels[(y * width + x) * 4 + channel] = Math.round(sum / 4);
          }
        }
      }
      rawBlock = undefined;
      current(options.isCurrent);
      if (precise) {
        for (let i = 0; i < width * height; i++) {
          if (i % width === 0) current(options.isCurrent);
          const rgb = color.convert!(precise[i * 3], precise[i * 3 + 1], precise[i * 3 + 2]);
          for (let c = 0; c < 3; c++) pixels[i * 4 + c] = Math.round(rgb[c] * 255);
        }
      }
      return { width, height, pixels, warnings: [
        area ? `合成图 ${width} × ${height} px；按源像素实际交叠面积平均（Box），不重新渲染图层。` : options.overview
          ? `合成图概览 ${width} × ${height} px；每像素最多 2 × 2 分层取样抗锯齿，不重新渲染图层。`
          : `原图局部 ${left}, ${top}, ${regionWidth} × ${regionHeight} → ${width} × ${height} px；降采样采用有界抗锯齿取样。`,
        '仅校验读取到的行像素及完整行索引，未解码未采样行；不代表完整文件校验通过。',
        color.warning,
        ...(rgb16 ? [color.convert ? 'RGB 16 位 Raw 保留高精度完成 ICC 转换后量化到 sRGB 8 位；Alpha 为 255。'
          : 'RGB 16 位 Raw 局部像素按大端读取，以高 8 位显示；未声明合成透明度，Alpha 为 255。',
          ...(header.channels > 3 ? [`另有 ${header.channels - 3} 个独立额外通道，未作为合成透明度或 RGB 显示。`] : [])] : []),
        ...(header.version === 2 ? ['PSB 分段预览为实验性支持。'] : []),
      ] };
    },
  };
}

/** Compatibility entry point for one bounded full-document overview. */
export async function decodePhotoshopPreview(read: RangeReader, fileSize: number, header: PhotoshopHeader): Promise<PhotoshopRaster> {
  const session = await openPhotoshopComposite(read, fileSize, header);
  const scale = Math.min(1, LIMITS.canvasSide / Math.max(session.width, session.height));
  return session.decodeRegion({ x: 0, y: 0, width: session.width, height: session.height }, {
    width: Math.max(1, Math.round(session.width * scale)),
    height: Math.max(1, Math.round(session.height * scale)),
  }, { overview: true });
}
