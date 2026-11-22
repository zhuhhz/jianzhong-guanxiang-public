import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readPhotoshopHeader } from '../src/core/photoshop';
import { openPhotoshopComposite } from '../src/core/photoshop-preview';
import { inspectIcc } from '../src/core/icc';
import { raw16 } from './helpers/photoshop-16bit';
import { matrixIcc } from './helpers/icc';
import { photoshopPrefix, resource } from './helpers/photoshop-thumbnail';

for (const extension of ['psd', 'psb']) for (const compression of ['raw', 'rle']) {
  test(`native rows preserve all source coordinates for RGB8 ${compression} ${extension}`, async () => {
    const bytes = readFileSync(`tests/fixtures/photoshop/generated-${compression}.${extension}`);
    const session = await openPhotoshopComposite(async (o, n) => bytes.subarray(o, o + n), bytes.length, readPhotoshopHeader(bytes));
    const actual: number[] = [];
    let nextY = 0;
    assert.equal(session.nativeChannels, 3);
    assert.equal(session.nativeSrgb, false);
    assert.match(session.nativeWarnings.join(' '), /ICC/);
    for await (const row of session.rows()) {
      assert.equal(row.y, nextY++);
      assert.equal(row.data.length, 9);
      actual.push(...row.data);
    }
    assert.equal(nextY, 2);
    assert.deepEqual(actual, [255, 0, 0, 0, 255, 0, 0, 0, 255, 21, 21, 21, 21, 21, 21, 21, 21, 21]);
  });
}

test('RGB16 native rows retain all low bits through ICC, ignore extra planes, and bound stripe reads', async () => {
  const icc = matrixIcc();
  const file = raw16({ width: 33, height: 37, channels: 5, count: 1, resources: resource(1039, icc) });
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true });
  file.reads.length = 0;
  let nextY = 0;
  const color = inspectIcc(icc);
  for await (const row of session.rows()) {
    assert.equal(row.y, nextY++);
    for (let x = 0; x < 33; x++) {
      const expected = color.convert!(file.value(0, x, row.y) / 65535, file.value(1, x, row.y) / 65535, file.value(2, x, row.y) / 65535);
      for (let c = 0; c < 3; c++) assert.equal(row.data[x * 3 + c], Math.round(expected[c] * 255));
    }
  }
  assert.equal(nextY, 37);
  assert.equal(session.nativeSrgb, true);
  assert.equal(file.reads.length, 9);
  assert.equal(file.reads.reduce((n, r) => n + r.length, 0), 33 * 37 * 3 * 2);
  assert.ok(file.reads.every(r => r.length <= 512 * 1024 && r.offset + r.length <= file.dataOffset + 33 * 37 * 3 * 2));
});

test('native rows preserve verified sRGB values without applying a second color transform', async () => {
  const prefix = photoshopPrefix(1, 2, 1, resource(1039, matrixIcc(true)));
  const bytes = Buffer.concat([prefix, Buffer.from([3, 241, 19, 17, 127, 255])]);
  const session = await openPhotoshopComposite(async (o, n) => bytes.subarray(o, o + n), bytes.length, readPhotoshopHeader(bytes));
  const result = await session.rows().next();
  assert.equal(session.nativeSrgb, true);
  assert.deepEqual(Array.from(result.value!.data), [3, 19, 127, 241, 17, 255]);
});

test('native cancellation stops all future reads and per-invocation buffers do not interfere', async () => {
  const file = raw16({ width: 3, height: 35 });
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true });
  let active = true;
  const first = session.rows({ isCurrent: () => active });
  const second = session.rows();
  const a = (await first.next()).value!;
  const copy = a.data.slice();
  await second.next(); await second.next();
  assert.deepEqual(a.data, copy);
  active = false;
  const reads = file.reads.length;
  await assert.rejects(first.next(), { code: 'CANCELLED' });
  assert.equal(file.reads.length, reads);
  await second.return(undefined);
  const cancelled = session.rows({ isCurrent: () => false });
  await assert.rejects(cancelled.next(), { code: 'CANCELLED' });
  assert.equal(file.reads.length, reads);
});

test('a malformed late RLE row fails during native export rather than inventing pixels', async () => {
  const bytes = Buffer.from(readFileSync('tests/fixtures/photoshop/generated-rle.psd'));
  bytes[bytes.length - 2] = 255; // Repeat two samples rather than the declared width of three.
  const header = readPhotoshopHeader(bytes);
  const session = await openPhotoshopComposite(async (o, n) => bytes.subarray(o, o + n), bytes.length, header);
  await assert.rejects(async () => { for await (const row of session.rows()) void row; }, { code: 'INVALID_PHOTOSHOP' });
});

