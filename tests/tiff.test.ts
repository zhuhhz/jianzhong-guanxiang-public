import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeTiff } from '../src/core/tiff';
import { inspectTiffFile, previewRawTiff } from '../src/core/tiff-preview';
import { detectFormat } from '../src/core/files';
import { QuickViewError } from '../src/core/shared';
import { tiffImage } from './helpers/tiff';
import { matrixIcc } from './helpers/icc';
import { inspectIcc } from '../src/core/icc';
import { rawTiffRows } from '../src/core/tiff-preview';

const expected = [255, 0, 0, 255, 0, 255, 0, 255];
const fails = (run: () => unknown) => assert.throws(run, QuickViewError);

test('TIFF RGB16 uses the embedded ICC before quantization for overview, detail and native rows', async () => {
  const profile = matrixIcc(), color = inspectIcc(profile);
  const raw = [0x1234, 0x5678, 0x9abc], pixels = new Uint8Array(10);
  raw.forEach((value, i) => new DataView(pixels.buffer).setUint16(i * 2, value, true));
  const bytes = tiffImage({ width: 1, components: 5, bits: 16, extras: [0, 0], pixels, icc: profile });
  const reads: number[] = [];
  const read = async (offset: number, length: number) => { reads.push(length); return bytes.subarray(offset, offset + length); };
  const metadata = await inspectTiffFile(read, bytes.length);
  assert.equal(metadata.color.kind, 'matrix');
  const expected = color.convert!(raw[0] / 65535, raw[1] / 65535, raw[2] / 65535).map(value => Math.round(value * 255));
  for (const options of [{}, { region: { x: 0, y: 0, width: 1, height: 1 }, output: { width: 1, height: 1 } }]) {
    const image = await previewRawTiff(read, bytes.length, metadata, () => true, options);
    assert.deepEqual([...image.pixels], [...expected, 255]);
  }
  const source = rawTiffRows(read, bytes.length, metadata);
  assert.equal(source.nativeSrgb, true);
  await source.readRows(async row => { assert.deepEqual([...row.data], expected); });
  assert.ok(reads.every(length => length <= 65536));
});

test('compressed TIFF applies ICC with alpha intact, while numeric sRGB remains unchanged', () => {
  for (const identity of [false, true]) {
    const profile = matrixIcc(identity), color = inspectIcc(profile);
    const values = [100, 80, 60], raw = Uint8Array.from([...values, 128]);
    const image = decodeTiff(tiffImage({ width: 1, components: 4, extras: [2], pixels: raw, compression: 8, icc: profile }));
    const expected = color.convert ? color.convert(100 / 255, 80 / 255, 60 / 255).map(value => Math.round(value * 255)) : values;
    assert.deepEqual([...image.pixels], [...expected, 128]);
    assert.equal(image.native.nativeSrgb, true);
  }
});

test('TIFF rejects a malformed ICC without silently treating it as sRGB', async () => {
  const profile = matrixIcc(); profile[36] = 0;
  const bytes = tiffImage({ icc: profile });
  assert.throws(() => decodeTiff(bytes), { code: 'INVALID_ICC' });
  await assert.rejects(inspectTiffFile(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length), { code: 'INVALID_ICC' });
});

for (const little of [true, false]) for (const compression of [1, 5, 8, 32946]) {
  test(`TIFF ${little ? 'LE' : 'BE'} compression ${compression} preserves RGB pixels`, () => {
    const bytes = tiffImage({ little, compression }), original = bytes.slice();
    assert.equal(detectFormat(bytes.subarray(0, 8), 'design.tiff'), 'TIFF');
    const image = decodeTiff(bytes);
    assert.deepEqual([...image.pixels], expected);
    assert.deepEqual(bytes, original);
  });
}

test('TIFF unassociated alpha, associated alpha, grayscale and 16-bit values', () => {
  for (const [kind, input] of [[2, [255, 0, 0, 128, 0, 255, 0, 255]], [1, [128, 0, 0, 128, 0, 255, 0, 255]]] as const) {
    assert.deepEqual([...decodeTiff(tiffImage({ components: 4, extras: [kind], pixels: Uint8Array.from(input) })).pixels], [255, 0, 0, 128, 0, 255, 0, 255]);
  }
  assert.deepEqual([...decodeTiff(tiffImage({ components: 1, photometric: 0, pixels: Uint8Array.of(0, 255) })).pixels], [255, 255, 255, 255, 0, 0, 0, 255]);
  const values = Uint8Array.of(255, 255, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0);
  assert.deepEqual([...decodeTiff(tiffImage({ bits: 16, pixels: values })).pixels], expected);
});

