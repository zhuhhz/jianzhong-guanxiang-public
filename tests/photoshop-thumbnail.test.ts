import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readPhotoshopHeader, type PhotoshopHeader } from '../src/core/photoshop';
import { readPhotoshopThumbnail, THUMBNAIL_LIMITS } from '../src/core/photoshop-thumbnail';
import { largePhotoshopPaths, photoshopPrefix, rangeReader, resource, smallPhotoshop,
  thumbnailData, thumbnailJpeg, writeLargePhotoshop } from './helpers/photoshop-thumbnail';

let fixtureNumber = 0;
async function withFixture(bytes: Uint8Array,
  inspect: (reader: Awaited<ReturnType<typeof rangeReader>>, header: PhotoshopHeader) => Promise<void>) {
  await mkdir('test-results/wechat-large-photoshop', { recursive: true });
  const path = `test-results/wechat-large-photoshop/generated-thumbnail-case-${++fixtureNumber}.psd`;
  await writeFile(path, bytes);
  const reader = await rangeReader(path);
  try { await inspect(reader, readPhotoshopHeader(await reader.read(0, 26))); }
  finally { await reader.close(); }
}

async function rejectsResource(data: Uint8Array, code: string | RegExp) {
  await withFixture(smallPhotoshop(1, resource(1036, data)), async (reader, header) => {
    await assert.rejects(readPhotoshopThumbnail(reader.read, reader.fileSize, header),
      (error: any) => typeof code === 'string' ? error.code === code : code.test(error.code));
  });
}

for (const version of [1, 2] as const) {
  test(`PSD version ${version} extracts the actual embedded JPEG without reading layers or composite`, async () => {
    const resources = resource(1036, thumbnailData());
    const prefix = photoshopPrefix(version, 64, 48, resources);
    await withFixture(smallPhotoshop(version, resources), async (reader, header) => {
      const result = await readPhotoshopThumbnail(reader.read, reader.fileSize, header);
      assert.equal(result.resourceId, 1036);
      assert.equal(result.width, 64);
      assert.equal(result.height, 48);
      assert.deepEqual(Buffer.from(result.jpeg), thumbnailJpeg);
      assert.ok(reader.reads.every(read => read.offset + read.length <= prefix.length - (version === 2 ? 10 : 6)));
      assert.ok(reader.totalRead() < 1024);
    });
  });
}

test('resource 1036 is preferred to the legacy BGR thumbnail regardless of directory order', async () => {
  const legacy = resource(1033, thumbnailData({ format: 0, jpeg: Buffer.from('not JPEG') }));
  const modern = resource(1036, thumbnailData());
  for (const resources of [Buffer.concat([legacy, modern]), Buffer.concat([modern, legacy])]) {
    await withFixture(smallPhotoshop(1, resources), async (reader, header) => {
      const result = await readPhotoshopThumbnail(reader.read, reader.fileSize, header);
      assert.equal(result.resourceId, 1036);
      assert.deepEqual(Buffer.from(result.jpeg), thumbnailJpeg);
    });
  }
});

test('Pascal name padding and odd resource padding work while a large unknown resource is skipped', async () => {
  const unknownPayload = Buffer.alloc(3 * 1024 * 1024 + 1, 0x5a);
  const unknown = resource(2000, unknownPayload, Buffer.from('ab'));
  const modern = resource(1036, thumbnailData(), Buffer.from('abc'));
  const payloadStart = 34 + 6 + 4 + 4;
  await withFixture(smallPhotoshop(2, Buffer.concat([unknown, modern])), async (reader, header) => {
    const result = await readPhotoshopThumbnail(reader.read, reader.fileSize, header);
    assert.deepEqual(Buffer.from(result.jpeg), thumbnailJpeg);
    assert.ok(reader.reads.every(read => read.offset + read.length <= payloadStart
      || read.offset >= payloadStart + unknownPayload.length));
    assert.ok(reader.totalRead() < 2048);
    assert.ok(reader.maxRead() <= thumbnailJpeg.length);
  });
});

test('missing thumbnails and legacy-only BGR thumbnails produce explicit bounded errors', async () => {
  for (const [resources, expected] of [
    [Buffer.alloc(0), 'NO_PHOTOSHOP_THUMBNAIL'],
    [resource(1033, thumbnailData()), 'UNSUPPORTED_PHOTOSHOP_THUMBNAIL'],
  ] as const) {
    await withFixture(smallPhotoshop(1, resources), async (reader, header) => {
      await assert.rejects(readPhotoshopThumbnail(reader.read, reader.fileSize, header),
        (error: any) => error.code === expected);
    });
  }
});

test('corrupt resource lengths, signatures, Pascal fields and missing padding are rejected', async () => {
  const signature = resource(1036, thumbnailData()); signature[0] = 0;
  const pascal = resource(1036, Buffer.alloc(28)); pascal[6] = 255;
  const oversized = resource(1036, thumbnailData()); oversized.writeUInt32BE(0xffffffff, 8);
  const missingPad = resource(2000, Buffer.from([1])).subarray(0, 13);
  const badSection = smallPhotoshop(1, resource(1036, thumbnailData()));
  badSection.writeUInt32BE(0xffffffff, 30);
  const badColorSection = smallPhotoshop(1, resource(1036, thumbnailData()));
  badColorSection.writeUInt32BE(0xffffffff, 26);
  for (const bytes of [signature, pascal, oversized, missingPad].map(data => smallPhotoshop(1, data))
    .concat([badSection, badColorSection])) {
    await withFixture(bytes, async (reader, header) => {
      await assert.rejects(readPhotoshopThumbnail(reader.read, reader.fileSize, header),
        (error: any) => error.code === 'INVALID_PHOTOSHOP_THUMBNAIL');
    });
  }
});