test('PSB maximum-width native row uses bounded planar reads without a full-image allocation', async () => {
  const width = 300000, height = 2;
  const prefix = photoshopPrefix(2, width, height, Buffer.alloc(0));
  const size = prefix.length + width * height * 3;
  const reads: number[] = [];
  const session = await openPhotoshopComposite(async (o, n) => {
    reads.push(n);
    if (o < prefix.length) return prefix.subarray(o, o + n);
    return new Uint8Array(n).fill(Math.floor((o - prefix.length) / (width * height)) + 1);
  }, size, readPhotoshopHeader(prefix));
  for await (const row of session.rows()) {
    assert.equal(row.data.length, 900000);
    for (const x of [0, width >> 1, width - 1]) assert.deepEqual(Array.from(row.data.subarray(x * 3, x * 3 + 3)), [1, 2, 3]);
  }
  assert.ok(Math.max(...reads) <= 512 * 1024);
});

test('callback rows match the async iterator for RGB8 PSD/PSB Raw/RLE and RGB16 ICC', async () => {
  const files = ['psd', 'psb'].flatMap(extension => ['raw', 'rle'].map(compression => {
    const bytes = readFileSync(`tests/fixtures/photoshop/generated-${compression}.${extension}`);
    return { bytes, read: async (o: number, n: number) => bytes.subarray(o, o + n) };
  }));
  const sixteen = raw16({ width: 31, height: 35, channels: 5, count: 1, resources: resource(1039, matrixIcc()) });
  files.push(sixteen);
  for (const file of files) {
    const session = await openPhotoshopComposite(file.read, file.bytes.length, readPhotoshopHeader(file.bytes), { rgb16Raw: true });
    const expected: Buffer[] = [];
    for await (const row of session.rows()) expected.push(Buffer.from(row.data));
    let y = 0;
    await session.readRows(async row => {
      assert.equal(row.y, y);
      assert.deepEqual(Buffer.from(row.data), expected[y++]);
    });
    assert.equal(y, session.height);
  }
});

test('6016-wide five-channel callback rows preserve source coordinates, ICC precision and bounded stripes', async () => {
  const icc = matrixIcc(), color = inspectIcc(icc);
  const file = raw16({ width: 6016, height: 35, channels: 5, count: 1, resources: resource(1039, icc) });
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true });
  file.reads.length = 0;
  let y = 0, buffer: Uint8Array | undefined;
  await session.readRows(async row => {
    assert.equal(row.y, y++);
    assert.equal(row.data.byteLength, 18048);
    if (buffer) assert.equal(row.data, buffer);
    buffer = row.data;
    for (const x of [0, 1, 3008, 6014, 6015]) {
      const expected = color.convert!(file.value(0, x, row.y) / 65535, file.value(1, x, row.y) / 65535, file.value(2, x, row.y) / 65535);
      for (let c = 0; c < 3; c++) assert.equal(row.data[x * 3 + c], Math.round(expected[c] * 255));
    }
  });
  assert.equal(y, 35);
  assert.equal(file.reads.length, 9);
  assert.equal(file.reads.reduce((n, r) => n + r.length, 0), 6016 * 35 * 3 * 2);
  assert.ok(file.reads.every(r => r.length <= 192512 && r.offset + r.length <= file.dataOffset + 6016 * 35 * 3 * 2));
});

test('callback consumption applies backpressure before row reuse and cancels without later reads', async () => {
  const file = raw16({ width: 33, height: 35, channels: 5 });
  const session = await openPhotoshopComposite(file.read, file.bytes.length, file.header, { rgb16Raw: true });
  let started!: () => void, resume!: () => void, current = true, count = 0;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const task = session.readRows(async row => {
    count++;
    const copy = row.data.slice();
    started(); await gate;
    assert.equal(row.y, 0);
    assert.deepEqual(row.data, copy, 'The producer cannot reuse the row while its consumer is pending');
  }, { isCurrent: () => current });
  const rejected = assert.rejects(task, { code: 'CANCELLED' });
  await pending;
  const reads = file.reads.length;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(count, 1); assert.equal(file.reads.length, reads);
  current = false; resume(); await rejected;
  assert.equal(count, 1); assert.equal(file.reads.length, reads);
  const before = file.reads.length;
  await assert.rejects(session.readRows(async () => { throw new Error('consumer failed'); }), { message: 'consumer failed' });
  assert.equal(file.reads.length - before, 3, 'Failure cannot trigger a second stripe');
});
