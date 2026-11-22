import type { PhotoshopHeader } from './photoshop';
import { checkImageBudget, QuickViewError } from './shared';

export const THUMBNAIL_LIMITS = Object.freeze({
  jpegBytes: 2 * 1024 * 1024,
  resources: 4096,
});

type ResourceLocation = { offset: number; length: number; id: number };

function invalid(message: string): never {
  throw new QuickViewError('INVALID_PHOTOSHOP_THUMBNAIL', message);
}

function unsupported(message: string): never {
  throw new QuickViewError('UNSUPPORTED_PHOTOSHOP_THUMBNAIL', message);
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Read only the image-resource directory and the selected JPEG thumbnail.
 * Color data, unknown resource payloads, layers and the saved composite are skipped.
 * The caller has already checked the fixed Photoshop header with readPhotoshopHeader.
 */
export async function readPhotoshopResources(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  fileSize: number, header: PhotoshopHeader, ids: readonly number[],
) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 34
    || (header.version !== 1 && header.version !== 2)) invalid('PSD / PSB 缩略图区段不完整。');

  const range = async (offset: number, length: number, end = fileSize): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 1 || offset > end || length > end - offset) {
      invalid('PSD / PSB 缩略图区段超过文件边界。');
    }
    const bytes = await read(offset, length);
    if (!bytes || bytes.byteLength !== length) invalid('PSD / PSB 缩略图读取不完整。');
    return bytes;
  };

  const colorLength = viewOf(await range(26, 4)).getUint32(0);
  const resourcesLengthOffset = 30 + colorLength;
  const resourcesLength = viewOf(await range(resourcesLengthOffset, 4)).getUint32(0);
  let offset = resourcesLengthOffset + 4;
  if (resourcesLength > fileSize - offset) invalid('PSD / PSB 图像资源超过文件边界。');
  const resourcesEnd = offset + resourcesLength;
  const resources = new Map<number, ResourceLocation>();
  let count = 0;

  // PSD and PSB both use 32-bit lengths in this image-resource section.
  while (offset < resourcesEnd) {
    if (++count > THUMBNAIL_LIMITS.resources) {
      throw new QuickViewError('THUMBNAIL_TOO_LARGE', 'PSD / PSB 图像资源超过 4096 项，已停止读取缩略图。');
    }
    const prefix = await range(offset, 12, resourcesEnd);
    if (prefix[0] !== 0x38 || prefix[1] !== 0x42 || prefix[2] !== 0x49 || prefix[3] !== 0x4d) {
      invalid('PSD / PSB 图像资源签名无效。');
    }
    const id = viewOf(prefix).getUint16(4);
    const nameBytes = prefix[6] + 1;
    const paddedNameBytes = nameBytes + nameBytes % 2;
    const lengthOffset = offset + 6 + paddedNameBytes;
    const length = viewOf(paddedNameBytes === 2 ? prefix.subarray(8, 12)
      : await range(lengthOffset, 4, resourcesEnd)).getUint32(0);
    const payloadOffset = lengthOffset + 4;
    const paddedLength = length + length % 2;
    if (payloadOffset > resourcesEnd || paddedLength > resourcesEnd - payloadOffset) {
      invalid('PSD / PSB 图像资源或填充超过区段边界。');
    }
    if (ids.includes(id)) {
      if (id === 1039 && resources.has(id)) invalid('PSD / PSB 包含重复 ICC 配置。');
      if (!resources.has(id)) resources.set(id, { offset: payloadOffset, length, id });
    }
    offset = payloadOffset + paddedLength;
  }

  return { resources, range: (offset: number, length: number) => range(offset, length, resourcesEnd) };
}

