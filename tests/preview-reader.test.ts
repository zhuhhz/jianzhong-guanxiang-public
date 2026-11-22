import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewReader } from '../src/core/preview-reader';

test('overview read-ahead coalesces nearby requests with exact offsets and a single 512 KiB window', async () => {
  const calls: [number, number][] = [];
  const source = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 251);
  const reader = previewReader(async (at, n) => { calls.push([at, n]); return source.subarray(at, at + n); }, source.length);
  for (const at of [37, 20000, 90000, 400000]) assert.deepEqual(await reader.read(at, 1000), source.subarray(at, at + 1000));
  assert.deepEqual(calls, [[37, 512 * 1024]]);
  reader.clear(); await reader.read(37, 1000); assert.equal(calls.length, 2);
  await reader.read(source.length - 99, 99); assert.deepEqual(calls[calls.length - 1], [source.length - 99, 99]);
});

test('overview reader keeps independent in-flight views valid after eviction and passes larger rows through', async () => {
  const source = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 233), calls: number[] = [];
  const reader = previewReader(async (at, n) => { calls.push(n); return source.slice(at, at + n); }, source.length);
  const first = await reader.read(10, 100);
  await reader.read(800000, 100); assert.deepEqual(first, source.subarray(10, 110));
  const large = await reader.read(0, 600000); assert.deepEqual(large, source.subarray(0, 600000));
  assert.equal(calls[calls.length - 1], 600000);
});

test('TIFF adaptive overview keeps exact reads on fast storage and coalesces high-latency bridges', async () => {
  for (const latency of [0, 2]) {
    let clock = 0; const lengths: number[] = [];
    const reader = previewReader(async (_at, n) => { clock += latency; lengths.push(n); return new Uint8Array(n); }, 2 * 1024 * 1024,
      () => true, { adaptive: true, now: () => clock });
    for (let i = 0; i < 20; i++) await reader.read(i * 1000, 100);
    if (!latency) { assert.equal(lengths.length, 20); assert.ok(lengths.every(n => n === 100)); }
    else { assert.equal(lengths.length, 9); assert.equal(lengths[8], 512 * 1024); }
  }
});

test('overview reader rejects bad ranges/truncation and cancellation even on cache hits', async () => {
  let active = true;
  const reader = previewReader(async (_at, n) => new Uint8Array(n), 2 * 1024 * 1024, () => active);
  await assert.rejects(reader.read(-1, 2), { code: 'INVALID_READ_RANGE' });
  await assert.rejects(reader.read(2 * 1024 * 1024, 1), { code: 'INVALID_READ_RANGE' });
  await reader.read(0, 5); active = false;
  await assert.rejects(reader.read(1, 2), { code: 'CANCELLED' });
  const short = previewReader(async () => new Uint8Array(1), 2 * 1024 * 1024);
  await assert.rejects(short.read(0, 5), { code: 'TRUNCATED' });
});
