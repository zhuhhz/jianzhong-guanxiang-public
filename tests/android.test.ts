import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { prepareAndroidPreview, type AndroidRead } from '../src/platform/android';
import { rawPreviewJpeg } from '../src/core/camera-raw';
import { aiContainer } from './helpers/ai-container';
import { cameraRaw } from './helpers/camera-raw';
import { tiffImage } from './helpers/tiff';
import { photoshopPrefix, resource, smallPhotoshop, thumbnailData, thumbnailJpeg } from './helpers/photoshop-thumbnail';
import { raw16 } from './helpers/photoshop-16bit';

function source(bytes: Uint8Array) {
  const reads: { offset: number; length: number }[] = [];
  const read: AndroidRead = async (offset, length) => {
    assert.ok(Number.isSafeInteger(offset) && offset >= 0);
    assert.ok(Number.isSafeInteger(length) && length > 0 && length <= 1024 * 1024);
    assert.ok(offset <= bytes.length - length);
    reads.push({ offset, length });
    return bytes.subarray(offset, offset + length);
  };
  return { read, reads };
}

test('Android adapter keeps the existing opt-in PSD RGB16 Raw path and reports preview dimensions', async () => {
  const fixture = raw16(), result = await prepareAndroidPreview(source(fixture.bytes).read, fixture.bytes.length, 'sixteen.psd');
  assert.deepEqual([result.metadata.width, result.metadata.height], [4, 3]);
  const expected: number[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) expected.push(...[0, 1, 2].map(c => fixture.value(c, x, y) >>> 8), 255);
  assert.deepEqual([...result.payload!], expected);
  assert.ok(result.metadata.details.includes('16 位'));
  const width = 3000, height = 2;
  const bytes = Buffer.concat([photoshopPrefix(1, width, height, Buffer.alloc(0)),
    ...[204, 103, 51].map(color => Buffer.alloc(width * height, color))]);
  const reduced = await prepareAndroidPreview(source(bytes).read, bytes.length, 'wide.psd');
  assert.deepEqual([reduced.metadata.width, reduced.metadata.height], [1365, 1]);
  assert.equal(reduced.payload!.length, 1365 * 4);
  assert.ok(reduced.metadata.details.includes('3000 × 2'));
});

test('Android uses the bounded shared Photoshop decoder for a stored RGBA composite', async () => {
  const bytes = await readFile('tests/fixtures/photoshop/generated-alpha.psd');
  const result = await prepareAndroidPreview(source(bytes).read, bytes.length, 'alpha.psd');
  assert.equal(result.metadata.exportKind, 'bitmapPng');
  assert.equal(result.metadata.regionAvailable, false);
  assert.ok(result.payload!.some((value, index) => index % 4 === 3 && value < 255));
});

const expectedPhotoshop = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  21, 21, 21, 255, 21, 21, 21, 255, 21, 21, 21, 255];

for (const extension of ['psd', 'psb']) for (const compression of ['raw', 'rle']) {
  test(`Android adapter decodes actual project-owned ${compression} ${extension} binary through shared core`, async () => {
    const bytes = await readFile(`tests/fixtures/photoshop/generated-${compression}.${extension}`), original = bytes.slice();
    const reader = source(bytes);
    const result = await prepareAndroidPreview(reader.read, bytes.length, `drawing.${extension}`);
    assert.equal(result.metadata.kind, 'rgba');
    assert.equal(result.metadata.format, extension.toUpperCase());
    assert.deepEqual([result.metadata.width, result.metadata.height], [3, 2]);
    assert.deepEqual([...result.payload!], expectedPhotoshop);
    assert.deepEqual(bytes, original);
    assert.ok(reader.reads.length > 0);
  });
}

test('Android adapter uses a real saved JPEG only for an unsupported composite, with explicit thumbnail warning', async () => {
  const bytes = smallPhotoshop(1, resource(1036, thumbnailData()));
  bytes.writeUInt16BE(4, 24); // Existing CMYK composite is unsupported; the JPEG remains valid.
  const result = await prepareAndroidPreview(source(bytes).read, bytes.length, 'thumbnail.psd');
  assert.equal(result.metadata.kind, 'jpeg');
  assert.deepEqual(Buffer.from(result.payload!), thumbnailJpeg);
  assert.ok(result.metadata.warnings.some(warning => warning.includes('缩略图')));
  assert.ok(result.metadata.details.includes('CMYK'));
});

