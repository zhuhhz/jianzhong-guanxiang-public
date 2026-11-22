import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { decodePhotoshop, readPhotoshopHeader } from '../src/core/photoshop';
import { LIMITS, QuickViewError } from '../src/core/shared';

const { PNG } = createRequire(__filename)('pngjs');
const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/photoshop', name)));
const localPath = (name: string) => join(process.cwd(), '.local-fixtures/photoshop', name);
const localFixture = (name: string) => new Uint8Array(readFileSync(localPath(name)));
const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;
const decode = (name: string) => decodePhotoshop(buffer(fixture(name)));
const fails = (bytes: Uint8Array, code: string) => assert.throws(() => decodePhotoshop(buffer(bytes)),
  (error: unknown) => error instanceof QuickViewError && error.code === code);
const opaque = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  21, 21, 21, 255, 21, 21, 21, 255, 21, 21, 21, 255];

for (const extension of ['psd', 'psb']) {
  for (const compression of ['raw', 'rle']) {
    test(`actual ${extension.toUpperCase()} ${compression} binary yields expected RGBA pixels`, () => {
      const result = decode(`generated-${compression}.${extension}`);
      assert.equal(result.format, extension.toUpperCase());
      assert.deepEqual([result.width, result.height], [3, 2]);
      assert.equal(result.bitDepth, 8);
      assert.deepEqual(Array.from(result.pixels), opaque);
      if (extension === 'psb') assert.ok(result.warnings.some(message => message.includes('实验性')));
    });
  }
  test(`${extension.toUpperCase()} merged alpha restores Photoshop white-matted colors`, () => {
    const result = decode(`generated-alpha.${extension}`);
    assert.deepEqual(Array.from(result.pixels.subarray(0, 8)), [255, 0, 0, 255, 0, 255, 0, 128]);
    assert.equal(result.pixels[11], 0);
  });
}

const upstream = [
  ['upstream-fill-opacity.psd', 'upstream-fill-opacity.png', '0e3940268aa1b06092d6fb2bddeaad85656e02ad6e30eecd34beb90f6752bbd1'],
  ['upstream-layers.psb', 'upstream-layers.png', '3aae71e57e7e6044c3df63ee9292151007eec7e63c44587e79c607d0eda34449'],
];
for (const [source, expected, digest] of upstream) {
  // ag-psd's MIT license excludes images. These optional public references are
  // local-only; their redistribution rights are UNKNOWN and no copy is shipped.
  test(`optional local reference ${source} matches saved composite pixels`, {
    skip: !existsSync(localPath(source)) || !existsSync(localPath(expected)),
  }, () => {
    assert.equal(createHash('sha256').update(localFixture(source)).digest('hex'), digest);
    const image = PNG.sync.read(Buffer.from(localFixture(expected)));
    const result = decodePhotoshop(buffer(localFixture(source)));
    assert.deepEqual([result.width, result.height], [image.width, image.height]);
    if (source.endsWith('.psd')) {
      // Raw channel bytes [100,112,102,206] yield this exact white-matte inversion.
      // The upstream Canvas-produced PNG rounds its premultiplied red channel to 62.
      assert.deepEqual(Array.from(result.pixels), [63, 78, 66, 206]);
      for (let i = 0; i < result.pixels.length; i++) assert.ok(Math.abs(result.pixels[i] - image.data[i]) <= 1);
    } else assert.deepEqual(Buffer.from(result.pixels), image.data);
  });
}

test('header reads a prefix and a nonzero-offset typed array', () => {
  const bytes = fixture('generated-raw.psb');
  const padded = new Uint8Array(40);
  padded.set(bytes.subarray(0, 26), 7);
  assert.deepEqual(readPhotoshopHeader(padded.subarray(7, 33)), {
    version: 2, format: 'PSB', width: 3, height: 2, channels: 3, bitDepth: 8, colorMode: 'RGB', colorModeId: 3,
  });
});

test('signature, version, reserved bytes and truncated headers are rejected', () => {
  fails(new Uint8Array(25), 'INVALID_PHOTOSHOP');
  for (const [position, value] of [[0, 0], [5, 3], [6, 1]]) {
    const bytes = fixture('generated-raw.psd'); bytes[position] = value;
    fails(bytes, 'INVALID_PHOTOSHOP');
  }
});

test('color depth/mode/channel variants fail clearly before decoding', () => {
  for (const [position, value] of [[23, 16], [25, 4], [13, 5], [13, 2]]) {
    const bytes = fixture('generated-raw.psd'); bytes[position] = value;
    fails(bytes, 'UNSUPPORTED_PHOTOSHOP');
  }
});

