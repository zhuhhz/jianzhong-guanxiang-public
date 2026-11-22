import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, open, stat } from 'node:fs/promises';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { brotliDecompressSync } from 'node:zlib';
import { openRawSensor, type RawDecoder } from '../src/core/camera-raw-sensor';
import { readCameraRawPreview } from '../src/core/camera-raw';
import type { SensorMetadata } from '../src/vendor/flashraw';

function specimen(orientation = 1) {
  const prefix = new Uint8Array(512), data = new DataView(prefix.buffer);
  prefix.set([73, 73, 42, 0, 8, 0, 0, 0]);
  const values = [[256, 8000], [257, 5320], [258, 14], [259, 1], [262, 32803],
    [273, 512], [277, 1], [278, 5320], [279, 8000 * 5320 * 2], [274, orientation]];
  data.setUint16(8, values.length, true);
  values.forEach(([tag, value], i) => { const at = 10 + i * 12;
    data.setUint16(at, tag, true); data.setUint16(at + 2, 4, true); data.setUint32(at + 4, 1, true); data.setUint32(at + 8, value, true); });
  const metadata: SensorMetadata = { metadata: { camera: { model: 'ILCE-7RM3' }, orientation },
    frame: { width: 8000, height: 5320, crop: { x: 0, y: 8, width: 7952, height: 5304 }, orientation,
      bitsPerSample: 14, layout: 'bayer', compression: 'uncompressed', blackLevel: { mean: 512 }, whiteBalance: [2, 1, 1.5, 1] } };
  const reads: number[] = [];
  const decoder: RawDecoder = { memoryBytes: () => 16 * 1024 * 1024, inspect: () => metadata,
    decode(bytes, rect) {
      assert.ok(bytes.length < 6 * 1024 * 1024);
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // Raw proxy has its own dimensions/counts and orientation 1; the source stays unchanged.
      assert.equal(data.getUint32(10 + 9 * 12 + 8, true), 1);
      const pixels = new Uint8ClampedArray(rect.width * rect.height * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([100, 50, 25, 255], i);
      return { width: rect.width, height: rect.height, pixels };
    } };
  return { metadata, decoder, prefix, reads, directories: [{ offset: 8, bytes: prefix.slice(10, 10 + values.length * 12 + 4) }],
    size: 512 + 8000 * 5320 * 2,
    read: async (at: number, n: number) => { reads.push(n); return at < prefix.length ? prefix.slice(at, at + n) : new Uint8Array(n); } };
}

test('sensor ROI uses bounded raw proxies and explicit display orientation without original mutation', async () => {
  for (const direction of [1, 8]) {
    const input = specimen(direction), original = input.prefix.slice();
    const session = await openRawSensor(input.read, input.size, input.directories, input.decoder);
    assert.deepEqual([session.width, session.height], direction === 1 ? [7952, 5304] : [5304, 7952]);
    const raster = await session.render({ x: 100, y: 120, width: 640, height: 480 }, { width: 320, height: 240 }, () => true);
    assert.deepEqual([...raster.pixels.subarray(0, 4)], [100, 50, 25, 255]);
    assert.ok(input.reads.every(n => n <= 65536)); assert.deepEqual(input.prefix, original);
    await assert.rejects(session.render({ x: -1, y: 0, width: 20, height: 20 }, { width: 20, height: 20 }, () => true), { code: 'INVALID_REGION' });
    await assert.rejects(session.render({ x: 0, y: 0, width: 4000, height: 4000 }, { width: 4000, height: 4000 }, () => true), { code: 'INVALID_REGION' });
  }
});

test('sensor unsupported camera/layout and stale requests exit before publishing pixels', async () => {
  const input = specimen(); input.metadata.metadata.camera.model = 'unverified';
  await assert.rejects(openRawSensor(input.read, input.size, input.directories, input.decoder), { code: 'UNSUPPORTED_RAW_SENSOR' });
  const valid = specimen(), session = await openRawSensor(valid.read, valid.size, valid.directories, valid.decoder);
  await assert.rejects(session.render({ x: 0, y: 0, width: 512, height: 512 }, { width: 512, height: 512 }, () => false), { code: 'CANCELLED' });
  let rows = 0;
  await assert.rejects(session.readRows(async row => { assert.equal(row.y, 0); assert.equal(row.data.length, 7952 * 3); rows++; throw new Error('stop'); }), /stop/);
  assert.equal(rows, 1);
});

test('demosaicer region edges stay outside the displayed sensor crop', async () => {
  const input = specimen(), decode = input.decoder.decode;
  input.decoder.decode = (bytes, rect) => {
    const raster = decode(bytes, rect);
    // A cropped decoder may interpolate its outer pixels differently. Keep its
    // halo in the decoded region, then crop it after demosaicing.
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
      if (x === 0 || y === 0 || x === rect.width - 1 || y === rect.height - 1) {
        raster.pixels.fill(0, (y * rect.width + x) * 4, (y * rect.width + x + 1) * 4);
      }
    }
    return raster;
  };
  const session = await openRawSensor(input.read, input.size, input.directories, input.decoder);
  const tile = await session.render({ x: 100, y: 120, width: 64, height: 48 }, { width: 64, height: 48 }, () => true);
  for (let i = 0; i < tile.pixels.length; i += 4) assert.deepEqual([...tile.pixels.subarray(i, i + 4)], [100, 50, 25, 255]);
});