test('Android adapter never turns a damaged supported PSD composite into thumbnail success', async () => {
  const bytes = smallPhotoshop(1, resource(1036, thumbnailData()));
  // A valid thumbnail exists, but its supported composite section is truncated.
  await assert.rejects(prepareAndroidPreview(source(bytes.subarray(0, bytes.length - 1)).read,
    bytes.length - 1, 'damaged.psd'), { code: 'INVALID_PHOTOSHOP' });
});

test('Android adapter splits a >1 MiB saved JPEG into bounded native bridge reads', async () => {
  const app = Buffer.alloc(65534); app.set([255, 226, 255, 252]);
  const jpeg = Buffer.concat([thumbnailJpeg.subarray(0, 2), ...Array.from({ length: 18 }, () => app), thumbnailJpeg.subarray(2)]);
  const bytes = smallPhotoshop(1, resource(1036, thumbnailData({ jpeg })));
  bytes.writeUInt16BE(4, 24);
  const reader = source(bytes);
  const result = await prepareAndroidPreview(reader.read, bytes.length, 'thumbnail.psd');
  assert.deepEqual(Buffer.from(result.payload!), jpeg);
  assert.ok(reader.reads.some(read => read.length === 1024 * 1024));
});

test('Android adapter preserves the RAW JPEG scan and carries the authoritative orientation into the saved JPEG', async () => {
  for (const little of [true, false]) {
    const bytes = cameraRaw(little, 6), reader = source(bytes);
    const result = await prepareAndroidPreview(reader.read, bytes.length, 'camera.nef');
    assert.equal(result.metadata.kind, 'jpeg');
    assert.equal(result.metadata.format, 'RAW');
    assert.equal(result.metadata.orientation, 6);
    assert.deepEqual([result.metadata.width, result.metadata.height], [64, 48]);
    assert.deepEqual([result.metadata.sourceWidth, result.metadata.sourceHeight], [48, 64]);
    assert.equal(result.metadata.exportKind, 'cameraJpeg');
    assert.deepEqual(Buffer.from(result.payload!), Buffer.from(rawPreviewJpeg(thumbnailJpeg, 6)));
    assert.ok(result.metadata.warnings.some(warning => warning.includes('未进行 RAW 传感器显影')));
    assert.ok(reader.reads.every(read => read.length <= 65536));
  }
  const upright = cameraRaw(true, 1);
  const result = await prepareAndroidPreview(source(upright).read, upright.length, 'upright.nef');
  assert.deepEqual(Buffer.from(result.payload!), thumbnailJpeg);
});

for (const compression of [1, 5, 8, 32946]) {
  test(`Android adapter reuses TIFF ${compression} decoding with exact display payload dimensions`, async () => {
    const bytes = tiffImage({ compression }), original = bytes.slice();
    const result = await prepareAndroidPreview(source(bytes).read, bytes.length, 'design.tiff');
    assert.equal(result.metadata.kind, 'rgba');
    assert.equal(result.metadata.format, 'TIFF');
    assert.deepEqual([result.metadata.width, result.metadata.height], [2, 1]);
    assert.deepEqual([...result.payload!], [255, 0, 0, 255, 0, 255, 0, 255]);
    assert.deepEqual(bytes, original);
    assert.equal(result.metadata.exportKind, 'nativePng');
    const rows = await result.nativeRows!(() => true);
    const output: number[] = [];
    await rows.readRows(async row => { output.push(...row.data); });
    assert.deepEqual(output, [255, 0, 0, 0, 255, 0]);
  });
}

