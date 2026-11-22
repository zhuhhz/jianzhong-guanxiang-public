import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { inspectIcc, readPhotoshopIcc, applyIcc8 } from '../src/core/icc';
import { decodePhotoshop, readPhotoshopHeader } from '../src/core/photoshop';
import { openPhotoshopComposite } from '../src/core/photoshop-preview';
import { matrixIcc } from './helpers/icc';
import { raw16 } from './helpers/photoshop-16bit';
import { resource, photoshopPrefix } from './helpers/photoshop-thumbnail';

test('numeric sRGB identity, missing and unsupported ICC remain distinct', () => {
  const srgb = inspectIcc(matrixIcc(true)); assert.equal(srgb.kind, 'srgb'); assert.equal(srgb.convert, undefined);
  assert.equal(inspectIcc().kind, 'unmanaged');
  const lut = matrixIcc(); lut.write('A2B0', 132); assert.equal(inspectIcc(lut).kind, 'unmanaged');
  const pixels = new Uint8ClampedArray([12, 99, 244, 128, 0, 255, 4, 0]); const before = pixels.slice();
  applyIcc8(pixels, srgb); assert.deepEqual(pixels, before);
});

test('a custom monotonic curve between sparse sRGB probes never bypasses conversion', () => {
  const bytes = matrixIcc(true), at = bytes.readUInt32BE(136 + 4 * 12);
  for (let i = 330; i <= 390; i++) {
    const old = bytes.readUInt16BE(at + 12 + i * 2);
    bytes.writeUInt16BE(old + Math.round(130 * Math.sin((i - 330) / 60 * Math.PI)), at + 12 + i * 2);
  }
  assert.equal(inspectIcc(bytes).kind, 'matrix');
});

test('matrix/TRC converts neutral/black/white and chromatic samples, independent of a profile name', () => {
  const color = inspectIcc(matrixIcc()); assert.equal(color.kind, 'matrix');
  const black = color.convert!(0, 0, 0), white = color.convert!(1, 1, 1);
  assert.deepEqual(black, [0, 0, 0]); assert.ok(white.every(c => c > .999));
  const values = color.convert!(.5, .3, .4); assert.ok(values[0] > .5 && values[1] > .3 && values[2] > .4);
  assert.ok(color.convert!(1, 0, 0).every(c => c >= 0 && c <= 1));
});

test('ICC validates header, offsets, partial overlaps, reserved bytes, truncation and monotonic curves', () => {
  for (const change of [
    (b: Buffer) => b.write('BAD!', 36), (b: Buffer) => b.writeUInt32BE(999999, 0),
    (b: Buffer) => b.writeUInt32BE(1, 136), (b: Buffer) => b.writeUInt32BE(999999, 140),
    (b: Buffer) => b.writeUInt32BE(b.readUInt32BE(136) + 4, 148),
    (b: Buffer) => b.writeUInt32BE(1, b.readUInt32BE(136) + 4),
    (b: Buffer) => b.writeUInt32BE(99, b.readUInt32BE(136 + 4 * 12) + 8),
  ]) { const bytes = matrixIcc(); change(bytes); assert.throws(() => inspectIcc(bytes), { code: 'INVALID_ICC' }); }
  const curve = matrixIcc(true), at = curve.readUInt32BE(136 + 4 * 12); curve.writeUInt16BE(65535, at + 14);
  assert.throws(() => inspectIcc(curve), { code: 'INVALID_ICC' });
  // Exact shared r/g/b payloads in the valid helper remain accepted.
  assert.equal(inspectIcc(matrixIcc()).kind, 'matrix');
});

test('bounded PSD and PSB ICC resources are read without touching composite or layers', async () => {
  for (const version of [1, 2] as const) {
    const bytes = photoshopPrefix(version, 3, 2, resource(1039, matrixIcc()));
    const reads: number[] = [];
    const color = await readPhotoshopIcc(async (offset, length) => { reads.push(offset + length); return bytes.subarray(offset, offset + length); }, bytes.length, readPhotoshopHeader(bytes));
    assert.equal(color.kind, 'matrix'); assert.ok(Math.max(...reads) <= bytes.length - (version === 2 ? 10 : 6));
    const broken = Buffer.from(bytes); broken.writeUInt32BE(0xffffffff, 42);
    await assert.rejects(readPhotoshopIcc(async (o, n) => broken.subarray(o, o + n), broken.length, readPhotoshopHeader(broken)));
  }
});

