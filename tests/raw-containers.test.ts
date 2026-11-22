import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCameraRawDirectory, readCameraRawPreview, rawPreviewJpeg, RAW_LIMITS } from '../src/core/camera-raw';
import { jpegByteLength } from '../src/core/raw-containers';
import { detectFormat } from '../src/core/files';
import { cameraRaw } from './helpers/camera-raw';
import { thumbnailJpeg } from './helpers/photoshop-thumbnail';
import { wideJpeg } from './helpers/raw-containers';

function box(type: string, data: Uint8Array, extended = false): Buffer {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : header.length + data.length); header.write(type, 4);
  if (extended) header.writeBigUInt64BE(BigInt(header.length + data.length), 8);
  return Buffer.concat([header, data]);
}
export function cr3(jpeg = thumbnailJpeg): Buffer {
  const ftyp = box('ftyp', Buffer.from('crx \0\0\0\0crx '));
  return Buffer.concat([ftyp, box('moov', box('uuid', Buffer.concat([Buffer.alloc(16), box('PRVW', Buffer.concat([Buffer.alloc(12), jpeg]), true)])))]);
}
export function raf(jpeg = thumbnailJpeg): Buffer {
  const header = Buffer.alloc(148); header.write('FUJIFILMCCD-RAW 0201');
  header.writeUInt32BE(148, 84); header.writeUInt32BE(jpeg.length, 88);
  return Buffer.concat([header, jpeg]);
}
const inspect = (bytes: Buffer) => readCameraRawPreview(async (at, n) => bytes.subarray(at, at + n), bytes.length);

test('BMFF 64-bit boxes and RAF offsets deliver actual complete JPEG data and EXIF direction', async () => {
  const rotated = Buffer.from(rawPreviewJpeg(thumbnailJpeg, 6));
  for (const bytes of [cr3(rotated), raf(rotated)]) {
    assert.equal(detectFormat(bytes, 'temporary-image'), 'RAW');
    const result = await inspect(bytes);
    assert.equal(result.highest.orientation, 6); assert.deepEqual(Buffer.from(result.highest.jpeg), rotated);
    assert.deepEqual([result.highest.width, result.highest.height], [64, 48]);
  }
});

test('highest JPEG saving is independent of overview pixel budget and chooses valid larger candidates', async () => {
  const small = cameraRaw(), offset = small.length + 16, bytes = Buffer.alloc(offset + wideJpeg.length); small.copy(bytes);
  bytes.writeUInt32LE(100, 78); bytes.writeUInt16LE(2, 100);
  for (const [i, tag, value] of [[0, 513, offset], [1, 514, wideJpeg.length]]) {
    const at = 102 + i * 12; bytes.writeUInt16LE(tag, at); bytes.writeUInt16LE(4, at + 2); bytes.writeUInt32LE(1, at + 4); bytes.writeUInt32LE(value, at + 8);
  }
  wideJpeg.copy(bytes, offset);
  const result = await inspect(bytes);
  assert.equal(result.highest.width, 4097); assert.equal(result.width, 64); assert.equal(result.overviewSafe, true);
  const onlyHigh = await inspect(raf(wideJpeg));
  assert.equal(onlyHigh.overviewSafe, false); assert.deepEqual(Buffer.from(onlyHigh.highest.jpeg), wideJpeg);
});

test('BMFF bounds, nesting, excessive box counts and malformed RAF never cause uncontrolled reads', async () => {
  const bad = cr3(); bad.writeUInt32BE(0xffffffff, 20);
  await assert.rejects(inspect(bad), { code: 'INVALID_RAW' });
  const overflow = cr3(); overflow.writeUInt32BE(1, 20); overflow.writeBigUInt64BE(0x20000000000000n, 28);
  await assert.rejects(inspect(overflow), { code: 'INVALID_RAW' });
  let nested = box('THMB', thumbnailJpeg); for (let i = 0; i < 10; i++) nested = box('moov', nested);
  await assert.rejects(inspect(Buffer.concat([cr3().subarray(0, 20), nested])), { code: 'RAW_BUDGET' });
  await assert.rejects(inspect(Buffer.concat([cr3().subarray(0, 20), ...Array.from({ length: 257 }, () => box('free', Buffer.alloc(0)))])), { code: 'RAW_BUDGET' });
  const badRaf = raf(); badRaf.writeUInt32BE(badRaf.length, 84);
  await assert.rejects(inspect(badRaf), { code: 'INVALID_RAW' });
});

test('large CR3 skips opaque mdat and keeps every file read bounded', async () => {
  const prefix = Buffer.concat([cr3(), box('mdat', Buffer.alloc(64))]);
  const mdat = prefix.length - 72; prefix.writeUInt32BE(0, mdat);
  const size = 100 * 1024 * 1024, calls: number[] = [];
  const read = async (at: number, n: number) => { calls.push(n); assert.ok(at + n <= prefix.length); return prefix.subarray(at, at + n); };
  const directory = await readCameraRawDirectory(read, size);
  const image = await readCameraRawPreview(read, size, () => true, directory);
  assert.equal(image.highest.width, 64); assert.ok(calls.every(n => n <= RAW_LIMITS.readBytes));
  assert.ok(calls.reduce((a, b) => a + b) < 4096);
});

test('JPEG EOI detection skips embedded APP bytes and retains complete scan data', () => {
  const app = Buffer.from([255, 226, 0, 6, 255, 217, 1, 2]);
  const data = Buffer.concat([thumbnailJpeg.subarray(0, 2), app, thumbnailJpeg.subarray(2)]);
  assert.equal(jpegByteLength(Buffer.concat([data, Buffer.alloc(13)])), data.length);
  assert.equal(jpegByteLength(data.subarray(0, data.length - 2)), undefined);
});

test('existing EXIF payload and ICC segments survive an orientation-only update', () => {
  const icc = Buffer.from([255, 226, 0, 8, 73, 67, 67, 1, 2, 3]);
  const input = Buffer.from(rawPreviewJpeg(Buffer.concat([thumbnailJpeg.subarray(0, 2), icc, thumbnailJpeg.subarray(2)]), 6));
  const output = rawPreviewJpeg(input, 8), expected = Buffer.from(input); expected.writeUInt16LE(8, 30);
  assert.deepEqual(Buffer.from(output), expected); assert.equal(input.readUInt16LE(30), 6);
});
