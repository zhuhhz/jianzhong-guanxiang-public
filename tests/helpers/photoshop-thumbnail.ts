import { mkdir, open, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Self-created solid JPEG, encoded with Windows System.Drawing; no external artwork.
export const thumbnailJpeg = readFileSync('tests/fixtures/photoshop-thumbnail/solid-rgb.jpg');
export const thumbnailColor = [204, 103, 51] as const;
export const largePhotoshopPaths = {
  PSD: 'test-results/wechat-large-photoshop/generated-large-raw.psd',
  PSB: 'test-results/wechat-large-photoshop/generated-large-raw.psb',
} as const;

export function resource(id: number, data: Uint8Array, name = Buffer.alloc(0)): Buffer {
  const pascal = Buffer.concat([Buffer.from([name.length]), name]);
  const nameField = pascal.length % 2 ? Buffer.concat([pascal, Buffer.alloc(1)]) : pascal;
  const prefix = Buffer.alloc(6);
  prefix.write('8BIM'); prefix.writeUInt16BE(id, 4);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  return Buffer.concat([prefix, nameField, size, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])]);
}

export function thumbnailData(options: {
  jpeg?: Uint8Array; format?: number; width?: number; height?: number;
  widthBytes?: number; totalSize?: number; compressedSize?: number;
  bitsPerPixel?: number; planes?: number;
} = {}): Buffer {
  const jpeg = options.jpeg ?? thumbnailJpeg;
  const width = options.width ?? 64;
  const height = options.height ?? 48;
  const widthBytes = options.widthBytes ?? Math.floor((width * 24 + 31) / 32) * 4;
  const header = Buffer.alloc(28);
  [options.format ?? 1, width, height, widthBytes,
    options.totalSize ?? widthBytes * height, options.compressedSize ?? jpeg.length]
    .forEach((value, index) => header.writeUInt32BE(value, index * 4));
  header.writeUInt16BE(options.bitsPerPixel ?? 24, 24);
  header.writeUInt16BE(options.planes ?? 1, 26);
  return Buffer.concat([header, jpeg]);
}

export function photoshopPrefix(version: 1 | 2, width: number, height: number, resources: Uint8Array): Buffer {
  const header = Buffer.alloc(26);
  header.write('8BPS'); header.writeUInt16BE(version, 4); header.writeUInt16BE(3, 12);
  header.writeUInt32BE(height, 14); header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22); header.writeUInt16BE(3, 24);
  const resourceLength = Buffer.alloc(4); resourceLength.writeUInt32BE(resources.length);
  // No color-mode data, no layers/masks, and compression=0 (Raw RGB planar composite).
  return Buffer.concat([header, Buffer.alloc(4), resourceLength, resources,
    Buffer.alloc(version === 2 ? 8 : 4), Buffer.alloc(2)]);
}

export function smallPhotoshop(version: 1 | 2, resources: Uint8Array): Buffer {
  const width = 64; const height = 48;
  return Buffer.concat([photoshopPrefix(version, width, height, resources),
    ...thumbnailColor.map(color => Buffer.alloc(width * height, color))]);
}

export async function writeLargePhotoshop(version: 1 | 2, filePath: string): Promise<void> {
  const width = 4096; const height = 3072;
  const prefix = photoshopPrefix(version, width, height, resource(1036, thumbnailData()));
  const expectedSize = prefix.length + width * height * 3;
  try { if ((await stat(filePath)).size === expectedSize) return; } catch { /* Create below. */ }
  await mkdir(dirname(filePath), { recursive: true });
  const file = await open(filePath, 'w');
  try {
    await file.writeFile(prefix);
    for (const color of thumbnailColor) {
      const chunk = Buffer.alloc(256 * 1024, color);
      for (let remaining = width * height; remaining > 0;) {
        const count = Math.min(remaining, chunk.length);
        await file.writeFile(chunk.subarray(0, count));
        remaining -= count;
      }
    }
  } finally { await file.close(); }
}

export async function rangeReader(filePath: string) {
  const file = await open(filePath, 'r');
  const fileSize = (await file.stat()).size;
  const reads: { offset: number; length: number; returned: number }[] = [];
  return {
    fileSize, reads,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const bytes = Buffer.alloc(length);
      const result = await file.read(bytes, 0, length, offset);
      reads.push({ offset, length, returned: result.bytesRead });
      return bytes.subarray(0, result.bytesRead);
    },
    close: () => file.close(),
    totalRead: () => reads.reduce((sum, read) => sum + read.returned, 0),
    maxRead: () => Math.max(0, ...reads.map(read => read.length)),
  };
}

export async function verifyRawComposite(filePath: string, prefixLength: number): Promise<void> {
  const file = await open(filePath, 'r');
  const planeSize = 4096 * 3072;
  try {
    for (let channel = 0; channel < 3; channel++) {
      for (let offset = 0; offset < planeSize; offset += 256 * 1024) {
        const bytes = Buffer.alloc(Math.min(256 * 1024, planeSize - offset));
        const result = await file.read(bytes, 0, bytes.length, prefixLength + channel * planeSize + offset);
        if (result.bytesRead !== bytes.length || bytes.some(value => value !== thumbnailColor[channel])) {
          throw new Error('Generated Raw composite is incomplete or has unexpected pixels');
        }
      }
    }
  } finally { await file.close(); }
}
