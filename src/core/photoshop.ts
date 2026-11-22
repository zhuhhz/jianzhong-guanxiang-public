import { initializeCanvas, readPsd } from 'ag-psd';
import { checkImageBudget, LIMITS, QuickViewError } from './shared';
import { applyIcc8, inspectIcc, ICC_MAX_BYTES } from './icc';

export interface PhotoshopHeader {
  format: 'PSD' | 'PSB';
  version: 1 | 2;
  width: number;
  height: number;
  channels: number;
  bitDepth: number;
  colorMode: string;
  colorModeId: number;
}

export function photoshopDescription(header: PhotoshopHeader): string {
  return `${header.format}，${header.colorMode}，${header.bitDepth} 位，${header.channels} 通道`;
}

function invalid(message: string): never {
  throw new QuickViewError('INVALID_PHOTOSHOP', message);
}

/** Reads only the fixed 26-byte header; a caller may supply a file prefix. */
export function readPhotoshopHeader(bytes: Uint8Array): PhotoshopHeader {
  if (bytes.byteLength < 26) invalid('PSD / PSB 文件头不完整。');
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== '8BPS') {
    invalid('文件签名不是 PSD / PSB，不能仅按扩展名打开。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4);
  if (version !== 1 && version !== 2) invalid('不支持此 Photoshop 文件版本。');
  if (bytes.subarray(6, 12).some(value => value !== 0)) invalid('Photoshop 文件头保留字段无效。');
  const channels = view.getUint16(12);
  const height = view.getUint32(14);
  const width = view.getUint32(18);
  const bitDepth = view.getUint16(22);
  const colorModeId = view.getUint16(24);
  if (channels < 1 || channels > 56) invalid('Photoshop 文件通道数无效。');
  if (![1, 8, 16, 32].includes(bitDepth)) invalid('Photoshop 文件位深无效。');
  const formatLimit = version === 1 ? 30000 : 300000;
  if (!width || !height || width > formatLimit || height > formatLimit) invalid('Photoshop 文件尺寸无效。');
  const colorModes: Record<number, string> = {
    0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK',
    7: 'Multichannel', 8: 'Duotone', 9: 'Lab',
  };
  return { format: version === 1 ? 'PSD' : 'PSB', version, width, height, channels,
    bitDepth, colorMode: colorModes[colorModeId] || `Unknown (${colorModeId})`, colorModeId };
}

// ag-psd accepts a typed-array-backed ImageData. Its Canvas path is never used.
initializeCanvas(
  () => { throw new Error('Canvas is unavailable in the composite decoder'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
);

/** Decode the saved RGB8 composite only; never interpret layer or thumbnail metadata. */
export function decodePhotoshop(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const header = readPhotoshopHeader(bytes);
  if (bytes.byteLength > LIMITS.photoshopBytes) {
    throw new QuickViewError('FILE_TOO_LARGE', 'PSD / PSB 超过本机预览的 32 MiB 文件上限。');
  }
  checkImageBudget(header.width, header.height, bytes.byteLength);
  if (header.colorModeId !== 3 || header.bitDepth !== 8 || ![3, 4].includes(header.channels)) {
    throw new QuickViewError('UNSUPPORTED_PHOTOSHOP', `此文件为 ${photoshopDescription(header)}；完整解码仅支持 RGB、8 位、3 或 4 通道合成图。请让发件人导出 PNG/JPG，或在 Photoshop 中转换后另存。`);
  }

  const view = new DataView(buffer);
  let offset = 26;
  const size = (wide = false, end = bytes.byteLength) => {
    const count = wide ? 8 : 4;
    if (offset + count > end) invalid('Photoshop 区段长度不完整。');
    // Every accepted file is <= 32 MiB, so any nonzero high word is already out of bounds.
    if (wide && view.getUint32(offset) !== 0) invalid('PSB 区段长度超过文件边界。');
    const length = view.getUint32(offset + (wide ? 4 : 0));
    offset += count;
    if (length > end - offset) invalid('Photoshop 区段长度超过文件边界。');
    return length;
  };
  const colorLength = size();
  offset += colorLength;
  const resourcesLength = size();
  const resourcesEnd = offset + resourcesLength;
  let profile: Uint8Array | undefined;
  // Only inspect the simple compatibility flag. No resource payload is passed to ag-psd.
  while (offset < resourcesEnd) {
    if (resourcesEnd - offset < 12) invalid('Photoshop 图像资源不完整。');
    const signature = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (!['8BIM', 'MeSa', 'AgHg', 'PHUT', 'DCSR'].includes(signature)) invalid('Photoshop 图像资源签名无效。');
    const id = view.getUint16(offset + 4);
    offset += 6;
    const nameBytes = bytes[offset] + 1;
    offset += nameBytes + (nameBytes % 2);
    const resourceLength = size(false, resourcesEnd);
    if (id === 1039) {
      if (profile || resourceLength > ICC_MAX_BYTES) throw new QuickViewError('INVALID_ICC', 'ICC 配置重复或超过 1 MiB。');
      profile = bytes.subarray(offset, offset + resourceLength);
    }
    if (id === 1057 && resourceLength >= 5 && bytes[offset + 4] === 0) {
      throw new QuickViewError('NO_COMPOSITE', '此文件未保存可用合成图。请启用 Photoshop 的“最大兼容性”后另存。');
    }
    offset += resourceLength + (resourceLength % 2);
    if (offset > resourcesEnd) invalid('Photoshop 图像资源填充越界。');
  }

  const color = inspectIcc(profile);
  const layerLength = size(header.version === 2);
  const layersStart = offset;
  let mergedAlpha = false;
  if (layerLength) {
    const layerInfoLength = size(header.version === 2, layersStart + layerLength);
    if (layerInfoLength) {
      if (layerInfoLength < 2) invalid('Photoshop 图层信息不完整。');
      mergedAlpha = view.getInt16(offset) < 0;
      if (mergedAlpha && header.channels !== 4) invalid('Photoshop 合成透明通道不完整。');
    }
  }
  offset = layersStart + layerLength;
  if (offset + 2 > bytes.byteLength) invalid('文件没有保存完整的合成图。');
  const compression = view.getUint16(offset);
  if (compression > 1) {
    throw new QuickViewError('UNSUPPORTED_COMPRESSION', `${photoshopDescription(header)}，压缩方式 ${compression === 2 ? 'ZIP' : compression === 3 ? 'ZIP Prediction' : compression}；当前仅支持 Raw / RLE 合成图。请让发件人导出 PNG/JPG。`);
  }
  validateComposite(bytes, view, offset + 2, header, compression);

  // A small header adaptation avoids the library's unrelated layer/pattern parsers.
  // The budget reserves the original, this composite copy, and a possible native bridge copy.
  const prefixLength = header.version === 2 ? 42 : 38;
  const composite = new Uint8Array(prefixLength + bytes.byteLength - offset);
  composite.set(bytes.subarray(0, 26));
  composite.set(bytes.subarray(offset), prefixLength);
  try {
    const document = readPsd(composite, {
      useImageData: true, skipLayerImageData: true, skipThumbnail: true,
      totalMemoryLimit: LIMITS.memoryBytes,
    });
    const pixels = document.imageData?.data;
    if (!(pixels instanceof Uint8ClampedArray) || pixels.length !== header.width * header.height * 4) {
      invalid('解析器未返回完整的合成图。');
    }
    // A fourth channel is a spot/extra channel unless the signed layer count marks merged alpha.
    for (let i = 0; i < pixels.length; i += 4) {
      if (!mergedAlpha) pixels[i + 3] = 255;
      else if (pixels[i + 3] !== 0 && pixels[i + 3] !== 255) {
        const scale = 255 / pixels[i + 3];
        for (let c = 0; c < 3; c++) pixels[i + c] = pixels[i + c] * scale + 255 * (1 - scale);
      }
    }
    applyIcc8(pixels, color);
    return { kind: 'raster' as const, format: header.format, width: header.width, height: header.height,
      pixels, colorMode: header.colorMode, bitDepth: header.bitDepth,
      warnings: [
        ...(header.format === 'PSB' ? ['PSB 预览为实验性支持，仅适用于限制范围内已保存合成图的文件。'] : []),
        '显示文件内保存的合成图；不重新渲染图层。',
        color.warning,
      ] };
  } catch (error) {
    if (error instanceof QuickViewError) throw error;
    if (error instanceof Error && /memory|alloc|array buffer|arraybuffer/i.test(error.message)) {
      throw new QuickViewError('DEVICE_MEMORY', '当前设备无法分配解码内存，请选择更小的 PSD / PSB。');
    }
    throw new QuickViewError('PHOTOSHOP_DECODE_FAILED', '无法读取此 Photoshop 合成图，文件可能损坏或使用了暂不支持的特性。');
  }
}

function validateComposite(bytes: Uint8Array, view: DataView, start: number, header: PhotoshopHeader, compression: number) {
  const { channels, width, height, version } = header;
  if (compression === 0) {
    if (bytes.byteLength - start !== width * height * channels) invalid('Raw 合成图数据长度与尺寸不符。');
    return;
  }
  const entryBytes = version === 2 ? 4 : 2;
  const rows = channels * height;
  let offset = start + rows * entryBytes;
  if (offset > bytes.byteLength) invalid('RLE 行长度表不完整。');
  for (let row = 0; row < rows; row++) {
    const entry = start + row * entryBytes;
    const length = entryBytes === 4 ? view.getUint32(entry) : view.getUint16(entry);
    const end = offset + length;
    if (end > bytes.byteLength) invalid('RLE 行数据超过文件边界。');
    let decoded = 0;
    while (offset < end) {
      const command = bytes[offset++];
      if (command < 128) { decoded += command + 1; offset += command + 1; }
      else if (command > 128) { decoded += 257 - command; offset++; }
      if (offset > end || decoded > width) invalid('RLE 行数据无效。');
    }
    if (decoded !== width) invalid('RLE 行像素数与图像宽度不符。');
  }
  if (offset !== bytes.byteLength) invalid('RLE 合成图包含多余数据。');
}