test('short filesystem reads and invalid reported file sizes cannot yield a thumbnail', async () => {
  const bytes = smallPhotoshop(1, resource(1036, thumbnailData()));
  await withFixture(bytes.subarray(0, 100), async (reader, header) => {
    await assert.rejects(readPhotoshopThumbnail(reader.read, bytes.length, header),
      (error: any) => error.code === 'INVALID_PHOTOSHOP_THUMBNAIL');
    assert.ok(reader.reads.some(read => read.returned !== read.length));
  });
  await withFixture(bytes, async (reader, header) => {
    for (const size of [0, -1, 33, NaN, Infinity, 100.5]) {
      const count = reader.reads.length;
      await assert.rejects(readPhotoshopThumbnail(reader.read, size, header),
        (error: any) => error.code === 'INVALID_PHOTOSHOP_THUMBNAIL');
      assert.equal(reader.reads.length, count);
    }
  });
});

test('raw, wrong-bit-depth and multi-plane resource thumbnails are explicitly unsupported', async () => {
  for (const options of [{ format: 0 }, { bitsPerPixel: 8 }, { planes: 3 }]) {
    await rejectsResource(thumbnailData(options), 'UNSUPPORTED_PHOTOSHOP_THUMBNAIL');
  }
});

test('thumbnail dimensions, row size and compressed or uncompressed lengths must agree', async () => {
  for (const options of [{ width: 63 }, { widthBytes: 191 }, { totalSize: 1 },
    { compressedSize: 0 }, { compressedSize: thumbnailJpeg.length - 1 },
    { compressedSize: thumbnailJpeg.length + 1 }]) {
    await rejectsResource(thumbnailData(options), 'INVALID_PHOTOSHOP_THUMBNAIL');
  }
  await rejectsResource(Buffer.alloc(27), 'INVALID_PHOTOSHOP_THUMBNAIL');
  for (const [options, expected] of [[{ width: 0 }, 'INVALID_DIMENSIONS'], [{ height: 0 }, 'INVALID_DIMENSIONS'],
    [{ width: 4097 }, 'IMAGE_TOO_LARGE'], [{ width: 4096, height: 4096 }, 'IMAGE_TOO_LARGE']] as const) {
    await rejectsResource(thumbnailData(options), expected);
  }
});

test('JPEG start/end, marker lengths and frame dimensions are checked before native decoding', async () => {
  const noStart = Buffer.from(thumbnailJpeg); noStart[0] = 0;
  const noEnd = thumbnailJpeg.subarray(0, thumbnailJpeg.length - 2);
  const badLength = Buffer.from(thumbnailJpeg); badLength.writeUInt16BE(1, 4);
  const wrongFrame = Buffer.from(thumbnailJpeg);
  const frame = wrongFrame.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame >= 0);
  wrongFrame.writeUInt16BE(63, frame + 7);
  for (const jpeg of [noStart, noEnd, badLength, wrongFrame, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]) {
    await rejectsResource(thumbnailData({ jpeg }), 'INVALID_PHOTOSHOP_THUMBNAIL');
  }
  const lossless = Buffer.from(thumbnailJpeg); lossless[frame + 1] = 0xc3;
  await rejectsResource(thumbnailData({ jpeg: lossless }), 'UNSUPPORTED_PHOTOSHOP_THUMBNAIL');
});

test('resource-count and JPEG byte caps stop work without reading an oversized payload', async () => {
  const resources = Buffer.concat(Array.from({ length: THUMBNAIL_LIMITS.resources + 1 }, () => resource(2000, Buffer.alloc(0))));
  await withFixture(smallPhotoshop(1, resources), async (reader, header) => {
    await assert.rejects(readPhotoshopThumbnail(reader.read, reader.fileSize, header),
      (error: any) => error.code === 'THUMBNAIL_TOO_LARGE');
    assert.ok(reader.totalRead() < 64 * 1024);
  });
  const tooLarge = Buffer.alloc(THUMBNAIL_LIMITS.jpegBytes + 1);
  await withFixture(smallPhotoshop(1, resource(1036, thumbnailData({ jpeg: tooLarge }))), async (reader, header) => {
    await assert.rejects(readPhotoshopThumbnail(reader.read, reader.fileSize, header),
      (error: any) => error.code === 'THUMBNAIL_TOO_LARGE');
    assert.ok(reader.maxRead() <= 28);
  });
});

for (const [format, version] of [['PSD', 1], ['PSB', 2]] as const) {
  test(`actual 36 MiB generated Raw ${format} yields a thumbnail through small filesystem ranges`, async () => {
    const path = largePhotoshopPaths[format];
    await writeLargePhotoshop(version, path);
    const reader = await rangeReader(path);
    try {
      assert.ok(reader.fileSize > 36 * 1024 * 1024);
      const header = readPhotoshopHeader(await reader.read(0, 26));
      assert.equal(header.format, format);
      assert.equal(header.width, 4096);
      assert.equal(header.height, 3072);
      const result = await readPhotoshopThumbnail(reader.read, reader.fileSize, header);
      assert.deepEqual(Buffer.from(result.jpeg), thumbnailJpeg);
      assert.ok(reader.totalRead() < 2048);
      assert.ok(reader.maxRead() <= thumbnailJpeg.length);
      assert.ok(reader.reads.every(read => read.length < reader.fileSize));
    } finally { await reader.close(); }
  });
}
