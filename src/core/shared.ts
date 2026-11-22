export class QuickViewError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'QuickViewError'; }
}

// Conservative application limits; these are budgets, not device memory guarantees.
export const LIMITS = Object.freeze({
  photoshopBytes: 32 * 1024 * 1024,
  aiBytes: 32 * 1024 * 1024,
  svgBytes: 1024 * 1024,
  pixels: 4 * 1024 * 1024,
  side: 4096,
  canvasSide: 1365,
  memoryBytes: 96 * 1024 * 1024,
});

export function checkImageBudget(width: number, height: number, fileBytes: number, channels = 4): number {
  if (![width, height, fileBytes, channels].every(Number.isSafeInteger) || width < 1 || height < 1 || fileBytes < 0 || channels < 1) {
    throw new QuickViewError('INVALID_DIMENSIONS', '文件中的图像尺寸或通道数无效。');
  }
  if (width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.pixels) {
    throw new QuickViewError('IMAGE_TOO_LARGE', '图像尺寸过大：单边最多 4096 像素，总计最多 4,194,304 像素。');
  }
  // Original + composite envelope + possible file bridge copy; planar input +
  // RGBA + ImageData + Canvas + export/readback. Native overhead is still device dependent.
  const estimatedBytes = fileBytes * 3 + width * height * (channels + 20);
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > LIMITS.memoryBytes) {
    throw new QuickViewError('MEMORY_BUDGET', '预计解码内存超出 96 MiB 预算，请选择更小的文件或降低图像尺寸。');
  }
  return estimatedBytes;
}

// Mini Program JS has neither Buffer nor a guaranteed TextEncoder.
export function utf8ByteLength(text: string): number {
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) size++;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
    else size += 3;
  }
  return size;
}
