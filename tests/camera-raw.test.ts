import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open, stat, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readCameraRawDirectory, readCameraRawPreview, rawPreviewJpeg, RAW_LIMITS } from '../src/core/camera-raw';
import { detectFormat } from '../src/core/files';
import { cameraRaw } from './helpers/camera-raw';
import { thumbnailJpeg } from './helpers/photoshop-thumbnail';

const inspect = (bytes: Uint8Array, size = bytes.length) => readCameraRawPreview(async (at, n) => bytes.subarray(at, at + n), size);

test('RAW identity follows CFA/DNG directory structure, and reuses metadata when opening the JPEG', async () => {
  for (const little of [true, false]) {
    const bytes = cameraRaw(little), offsets: number[] = [];
    const read = async (at: number, n: number) => { offsets.push(at); return bytes.subarray(at, at + n); };
    const directory = await readCameraRawDirectory(read, bytes.length);
    assert.equal(directory.isRaw, true); const before = offsets.length;
    await readCameraRawPreview(read, bytes.length, () => true, directory);
    assert.equal(offsets.length, before + 1);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(66, 256, little);
    assert.equal((await readCameraRawDirectory(read, bytes.length)).isRaw, false);
  }
});

for (const little of [true, false]) test(`RAW ${little ? 'II' : 'MM'} uses embedded JPEG bytes, not sensor decoding`, async () => {
  const bytes = cameraRaw(little);
  for (const name of ['camera.ARW', 'camera.cr2', 'camera.nef', 'camera.dng', 'camera.raw']) assert.equal(detectFormat(bytes, name), 'RAW');
  assert.equal(detectFormat(bytes, 'normal.tif'), 'TIFF');
  const result = await inspect(bytes);
  assert.deepEqual([result.width, result.height], [64, 48]);
  assert.deepEqual(Buffer.from(result.jpeg), thumbnailJpeg);
});

test('RAW rejects missing preview, invalid offsets, cycles, entry budget, rotation and bad JPEG', async () => {
  const change = (modify: (b: Buffer) => void) => { const b = cameraRaw(); modify(b); return b; };
  await assert.rejects(inspect(change(b => b.writeUInt32LE(0, 30))), { code: 'INVALID_RAW' });
  await assert.rejects(inspect(change(b => b.writeUInt32LE(8, 46))), { code: 'INVALID_RAW' });
  await assert.rejects(inspect(change(b => b.writeUInt16LE(513, 8))), { code: 'RAW_BUDGET' });
  await assert.rejects(inspect(cameraRaw(true, 9)), { code: 'INVALID_RAW' });
  await assert.rejects(inspect(change(b => b[b.length - 1] = 0)), { code: 'RAW_PREVIEW_UNAVAILABLE' });
  await assert.rejects(inspect(change(b => { b.writeUInt16LE(0, 8); b.writeUInt32LE(0, 10); })), { code: 'RAW_PREVIEW_UNAVAILABLE' });
  assert.throws(() => detectFormat(Buffer.from('not a raw'), 'fake.arw'), { code: 'UNSUPPORTED_RAW' });
});

test('all EXIF orientations propagate without changing compressed scan bytes or stacking EXIF', async () => {
  const sos = thumbnailJpeg.indexOf(Buffer.from([255, 218]));
  for (let orientation = 1; orientation <= 8; orientation++) {
    const result = await inspect(cameraRaw(true, orientation));
    assert.equal(result.orientation, orientation);
    const bytes = rawPreviewJpeg(result.jpeg, orientation);
    assert.equal(new DataView(bytes.buffer).getUint16(30, true), orientation);
    assert.deepEqual(Buffer.from(bytes.subarray(bytes.length - (thumbnailJpeg.length - sos))), thumbnailJpeg.subarray(sos));
    assert.deepEqual(rawPreviewJpeg(bytes, orientation), bytes);
  }
});

test('RAW cancellation stops after the current bounded read and never returns stale bytes', async () => {
  const bytes = cameraRaw(); let active = true, reads = 0;
  await assert.rejects(readCameraRawPreview(async (at, n) => {
    reads++; active = false; return bytes.subarray(at, at + n);
  }, bytes.length, () => active), { code: 'CANCELLED' });
  assert.equal(reads, 1);
});

test('optional private ARW files: all previews use bounded reads without changing sources', {
  skip: !process.env.RAW_REAL_DIR,
}, async () => {
  const root = process.env.RAW_REAL_DIR!, results: object[] = [];
  const output = '.local-test-output/raw-real'; await mkdir(output, { recursive: true });
  for (const name of (await readdir(root)).filter(n => /\.arw$/i.test(n)).sort()) {
    const path = join(root, name), before = await stat(path), handle = await open(path, 'r');
    let calls = 0, total = 0, max = 0;
    const start = performance.now();
    try {
      const result = await readCameraRawPreview(async (position, length) => {
        calls++; total += length; max = Math.max(max, length);
        const bytes = Buffer.alloc(length), read = await handle.read(bytes, 0, length, position);
        return bytes.subarray(0, read.bytesRead);
      }, before.size);
      assert.ok(total < before.size / 10); assert.ok(max <= RAW_LIMITS.readBytes);
      assert.ok(result.width >= 1000 && result.height >= 500);
      const after = await stat(path); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
      results.push({ name, size: before.size, width: result.width, height: result.height, orientation: result.orientation, calls, total, max,
        jpegBytes: result.jpeg.length, ms: performance.now() - start });
      // Only one private derivative for local visual inspection; never a committed fixture.
      if (results.length === 1 || result.orientation !== 1 && !results.slice(0, -1).some((r: any) => r.orientation !== 1)) {
        await writeFile(join(output, result.orientation === 1 ? 'preview.jpg' : 'portrait.jpg'), rawPreviewJpeg(result.jpeg, result.orientation));
      }
    } finally { await handle.close(); }
  }
  assert.ok(results.length > 0);
  await writeFile(join(output, 'results.json'), JSON.stringify({ kind: 'REAL_FILE_NODE_PASS', results }, null, 2));
});
