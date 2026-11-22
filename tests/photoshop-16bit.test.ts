import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPsd } from 'ag-psd';
import { openPhotoshopComposite } from '../src/core/photoshop-preview';
import { raw16 } from './helpers/photoshop-16bit';

test('opt-in RGB16 Raw reads true big-endian pixels and only the requested columns', async () => {
  const file = raw16();
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true });
  file.reads.length = 0;
  const raster = await session.decodeRegion({ x: 1, y: 1, width: 2, height: 2 }, { width: 2, height: 2 });
  const expected: number[] = [];
  for (let y = 1; y < 3; y++) for (let x = 1; x < 3; x++) expected.push(
    file.value(0, x, y) >>> 8, file.value(1, x, y) >>> 8, file.value(2, x, y) >>> 8, 255);
  assert.deepEqual(Array.from(raster.pixels), expected);
  assert.equal(file.reads.length, 6);
  assert.ok(file.reads.every(range => range.length === 4));
  assert.deepEqual(file.reads.map(range => range.offset), [0, 1, 2].flatMap(c => [1, 2]
    .map(y => file.dataOffset + ((c * 3 + y) * 4 + 1) * 2)));
});

test('RGB16 Raw agrees with independent ag-psd uint16 decoding for every known sample', async () => {
  const file = raw16();
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true });
  const raster = await session.decodeRegion({ x: 0, y: 0, width: 4, height: 3 }, { width: 4, height: 3 });
  const reference = readPsd(file.bytes, { useImageData: true, skipLayerImageData: true, skipThumbnail: true }).imageData!;
  assert.ok(reference.data instanceof Uint16Array);
  assert.deepEqual(Array.from(raster.pixels), Array.from(reference.data, value => value >>> 8));
});

test('five RGB16 channels with positive Lr16 preserve opacity and do not read saved masks as Alpha', async () => {
  const file = raw16({ channels: 5, count: 1 });
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true });
  file.reads.length = 0;
  const raster = await session.decodeRegion({ x: 2, y: 1, width: 1, height: 1 }, { width: 1, height: 1 });
  assert.deepEqual(Array.from(raster.pixels), [file.value(0, 2, 1) >>> 8,
    file.value(1, 2, 1) >>> 8, file.value(2, 2, 1) >>> 8, 255]);
  assert.equal(file.reads.length, 3);
  assert.ok(file.reads.every(range => range.offset + range.length <= file.dataOffset + 4 * 3 * 3 * 2));
  assert.ok(raster.warnings.some(text => text.includes('2 个独立额外通道')));
});

test('negative Lr16 or primary merged-alpha markers safely refuse unverified RGB16 transparency', async () => {
  for (const file of [raw16({ channels: 4, count: -1 }), raw16({ channels: 4, primaryCount: -1 })]) {
    await assert.rejects(openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true }),
      { code: 'UNSUPPORTED_PHOTOSHOP' });
    assert.ok(file.reads.every(range => range.offset < file.dataOffset));
  }
});

test('RGB16 core requires explicit opt-in', async () => {
  const file = raw16();
  await assert.rejects(openPhotoshopComposite(file.read, file.bytes.length, file.header), { code: 'UNSUPPORTED_PHOTOSHOP' });
  assert.equal(file.reads.length, 0);
});

test('RGB16 RLE, ZIP, ZIP Prediction and PSB stay outside this Raw PSD POC', async () => {
  for (const compression of [1, 2, 3]) {
    const file = raw16({ compression });
    await assert.rejects(openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true }),
      { code: 'UNSUPPORTED_COMPRESSION' });
    assert.ok(file.reads.every(range => range.offset < file.dataOffset));
  }
  const file = raw16();
  await assert.rejects(openPhotoshopComposite(file.read, file.bytes.length,
    { ...file.header, version: 2, format: 'PSB' }, { rgb16Raw: true }), { code: 'UNSUPPORTED_PHOTOSHOP' });
});

test('RGB16 validates all declared planar bytes, including unused channels, before reading pixels', async () => {
  const file = raw16({ channels: 5, count: 1 });
  for (const delta of [-1, 1]) {
    await assert.rejects(openPhotoshopComposite(file.read, file.bytes.length + delta, file.header, { rgb16Raw: true }),
      { code: 'INVALID_PHOTOSHOP' });
  }
  assert.ok(file.reads.every(range => range.offset < file.dataOffset));
});

test('RGB16 Lr16 lengths and signatures cannot escape the layer section', async () => {
  for (const corrupt of ['length', 'signature', 'padding'] as const) {
    const file = raw16({ channels: 5, count: 1 });
    const tag = 26 + 8 + 4 + 8;
    if (corrupt === 'length') file.bytes.writeUInt32BE(0xffffffff, tag + 8);
    if (corrupt === 'signature') file.bytes.write('BAD!', tag);
    if (corrupt === 'padding') file.bytes.writeUInt32BE(5, tag + 8);
    await assert.rejects(openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true }),
      { code: 'INVALID_PHOTOSHOP' });
  }
});