test('RGB16 conversion preserves low bits until after ICC, shares color across overview/HD and caches metadata', async () => {
  const file = raw16({ channels: 5, count: 1, resources: resource(1039, matrixIcc()) });
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true, rgb16RawBatchRows: 16 });
  file.reads.length = 0; const color = inspectIcc(matrixIcc());
  for (const overview of [false, true]) {
    const image = await session.decodeRegion({ x: 0, y: 0, width: 4, height: 3 }, { width: 4, height: 3 }, { overview });
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
      const expected = color.convert!(file.value(0, x, y) / 65535, file.value(1, x, y) / 65535, file.value(2, x, y) / 65535);
      for (let c = 0; c < 3; c++) assert.equal(image.pixels[(y * 4 + x) * 4 + c], Math.round(expected[c] * 255));
      assert.equal(image.pixels[(y * 4 + x) * 4 + 3], 255);
    }
  }
  assert.ok(file.reads.every(r => r.offset >= file.dataOffset));
});

test('RGB8 Raw/RLE and PSB full decode apply the same transform while preserving Alpha', () => {
  for (const version of [1, 2] as const) for (const rle of [false, true]) {
    const prefix = photoshopPrefix(version, 1, 1, resource(1039, matrixIcc()));
    const values = [100, 80, 60]; let composite: Buffer;
    if (rle) {
      prefix.writeUInt16BE(1, prefix.length - 2); const table = Buffer.alloc(3 * (version === 2 ? 4 : 2));
      for (let c = 0; c < 3; c++) version === 2 ? table.writeUInt32BE(2, c * 4) : table.writeUInt16BE(2, c * 2);
      composite = Buffer.concat([table, ...values.map(v => Buffer.from([0, v]))]);
    } else composite = Buffer.from(values);
    const bytes = Buffer.concat([prefix, composite]); const image = decodePhotoshop(Uint8Array.from(bytes).buffer);
    const expected = inspectIcc(matrixIcc()).convert!(...values.map(v => v / 255) as [number, number, number]);
    assert.deepEqual(Array.from(image.pixels), [...expected.map(v => Math.round(v * 255)), 255]);
  }
});

test('exact area averaging removes high-frequency phase aliasing and supports fractional edges', async () => {
  const width = 224, height = 16, prefix = photoshopPrefix(1, width, height, Buffer.alloc(0));
  const pixels = Buffer.alloc(width * height * 3);
  for (let c = 0; c < 3; c++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[(c * height + y) * width + x] = x % 7 === 0 ? 255 : 0;
  const bytes = Buffer.concat([prefix, pixels]); const session = await openPhotoshopComposite(async (o, n) => bytes.subarray(o, o + n), bytes.length, readPhotoshopHeader(bytes));
  const image = await session.decodeRegion({ x: .5, y: .25, width: 210, height: 14 }, { width: 10, height: 1 }, { quality: 'area' });
  for (let i = 0; i < image.pixels.length; i += 4) assert.deepEqual(Array.from(image.pixels.slice(i, i + 4)), [36, 36, 36, 255]);
});

test('a transparent small PSD retains alpha 0/128/255 through ICC without changing the source', () => {
  const original = readFileSync('tests/fixtures/photoshop/generated-alpha.psd');
  const payload = resource(1039, matrixIcc()), size = Buffer.alloc(4), existing = original.readUInt32BE(30);
  size.writeUInt32BE(payload.length + existing);
  const bytes = Buffer.concat([original.subarray(0, 30), size, original.subarray(34, 34 + existing), payload, original.subarray(34 + existing)]);
  const before = Buffer.from(bytes), plain = decodePhotoshop(Uint8Array.from(original).buffer);
  const managed = decodePhotoshop(Uint8Array.from(bytes).buffer);
  assert.deepEqual(Array.from(managed.pixels).filter((_v, i) => i % 4 === 3),
    Array.from(plain.pixels).filter((_v, i) => i % 4 === 3));
  assert.deepEqual(bytes, before);
});

test('area RGB16 export remains high precision and cancellable without changing legacy sparse preview', async () => {
  const file = raw16({ width: 51, height: 35, channels: 5, count: 1, resources: resource(1039, matrixIcc()) });
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true, rgb16RawBatchRows: 16 });
  const region = { x: 0, y: 0, width: 51, height: 35 }, output = { width: 3, height: 5 };
  const image = await session.decodeRegion(region, output, { overview: true, quality: 'area' });
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    const sums = [0, 0, 0];
    for (let sy = y * 7; sy < y * 7 + 7; sy++) for (let sx = x * 17; sx < x * 17 + 17; sx++) {
      for (let c = 0; c < 3; c++) sums[c] += file.value(c, sx, sy) / (65535 * 119);
    }
    const expected = inspectIcc(matrixIcc()).convert!(...sums as [number, number, number]);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(image.pixels[(y * 3 + x) * 4 + c] - Math.round(expected[c] * 255)) <= 1);
  }
  await assert.rejects(session.decodeRegion(region, output, { quality: 'area', isCurrent: () => false }), { code: 'CANCELLED' });
  assert.deepEqual((await session.decodeRegion(region, output, { quality: 'area' })).pixels, image.pixels);
});