test('unsupported Photoshop errors describe actual header fields and a usable image alternative', () => {
  const cmyk = fixture('generated-raw.psd'); cmyk[25] = 4;
  assert.throws(() => decodePhotoshop(buffer(cmyk)), (error: unknown) => error instanceof QuickViewError
    && error.code === 'UNSUPPORTED_PHOTOSHOP' && /CMYK/.test(error.message)
    && /8 位/.test(error.message) && /3 通道/.test(error.message) && /PNG\/JPG/.test(error.message));
  const zip = fixture('generated-raw.psb'); new DataView(zip.buffer).setUint16(42, 3);
  assert.throws(() => decodePhotoshop(buffer(zip)), (error: unknown) => error instanceof QuickViewError
    && error.code === 'UNSUPPORTED_COMPRESSION' && /ZIP Prediction/.test(error.message) && /PNG\/JPG/.test(error.message));
});

test('dimensions, file size and estimated memory are bounded before decoding', () => {
  const largeSide = fixture('generated-raw.psd'); new DataView(largeSide.buffer).setUint32(18, 4097);
  fails(largeSide, 'IMAGE_TOO_LARGE');
  const largeArea = fixture('generated-raw.psb'); const view = new DataView(largeArea.buffer);
  view.setUint32(18, 3000); view.setUint32(14, 2000);
  fails(largeArea, 'IMAGE_TOO_LARGE');
  const largeFile = new Uint8Array(LIMITS.photoshopBytes + 1); largeFile.set(fixture('generated-raw.psb'));
  fails(largeFile, 'FILE_TOO_LARGE');
  const memory = new Uint8Array(1024); memory.set(fixture('generated-raw.psd'));
  const memoryView = new DataView(memory.buffer); memoryView.setUint32(18, 2048); memoryView.setUint32(14, 2048);
  fails(memory, 'MEMORY_BUDGET');
});

test('PSD and PSB section lengths cannot escape the file, including unsafe uint64 values', () => {
  const color = fixture('generated-raw.psd'); new DataView(color.buffer).setUint32(26, 0xffffffff);
  fails(color, 'INVALID_PHOTOSHOP');
  const psb = fixture('generated-raw.psb'); new DataView(psb.buffer).setUint32(34, 0x200000);
  fails(psb, 'INVALID_PHOTOSHOP');
  const truncated = fixture('generated-raw.psb').subarray(0, 40);
  fails(truncated, 'INVALID_PHOTOSHOP');
});

test('ZIP and unknown composite compression are rejected before inflate/allocation', () => {
  for (const compression of [2, 3, 99]) {
    const bytes = fixture('generated-raw.psb'); new DataView(bytes.buffer).setUint16(42, compression);
    fails(bytes, 'UNSUPPORTED_COMPRESSION');
  }
});

test('truncated and malformed Raw / RLE data never silently produce pixels', () => {
  fails(fixture('generated-raw.psd').slice(0, -1), 'INVALID_PHOTOSHOP');
  const bytes = fixture('generated-rle.psb');
  // Locate the actual composite independently from the fixed header.
  const view = new DataView(bytes.buffer);
  let offset = 26;
  for (let i = 0; i < 2; i++) offset += 4 + view.getUint32(offset);
  offset += 8 + view.getUint32(offset + 4);
  view.setUint32(offset + 2, 0xffffffff);
  fails(bytes, 'INVALID_PHOTOSHOP');
  fails(fixture('generated-rle.psd').slice(0, -1), 'INVALID_PHOTOSHOP');
});

test('unused layer metadata is never parsed or allocated by ag-psd', () => {
  const bytes = fixture('generated-rle.psb');
  const view = new DataView(bytes.buffer);
  let offset = 26;
  for (let i = 0; i < 2; i++) offset += 4 + view.getUint32(offset);
  // An intentionally nonsensical layer count would make a full metadata parser fail.
  // It is irrelevant to our valid saved opaque composite, so it remains unvisited.
  view.setInt16(offset + 16, 32767);
  assert.deepEqual(Array.from(decodePhotoshop(buffer(bytes)).pixels), opaque);
});

test('a compatibility resource explicitly denying a real merged image is rejected', () => {
  const original = fixture('generated-raw.psd');
  const bytes = new Uint8Array(original.length + 18);
  bytes.set(original.subarray(0, 34));
  new DataView(bytes.buffer).setUint32(30, 18);
  bytes.set([0x38, 0x42, 0x49, 0x4d, 0x04, 0x21, 0, 0, 0, 0, 0, 5, 0, 0, 0, 1, 0, 0], 34);
  bytes.set(original.subarray(34), 52);
  fails(bytes, 'NO_COMPOSITE');
});

test('RLE incomplete literal packets and pixel underflow are rejected', () => {
  // Minimal complete PSB header followed by one-row RLE data.
  const base = fixture('generated-raw.psb').slice(0, 44);
  new DataView(base.buffer).setUint32(14, 1);
  new DataView(base.buffer).setUint16(42, 1);
  for (const packet of [[2, 255], [0, 255]]) {
    const bytes = new Uint8Array(base.length + 12 + packet.length * 3);
    bytes.set(base);
    for (let channel = 0; channel < 3; channel++) {
      new DataView(bytes.buffer).setUint32(44 + channel * 4, packet.length);
      bytes.set(packet, 56 + channel * packet.length);
    }
    fails(bytes, 'INVALID_PHOTOSHOP');
  }
});