test('RGB16 cancels an in-flight row before consuming it and a new request can recover', async () => {
  const file = raw16();
  let current = true;
  const session = await openPhotoshopComposite(async (offset, length) => {
    const bytes = await file.read(offset, length);
    if (offset >= file.dataOffset) current = false;
    return bytes;
  }, file.bytes.length, file.header, { rgb16Raw: true });
  await assert.rejects(session.decodeRegion({ x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 },
    { isCurrent: () => current }), { code: 'CANCELLED' });
  const raster = await session.decodeRegion({ x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 });
  assert.deepEqual(Array.from(raster.pixels), [0, 67, 134, 255]);
});

test('RGB16 8/16/32-row batches match single rows and account for inter-row column gaps and partial tails', async () => {
  const file = raw16({ width: 89, height: 51, channels: 5, count: 1 });
  const rect = { x: 3, y: 5, width: 17, height: 33 };
  let expected: Uint8ClampedArray | undefined;
  for (const batchRows of [1, 8, 16, 32] as const) {
    const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header,
      { rgb16Raw: true, rgb16RawBatchRows: batchRows });
    file.reads.length = 0;
    const raster = await session.decodeRegion(rect, { width: 17, height: 33 });
    if (expected) assert.deepEqual(raster.pixels, expected);
    else expected = raster.pixels;
    const groups = Math.ceil(rect.height / batchRows);
    assert.equal(file.reads.length, groups * 3);
    assert.equal(file.reads.reduce((sum, r) => sum + r.length, 0),
      ((rect.height - groups) * 89 * 2 + groups * rect.width * 2) * 3);
    assert.ok(file.reads.every(r => r.offset >= file.dataOffset
      && r.offset + r.length <= file.dataOffset + 89 * 51 * 3 * 2));
  }
});

test('RGB16 batch reads are capped at 512 KiB even for wide sources and release state between regions', async () => {
  const file = raw16({ width: 9000, height: 40, channels: 5, count: 1 });
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header,
    { rgb16Raw: true, rgb16RawBatchRows: 32 });
  file.reads.length = 0;
  for (const x of [20, 7020]) {
    const raster = await session.decodeRegion({ x, y: 0, width: 9, height: 40 }, { width: 9, height: 40 });
    for (let y = 0; y < 40; y++) for (let col = 0; col < 9; col++) for (let c = 0; c < 3; c++) {
      assert.equal(raster.pixels[(y * 9 + col) * 4 + c], file.value(c, x + col, y) >>> 8);
    }
  }
  assert.ok(Math.max(...file.reads.map(r => r.length)) <= 512 * 1024);
  assert.equal(file.reads.length, 12); // At most 30 rows fit this source stride, so two blocks per channel/request.
});

test('RGB16 batch cancellation stops after one pending read without blocking a fresh region', async () => {
  for (const batchRows of [8, 16, 32] as const) {
    const file = raw16({ width: 89, height: 51, channels: 5, count: 1 });
    let current = true;
    const session = await openPhotoshopComposite(async (offset, length) => {
      const result = await file.read(offset, length);
      if (offset >= file.dataOffset) current = false;
      return result;
    }, file.bytes.length, file.header, { rgb16Raw: true, rgb16RawBatchRows: batchRows });
    file.reads.length = 0;
    await assert.rejects(session.decodeRegion({ x: 3, y: 5, width: 17, height: 33 }, { width: 17, height: 33 },
      { isCurrent: () => current }), { code: 'CANCELLED' });
    assert.equal(file.reads.length, 1);
    const fresh = await session.decodeRegion({ x: 4, y: 6, width: 1, height: 1 }, { width: 1, height: 1 });
    assert.deepEqual(Array.from(fresh.pixels), [file.value(0, 4, 6) >>> 8,
      file.value(1, 4, 6) >>> 8, file.value(2, 4, 6) >>> 8, 255]);
  }
});

test('RGB16 overview keeps sparse single-row sampling instead of reading all intervening rows', async () => {
  const file = raw16({ width: 89, height: 51, channels: 5, count: 1 });
  const snapshots: { pixels: Uint8ClampedArray; reads: { offset: number; length: number }[] }[] = [];
  for (const batchRows of [1, 32] as const) {
    const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header,
      { rgb16Raw: true, rgb16RawBatchRows: batchRows });
    file.reads.length = 0;
    const raster = await session.decodeRegion({ x: 0, y: 0, width: 89, height: 51 }, { width: 9, height: 5 }, { overview: true });
    snapshots.push({ pixels: raster.pixels, reads: file.reads.slice() });
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
});
