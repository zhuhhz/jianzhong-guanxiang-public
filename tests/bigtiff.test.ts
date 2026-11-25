import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectBigTiffFile } from '../src/core/bigtiff';
import { inspectTiffFile, previewRawTiff } from '../src/core/tiff-preview';
import { prepareAndroidPreview } from '../src/platform/android';

function fixture(little: boolean) {
  const bytes = new Uint8Array(320), data = new DataView(bytes.buffer);
  const ifdAt = 48, tableAt = 304, stripOffsets = [16, 32];
  const set64 = (at: number, value: number) => data.setBigUint64(at, BigInt(value), little);
  bytes.set(little ? [73, 73] : [77, 77]);
  data.setUint16(2, 43, little);
  data.setUint16(4, 8, little);
  set64(8, ifdAt);
  const samples = [65535, 0, 0, 0, 65535, 0, 0, 0, 65535, 21845, 43690, 65535];
  samples.forEach((value, i) => data.setUint16(stripOffsets[Math.floor(i / 6)] + i % 6 * 2, value, little));
  const tags: [number, number, number[]][] = [
    [256, 4, [2]], [257, 4, [2]], [258, 3, [16, 16, 16]], [259, 3, [1]], [262, 3, [2]],
    [273, 16, stripOffsets], [274, 3, [1]], [277, 3, [3]], [278, 4, [1]], [279, 4, [12, 12]], [284, 3, [1]],
  ];
  set64(ifdAt, tags.length);
  const offsets = new Map<number, number>();
  for (const [index, [tag, type, values]] of tags.entries()) {
    const at = ifdAt + 8 + index * 20;
    offsets.set(tag, at);
    data.setUint16(at, tag, little);
    data.setUint16(at + 2, type, little);
    set64(at + 4, values.length);
    if (type === 16) {
      set64(at + 12, tableAt);
      values.forEach((value, i) => set64(tableAt + i * 8, value));
    } else if (type === 4) {
      values.forEach((value, i) => data.setUint32(at + 12 + i * 4, value, little));
    } else {
      values.forEach((value, i) => data.setUint16(at + 12 + i * 2, value, little));
    }
  }
  const read = async (at: number, length: number) => {
    assert.ok(Number.isSafeInteger(at) && at >= 0 && at <= bytes.length - length && length <= 65536);
    return bytes.subarray(at, at + length);
  };
  return { bytes, data, read, ifdAt, tableAt, offsets };
}

for (const little of [true, false]) {
  test(`Android uses shared TIFF region and PNG rows for ${little ? 'little' : 'big'} endian BigTIFF`, async () => {
    const { bytes, read } = fixture(little);
    const result = await prepareAndroidPreview(read, bytes.length, 'sample.tf8');
    assert.equal(result.metadata.format, 'TIFF');
    assert.match(result.metadata.details, /BigTIFF/);
    assert.equal(result.metadata.exportKind, 'nativePng');
    const rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255, 85, 170, 255];
    const rgba = rgb.flatMap((value, i) => i % 3 === 2 ? [value, 255] : [value]);
    assert.deepEqual([...result.payload!], rgba);
    const metadata = await inspectBigTiffFile(read, bytes.length);
    const detail = await previewRawTiff(read, bytes.length, metadata, () => true, {
      region: { x: 1, y: 1, width: 1, height: 1 },
    });
    assert.deepEqual([...detail.pixels], [85, 170, 255, 255]);
    const source = await result.nativeRows!(() => true), rows: number[] = [];
    await source.readRows(async ({ data }) => { rows.push(...data); });
    assert.deepEqual(rows, rgb);
    await assert.rejects(inspectTiffFile(read, bytes.length), { code: 'UNSUPPORTED_TIFF' });
  });
}

test('BigTIFF caps counts and safely rejects malformed 64-bit strip pointers and pixel ranges', async () => {
  let sample = fixture(true);
  sample.data.setBigUint64(sample.ifdAt, 257n, true);
  await assert.rejects(inspectBigTiffFile(sample.read, sample.bytes.length), { code: 'INVALID_TIFF' });
  sample = fixture(true);
  sample.data.setBigUint64(sample.tableAt, 1n << 53n, true);
  await assert.rejects(inspectBigTiffFile(sample.read, sample.bytes.length), { code: 'INVALID_TIFF' });
  sample = fixture(true);
  sample.data.setBigUint64(sample.tableAt + 8, 318n, true);
  const metadata = await inspectBigTiffFile(sample.read, sample.bytes.length);
  await assert.rejects(previewRawTiff(sample.read, sample.bytes.length, metadata, () => true), { code: 'INVALID_TIFF' });
});

test('BigTIFF refuses tiled or compressed layouts before allocating a raster', async () => {
  let sample = fixture(true);
  sample.data.setUint16(sample.offsets.get(259)! + 12, 5, true);
  await assert.rejects(inspectBigTiffFile(sample.read, sample.bytes.length), { code: 'UNSUPPORTED_TIFF' });
  sample = fixture(true);
  sample.data.setUint16(sample.offsets.get(273)!, 324, true);
  await assert.rejects(inspectBigTiffFile(sample.read, sample.bytes.length), { code: 'UNSUPPORTED_TIFF' });
});