test('a TIFF tile reads only the exact uncompressed pixels and refuses upsampling', async () => {
  const width = 2000, height = 4;
  const pixels = Buffer.alloc(width * height * 3);
  const expected = [[250, 123, 99], [4, 88, 170]];
  for (const [index, rgb] of expected.entries()) pixels.set(rgb, ((index + 1) * width + 1544) * 3);
  const bytes = tiffImage({ width, height, pixels });
  const reader = source(bytes);
  const result = await prepareAndroidPreview(reader.read, bytes.length, 'wide.tiff');
  assert.equal(result.metadata.regionAvailable, true);
  const rect = { x: 1544, y: 1, width: 1, height: 2 };
  const before = reader.reads.length;
  await assert.rejects(result.region!(rect, { width: 2, height: 2 }, () => true), { code: 'INVALID_REGION' });
  assert.equal(reader.reads.length, before);
  const detail = await result.region!(rect, { width: 1, height: 2 }, () => true);
  assert.deepEqual([...detail.pixels], expected.flatMap(rgb => [...rgb, 255]));
  assert.deepEqual(reader.reads.slice(before).map(read => read.length), [3, 3]);
});

test('Android adapter bounds compressed TIFF whole-file bridge transfers and rejects its original size budget', async () => {
  const bytes = Buffer.concat([tiffImage({ compression: 8 }), Buffer.alloc(2 * 1024 * 1024)]), reader = source(bytes);
  const result = await prepareAndroidPreview(reader.read, bytes.length, 'compressed.tiff');
  assert.equal(result.payload!.length, 8);
  assert.ok(reader.reads.some(read => read.length === 1024 * 1024));
  const small = tiffImage({ compression: 8 });
  await assert.rejects(prepareAndroidPreview(async (at, n) => {
    const output = new Uint8Array(n);
    output.set(small.subarray(at, at + n));
    return output;
  }, 33 * 1024 * 1024, 'virtual-large.tiff'), { code: 'FILE_TOO_LARGE' });
});

test('Android SVG input is parsed and rebuilt; unsafe and malformed UTF-8 content never becomes a payload', async () => {
  const bytes = await readFile('tests/fixtures/svg/basic.svg');
  const result = await prepareAndroidPreview(source(bytes).read, bytes.length, 'safe.svg');
  assert.equal(result.metadata.kind, 'svg');
  assert.match(Buffer.from(result.payload!).toString('utf8'), /^<svg /);
  for (const fixture of ['script.svg', 'external-resource.svg', 'doctype.svg', 'malformed.svg']) {
    const invalid = await readFile(`tests/fixtures/svg/${fixture}`);
    await assert.rejects(prepareAndroidPreview(source(invalid).read, invalid.length, fixture));
  }
  const invalid = Buffer.from([0xff, 0xfe, 0x3c]);
  await assert.rejects(prepareAndroidPreview(source(invalid).read, invalid.length, 'invalid.svg'), { code: 'SVG_INVALID' });
  const chinese = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><title>鉴中观象</title><rect width="2" height="1"/></svg>');
  const unicode = await prepareAndroidPreview(source(chinese).read, chinese.length, 'unicode.svg');
  assert.ok(Buffer.from(unicode.payload!).toString('utf8').includes('鉴中观象'));
});

test('Android AI validates the existing bounded PDF compatibility structure and retains prototype PDF path', async () => {
  const bytes = await aiContainer();
  const ai = await prepareAndroidPreview(source(bytes).read, bytes.length, 'design.ai');
  assert.equal(ai.metadata.kind, 'pdf');
  assert.equal(ai.metadata.format, 'AI');
  assert.equal(ai.payload, undefined);
  const pdf = await prepareAndroidPreview(source(bytes).read, bytes.length, 'document.pdf');
  assert.equal(pdf.metadata.format, 'PDF');
  assert.equal(pdf.metadata.kind, 'pdf');
  const invalid = bytes.slice(0, bytes.length - 8);
  await assert.rejects(prepareAndroidPreview(source(invalid).read, invalid.length, 'incomplete.ai'), { code: 'AI_INCOMPLETE' });
});

test('Android native image detection follows real signatures, never a disguised file extension', async () => {
  const jpeg = await prepareAndroidPreview(source(thumbnailJpeg).read, thumbnailJpeg.length, 'wrong.psd');
  assert.equal(jpeg.metadata.kind, 'native');
  assert.equal(jpeg.metadata.format, 'JPEG');
  const fake = Buffer.from('this is not a JPEG image');
  await assert.rejects(prepareAndroidPreview(source(fake).read, fake.length, 'fake.jpg'), { code: 'UNSUPPORTED_FORMAT' });
});