export async function readPhotoshopThumbnail(
  read: (offset: number, length: number) => Promise<Uint8Array>, fileSize: number, header: PhotoshopHeader,
): Promise<{ jpeg: Uint8Array; width: number; height: number; resourceId: 1036 | 1033 }> {
  const { resources, range } = await readPhotoshopResources(read, fileSize, header, [1036, 1033]);
  const resource = resources.get(1036) || resources.get(1033);
  if (!resource) {
    throw new QuickViewError('NO_PHOTOSHOP_THUMBNAIL', '此 PSD / PSB 未保存可用的内嵌缩略图。');
  }
  if (resource.id === 1033) {
    unsupported('此文件只有旧版 BGR 缩略图（1033），当前不能保证其颜色正确；请在 Photoshop 中重新保存缩略图。');
  }
  if (resource.length < 28) invalid('PSD / PSB 内嵌缩略图头不完整。');
  const fields = viewOf(await range(resource.offset, 28));
  const format = fields.getUint32(0);
  const width = fields.getUint32(4);
  const height = fields.getUint32(8);
  const widthBytes = fields.getUint32(12);
  const totalSize = fields.getUint32(16);
  const compressedSize = fields.getUint32(20);
  const bitsPerPixel = fields.getUint16(24);
  const planes = fields.getUint16(26);
  if (format !== 1 || bitsPerPixel !== 24 || planes !== 1) {
    unsupported('此内嵌缩略图不是当前支持的 24 位单平面 JPEG。');
  }
  if (!compressedSize || compressedSize !== resource.length - 28) {
    invalid('PSD / PSB 缩略图压缩长度与资源长度不符。');
  }
  if (compressedSize > THUMBNAIL_LIMITS.jpegBytes) {
    throw new QuickViewError('THUMBNAIL_TOO_LARGE', 'PSD / PSB 内嵌 JPEG 缩略图超过 2 MiB，已停止读取。');
  }
  // Budget the small thumbnail only; the original document may be much larger.
  checkImageBudget(width, height, compressedSize, 3);
  const expectedWidthBytes = Math.floor((width * bitsPerPixel + 31) / 32) * 4;
  if (widthBytes !== expectedWidthBytes || totalSize !== expectedWidthBytes * height * planes) {
    invalid('PSD / PSB 缩略图行长度或未压缩长度与尺寸不符。');
  }
  const jpeg = await range(resource.offset + 28, compressedSize);
  checkJpegHeader(jpeg, width, height);
  return { jpeg, width, height, resourceId: 1036 };
}

/** Check bounded JPEG marker headers, not entropy data; the native image decoder validates the image. */
export function checkJpegHeader(bytes: Uint8Array, width?: number, height?: number): { width: number; height: number } {
  const end = bytes.byteLength - 2;
  if (end < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[end] !== 0xff || bytes[end + 1] !== 0xd9) invalid('内嵌 JPEG 缩略图缺少完整的起止标记。');
  const data = viewOf(bytes);
  let offset = 2;
  let hasFrame = false;
  let frame = { width: 0, height: 0 };
  let markers = 0;
  while (offset < end) {
    if (++markers > 1024) unsupported('内嵌 JPEG 缩略图头过于复杂。');
    if (bytes[offset++] !== 0xff) invalid('内嵌 JPEG 缩略图标记无效。');
    while (offset < end && bytes[offset] === 0xff) offset++;
    if (offset >= end) invalid('内嵌 JPEG 缩略图标记不完整。');
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9
      || (marker >= 0xd0 && marker <= 0xd7)) invalid('内嵌 JPEG 缩略图头包含无效标记。');
    if (marker === 0x01) continue;
    if (end - offset < 2) invalid('内嵌 JPEG 缩略图区段长度不完整。');
    const length = data.getUint16(offset);
    if (length < 2 || length > end - offset) invalid('内嵌 JPEG 缩略图区段超过边界。');
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) unsupported('当前仅支持 8 位 DCT JPEG 内嵌缩略图。');
      if (hasFrame || length < 8) invalid('内嵌 JPEG 缩略图帧头无效。');
      const precision = bytes[offset + 2];
      const frameHeight = data.getUint16(offset + 3);
      const frameWidth = data.getUint16(offset + 5);
      const channels = bytes[offset + 7];
      if (length !== 8 + channels * 3) invalid('内嵌 JPEG 缩略图帧头长度无效。');
      if (precision !== 8 || channels !== 3) unsupported('当前仅支持 8 位三通道 JPEG 内嵌缩略图。');
      if (width !== undefined && frameWidth !== width || height !== undefined && frameHeight !== height) invalid('内嵌 JPEG 缩略图尺寸与 Photoshop 资源头不符。');
      frame = { width: frameWidth, height: frameHeight };
      hasFrame = true;
    }
    if (marker === 0xda) {
      const channels = bytes[offset + 2];
      if (!hasFrame || length < 6 || channels < 1 || channels > 3 || length !== 6 + channels * 2
        || offset + length >= end) invalid('内嵌 JPEG 缩略图扫描头不完整。');
      return frame;
    }
    offset += length;
  }
  invalid('内嵌 JPEG 缩略图没有可用图像帧。');
}