test('sensor exposure is per session, reaches native decode and stays fixed throughout a PNG export', async () => {
  const input = specimen(8), decoder = input.decoder.decode, exposures: number[] = [];
  input.decoder.decode = (bytes, rect, exposure) => {
    exposures.push(exposure ?? 0); return decoder(bytes, rect);
  };
  const session = await openRawSensor(input.read, input.size, input.directories, input.decoder);
  session.setExposure(2.5);
  const progress: number[] = [];
  await session.render({ x: 0, y: 0, width: session.width, height: session.height }, { width: 32, height: 48 }, () => true,
    undefined, (done, total) => progress.push(done / total));
  assert.ok(exposures.length > 1); assert.ok(exposures.every(ev => ev === 2.5));
  assert.equal(progress[0], 0); assert.equal(progress[progress.length - 1], 1);
  assert.ok(progress.every((n, i) => !i || n >= progress[i-1]));
  // A switch after the first exported row must not change the next source band.
  exposures.length = 0;
  await assert.rejects(session.readRows(async row => {
    if (!row.y) session.setExposure(0);
    if (row.y === 192) throw new Error('stop after second band');
  }), /stop after second band/);
  assert.ok(exposures.length >= 2); assert.ok(exposures.every(ev => ev === 2.5));
  exposures.length = 0;
  await session.render({ x: 0, y: 0, width: 16, height: 16 }, { width: 16, height: 16 }, () => true);
  assert.deepEqual(exposures, [0]);
  assert.throws(() => session.setExposure(Infinity), { code: 'INVALID_RAW_EXPOSURE' });
  assert.ok(input.reads.every(n => n <= 65536));
});

test('optional real sensor tile uses the shipped WASM glue in a sandbox without browser/Node text globals', {
  skip: !process.env.RAW_SENSOR_FILE,
}, async () => {
  const module = { exports: {} as { initWechat(path: string): Promise<void> } & Record<string, any> };
  const code = buildSync({ entryPoints: ['src/vendor/flashraw.js'], bundle: true, format: 'cjs', platform: 'neutral', target: 'es2018', write: false }).outputFiles[0].text;
  runInNewContext(code, { module, exports: module.exports, console,
    WXWebAssembly: { instantiate: async (path: string, imports: unknown) =>
      (await (globalThis as any).WebAssembly.instantiate(brotliDecompressSync(await readFile(`src${path}`)), imports)).instance } });
  const engine = module.exports; await engine.initWechat('/raw-engine/flashraw.wasm.br');
  const path = process.env.RAW_SENSOR_FILE!, before = await stat(path), handle = await open(path, 'r');
  const lengths: number[] = [];
  try {
    const read = async (at: number, n: number) => { lengths.push(n); const bytes = Buffer.alloc(n); const r = await handle.read(bytes, 0, n, at); return bytes.subarray(0, r.bytesRead); };
    const preview = await readCameraRawPreview(read, before.size);
    const session = await openRawSensor(read, before.size, preview.directories,
      { inspect: engine.inspectRaw, decode: engine.decodeRaw, memoryBytes: engine.memoryBytes });
    const tile = await session.render({ x: 1000, y: 800, width: 640, height: 480 }, { width: 640, height: 480 }, () => true);
    assert.equal(tile.pixels.length, 640 * 480 * 4); assert.ok(lengths.every(n => n <= 65536));
    session.setExposure(2.5);
    const developed = await session.render({ x: 1000, y: 800, width: 640, height: 480 }, { width: 640, height: 480 }, () => true);
    let baseSum = 0, developedSum = 0;
    for (let i = 0; i < tile.pixels.length; i += 4) { baseSum += tile.pixels[i]; developedSum += developed.pixels[i]; }
    assert.ok(developedSum > baseSum);
    const wider = await session.render({ x: 996, y: 796, width: 648, height: 488 }, { width: 648, height: 488 }, () => true);
    for (let y = 0; y < 480; y++) assert.deepEqual(developed.pixels.subarray(y * 640 * 4, (y + 1) * 640 * 4),
      wider.pixels.subarray(((y + 4) * 648 + 4) * 4, ((y + 4) * 648 + 644) * 4));
    assert.ok(engine.memoryBytes() <= 64 * 1024 * 1024);
    const after = await stat(path); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { await handle.close(); }
});
