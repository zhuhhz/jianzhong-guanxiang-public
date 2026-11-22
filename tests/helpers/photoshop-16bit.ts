import assert from 'node:assert/strict';
import { readPhotoshopHeader } from '../../src/core/photoshop';
import { photoshopPrefix } from './photoshop-thumbnail';

export function raw16(options: { width?: number; height?: number; channels?: number; count?: number;
  primaryCount?: number; compression?: number; resources?: Uint8Array } = {}) {
  const width = options.width ?? 4; const height = options.height ?? 3; const channels = options.channels ?? 3;
  const header = Buffer.from(photoshopPrefix(1, width, height, Buffer.alloc(0)).subarray(0, 26));
  header.writeUInt16BE(16, 22); header.writeUInt16BE(channels, 12);
  const primary = options.primaryCount === undefined ? Buffer.alloc(0) : Buffer.alloc(2);
  if (primary.length) primary.writeInt16BE(options.primaryCount!);
  const primarySize = Buffer.alloc(4); primarySize.writeUInt32BE(primary.length);
  const tag = options.count === undefined ? Buffer.alloc(0) : Buffer.alloc(16);
  if (tag.length) { tag.write('8BIMLr16'); tag.writeUInt32BE(2, 8); tag.writeInt16BE(options.count!, 12); }
  const layers = Buffer.concat([primarySize, primary, Buffer.alloc(4), tag]);
  const layerSize = Buffer.alloc(4); layerSize.writeUInt32BE(layers.length);
  const compression = Buffer.alloc(2); compression.writeUInt16BE(options.compression ?? 0);
  const pixels = Buffer.alloc(width * height * channels * 2);
  const value = (c: number, x: number, y: number) => c < 3
    ? (((c * 67 + x * 17 + y * 11) & 255) << 8) | ((255 - x * 19 - y * 7) & 255)
    : c === 3 ? 0 : 65535;
  for (let c = 0; c < channels; c++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.writeUInt16BE(value(c, x, y), ((c * height + y) * width + x) * 2);
  }
  const resources = options.resources ?? Buffer.alloc(0);
  const resourceSize = Buffer.alloc(4); resourceSize.writeUInt32BE(resources.length);
  const bytes = Buffer.concat([header, Buffer.alloc(4), resourceSize, resources, layerSize, layers, compression, pixels]);
  const dataOffset = bytes.length - pixels.length;
  const reads: { offset: number; length: number }[] = [];
  const read = async (offset: number, length: number) => {
    assert.ok(offset >= 0 && offset + length <= bytes.length);
    reads.push({ offset, length });
    return bytes.subarray(offset, offset + length);
  };
  return { bytes, dataOffset, reads, read, header: readPhotoshopHeader(bytes), value };
}