test('Android retains native PNG/GIF/BMP/WebP/HEIF routing by magic and keeps CR3 under RAW', async () => {
  // Routing controls only: actual platform decoding remains the Android decoder's responsibility.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const heif = Buffer.alloc(20); heif.writeUInt32BE(20); heif.write('ftypheic', 4); heif.write('mif1', 16);
  const samples: [string, Buffer][] = [['PNG', png], ['GIF', Buffer.from('GIF89a\x01\0\x01\0')],
    ['BMP', Buffer.from('BM\0\0\0\0\0\0\0\0\0\0')], ['WebP', Buffer.from('RIFF\x04\0\0\0WEBP')], ['HEIF', heif]];
  for (const [format, bytes] of samples) {
    const result = await prepareAndroidPreview(source(bytes).read, bytes.length, 'misnamed.psd');
    assert.equal(result.metadata.kind, 'native');
    assert.equal(result.metadata.format, format);
  }
  const cr3 = Buffer.from(heif); cr3.write('crx ', 8);
  await assert.rejects(prepareAndroidPreview(source(cr3).read, cr3.length, 'camera.cr3'), { code: 'RAW_PREVIEW_UNAVAILABLE' });
});

test('Android read cancellation, invalid size, short reads and core out-of-bounds indices fail without stale results', async () => {
  let calls = 0;
  await assert.rejects(prepareAndroidPreview(async () => { calls++; return new Uint8Array(0); }, 4, 'bad.psd', () => false), { code: 'CANCELLED' });
  assert.equal(calls, 0);
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(prepareAndroidPreview(async () => { calls++; return new Uint8Array(0); }, size, 'bad.psd'), { code: 'EMPTY_FILE' });
  }
  assert.equal(calls, 0);
  await assert.rejects(prepareAndroidPreview(async (_at, length) => new Uint8Array(length - 1), 28, 'short.psd'), { code: 'TRUNCATED' });
  let active = true;
  await assert.rejects(prepareAndroidPreview(async (at, n) => { active = false; calls++; return thumbnailJpeg.subarray(at, at + n); },
    thumbnailJpeg.length, 'cancelled.jpg', () => active), { code: 'CANCELLED' });
  const badRaw = cameraRaw(); badRaw.writeUInt32LE(0xffffffff, 30);
  const reader = source(badRaw);
  await assert.rejects(prepareAndroidPreview(reader.read, badRaw.length, 'invalid-offset.arw'), { code: 'INVALID_RAW' });
});

test('synthetic sparse PSB >4 GiB section offset remains exact without allocating or reading its opaque section', async () => {
  // A virtual range source checks integer preservation only: this is not a real >2 GiB file/device test.
  const prefix = photoshopPrefix(2, 3, 2, Buffer.alloc(0));
  const layerBytes = 0x100000000 + 16;
  prefix.writeBigUInt64BE(BigInt(layerBytes), 34);
  const atComposite = 42 + layerBytes, tail = Buffer.concat([Buffer.alloc(2), Buffer.alloc(6, 12), Buffer.alloc(6, 34), Buffer.alloc(6, 56)]);
  const size = atComposite + tail.length, reads: { offset: number; length: number }[] = [];
  const read: AndroidRead = async (offset, length) => {
    assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset <= size - length);
    assert.ok(length > 0 && length <= 1024 * 1024);
    reads.push({ offset, length });
    const output = new Uint8Array(length);
    for (const [start, bytes] of [[0, prefix], [atComposite, tail]] as const) {
      const from = Math.max(offset, start), end = Math.min(offset + length, start + bytes.length);
      if (end > from) output.set(bytes.subarray(from - start, end - start), from - offset);
    }
    return output;
  };
  const result = await prepareAndroidPreview(read, size, 'synthetic-large-offset.psb');
  assert.deepEqual([...result.payload!], Array.from({ length: 6 }, () => [12, 34, 56, 255]).flat());
  assert.ok(reads.some(read => read.offset > 0xffffffff));
  assert.ok(reads.reduce((sum, read) => sum + read.length, 0) < 2 * 1024 * 1024);
});