test('TIFF rejects oversized dimensions, bad offsets, unsupported types and compressed expansion', () => {
  fails(() => decodeTiff(tiffImage({ width: 1000000 })));
  fails(() => decodeTiff(tiffImage({ photometric: 5 })));
  fails(() => decodeTiff(tiffImage({ orientation: 6 })));
  fails(() => decodeTiff(tiffImage({ pixels: new Uint8Array(100000), compression: 8 })));
  fails(() => decodeTiff(tiffImage({ pixels: new Uint8Array(1000), compression: 5 })));
  const truncated = tiffImage().slice(0, -1);
  fails(() => decodeTiff(truncated));
  const pointer = tiffImage(); new DataView(pointer.buffer).setUint32(4, 0xffffff00, true);
  fails(() => decodeTiff(pointer));
  const count = tiffImage(); new DataView(count.buffer).setUint32(14, 0x7fffffff, true);
  fails(() => decodeTiff(count));
});

test('TIFF raw range preview ignores extra channels, reads only rows, and cancels', async () => {
  const bytes = tiffImage({ bits: 16, components: 5, extras: [0, 0], morePages: true,
    pixels: Uint8Array.of(255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 255, 255) });
  const reads: [number, number][] = [];
  const read = async (offset: number, length: number) => { reads.push([offset, length]); return bytes.subarray(offset, offset + length); };
  const metadata = await inspectTiffFile(read, bytes.length);
  const result = await previewRawTiff(read, bytes.length, metadata, () => true);
  assert.deepEqual([...result.pixels], expected);
  assert.ok(result.warnings.some(w => w.includes('额外通道')));
  assert.ok(result.warnings.some(w => w.includes('后续页面')));
  assert.ok(reads.every(([, length]) => length < bytes.length));
  await assert.rejects(previewRawTiff(read, bytes.length, metadata, () => false), { code: 'CANCELLED' });
  await assert.rejects(inspectTiffFile(async () => new Uint8Array(0), bytes.length), { code: 'INVALID_TIFF' });
});

for (const bits of [8, 16]) for (const little of [true, false]) {
  test(`TIFF ${bits}-bit ${little ? 'LE' : 'BE'} detail reads the exact crop and preserves original pixel coordinates`, async () => {
    const width = 18, height = 13, components = bits === 16 ? 5 : 3;
    const source = new Uint8Array(width * height * components * bits / 8), view = new DataView(source.buffer);
    const sample = (x: number, y: number, c: number) => (x * 19 + y * 53 + c * 71) * (bits === 16 ? 257 : 1) % (bits === 16 ? 65536 : 256);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < components; c++) {
      const at = ((y * width + x) * components + c) * bits / 8;
      if (bits === 8) view.setUint8(at, sample(x, y, c)); else view.setUint16(at, sample(x, y, c), little);
    }
    const bytes = tiffImage({ width, height, bits, components, little, pixels: source, extras: bits === 16 ? [0, 0] : [] });
    const reads: [number, number][] = [];
    const read = async (offset: number, length: number) => { reads.push([offset, length]); return bytes.subarray(offset, offset + length); };
    const metadata = await inspectTiffFile(read, bytes.length);
    for (const region of [{ x: 3, y: 4, width: 7, height: 5 }, { x: 17, y: 12, width: 1, height: 1 }]) {
      reads.length = 0;
      const image = await previewRawTiff(read, bytes.length, metadata, () => true, { region, output: region });
      assert.equal(reads.length, region.height);
      assert.ok(reads.every(([, length]) => length === region.width * components * bits / 8));
      assert.equal(reads[0][0], bytes.length - source.length + (region.y * width + region.x) * components * bits / 8);
      for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
        const dst = (y * region.width + x) * 4;
        for (let c = 0; c < 3; c++) assert.equal(image.pixels[dst + c], Math.round(sample(x + region.x, y + region.y, c) / (bits === 16 ? 257 : 1)));
        assert.equal(image.pixels[dst + 3], 255);
      }
    }
    reads.length = 0;
    await assert.rejects(previewRawTiff(read, bytes.length, metadata, () => true, {
      region: { x: 17, y: 12, width: 2, height: 1 },
    }), { code: 'INVALID_REGION' });
    assert.equal(reads.length, 0);
  });
}
