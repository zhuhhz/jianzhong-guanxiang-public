import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readPhotoshopHeader, type PhotoshopHeader } from '../src/core/photoshop';
import { decodePhotoshopPreview, openPhotoshopComposite } from '../src/core/photoshop-preview';
import { QuickViewError } from '../src/core/shared';
import { largePhotoshopPaths, photoshopPrefix, rangeReader, thumbnailColor,
  writeLargePhotoshop } from './helpers/photoshop-thumbnail';

const expectedSmall = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  21, 21, 21, 255, 21, 21, 21, 255, 21, 21, 21, 255];
let fixtureNumber = 0;
const previewFailure = (error: unknown) => error instanceof QuickViewError
  && ['INVALID_PHOTOSHOP', 'TRUNCATED', 'MEMORY_BUDGET', 'UNSUPPORTED_PHOTOSHOP',
    'UNSUPPORTED_COMPRESSION'].includes(error.code);

async function withFile(path: string,
  inspect: (reader: Awaited<ReturnType<typeof rangeReader>>, header: PhotoshopHeader) => Promise<void>) {
  const reader = await rangeReader(path);
  try { await inspect(reader, readPhotoshopHeader(await reader.read(0, 26))); }
  finally { await reader.close(); }
}

async function withFixture(bytes: Uint8Array,
  inspect: (reader: Awaited<ReturnType<typeof rangeReader>>, header: PhotoshopHeader) => Promise<void>) {
  await mkdir('test-results/wechat-large-photoshop', { recursive: true });
  const path = `test-results/wechat-large-photoshop/generated-preview-case-${++fixtureNumber}.psd`;
  await writeFile(path, bytes);
  await withFile(path, inspect);
}

function rleFile(version: 1 | 2, rows: readonly Uint8Array[], lengths = rows.map(row => row.length)): Buffer {
  const prefix = photoshopPrefix(version, 3, 2, Buffer.alloc(0));
  prefix.writeUInt16BE(1, prefix.length - 2);
  const entryBytes = version === 2 ? 4 : 2;
  const table = Buffer.alloc(6 * entryBytes);
  lengths.forEach((length, row) => {
    if (entryBytes === 4) table.writeUInt32BE(length, row * entryBytes);
    else table.writeUInt16BE(length, row * entryBytes);
  });
  return Buffer.concat([prefix, table, ...rows]);
}

for (const format of ['psd', 'psb']) {
  for (const compression of ['raw', 'rle']) {
    test(`small ${compression.toUpperCase()} ${format.toUpperCase()} preview preserves every RGBA pixel`, async () => {
      await withFile(`tests/fixtures/photoshop/generated-${compression}.${format}`, async (reader, header) => {
        const result = await decodePhotoshopPreview(reader.read, reader.fileSize, header);
        assert.equal(result.width, 3);
        assert.equal(result.height, 2);
        assert.ok(result.pixels instanceof Uint8ClampedArray);
        assert.deepEqual(Array.from(result.pixels), expectedSmall);
        assert.equal(result.pixels.length, 3 * 2 * 4);
      });
    });
  }
}

for (const [format, version] of [['PSD', 1], ['PSB', 2]] as const) {
  test(`actual 36 MiB Raw ${format} is reduced through real file ranges without a full-size RGBA image`, async () => {
    const path = largePhotoshopPaths[format];
    await writeLargePhotoshop(version, path);
    await withFile(path, async (reader, header) => {
      assert.ok(reader.fileSize > 36 * 1024 * 1024);
      const result = await decodePhotoshopPreview(reader.read, reader.fileSize, header);
      assert.equal(result.width, 1365);
      assert.equal(result.height, 1024);
      assert.equal(result.pixels.length, 1365 * 1024 * 4);
      let mismatch = -1;
      for (let pixel = 0; pixel < result.pixels.length; pixel += 4) {
        if (result.pixels[pixel] !== thumbnailColor[0] || result.pixels[pixel + 1] !== thumbnailColor[1]
          || result.pixels[pixel + 2] !== thumbnailColor[2] || result.pixels[pixel + 3] !== 255) {
          mismatch = pixel / 4; break;
        }
      }
      assert.equal(mismatch, -1);
      assert.ok(reader.totalRead() < reader.fileSize * 0.8); // At most two sampled rows per output row, not all 3072 rows.
      assert.ok(reader.maxRead() <= 1024 * 1024);
      assert.ok(reader.reads.every(read => read.offset >= 0 && read.offset + read.length <= reader.fileSize));
      assert.ok(result.pixels.byteLength < header.width * header.height);
    });
  });
}

test('extremely wide valid Raw images retain at least one output row', async () => {
  const width = 30000;
  const bytes = Buffer.concat([photoshopPrefix(1, width, 1, Buffer.alloc(0)),
    ...thumbnailColor.map(color => Buffer.alloc(width, color))]);
  await withFixture(bytes, async (reader, header) => {
    const result = await decodePhotoshopPreview(reader.read, reader.fileSize, header);
    assert.equal(result.width, 1365);
    assert.equal(result.height, 1);
    assert.equal(result.pixels.length, 1365 * 4);
  });
});

test('valid PackBits literals, repeats and no-ops decode exactly in PSD and PSB rows', async () => {
  for (const version of [1, 2] as const) {
    const rows = [Buffer.from([128, 2, 1, 2, 3]), Buffer.from([254, 4]),
      Buffer.from([2, 5, 6, 7]), Buffer.from([254, 8]),
      Buffer.from([2, 9, 10, 11]), Buffer.from([254, 12])];
    await withFixture(rleFile(version, rows), async (reader, header) => {
      const result = await decodePhotoshopPreview(reader.read, reader.fileSize, header);
      assert.deepEqual(Array.from(result.pixels), [
        1, 5, 9, 255, 2, 6, 10, 255, 3, 7, 11, 255,
        4, 8, 12, 255, 4, 8, 12, 255, 4, 8, 12, 255,
      ]);
    });
  }
});

test('truncated RLE row tables and out-of-file row offsets are rejected before decoding', async () => {
  for (const version of [1, 2] as const) {
    const rows = Array.from({ length: 6 }, () => Buffer.from([2, 1, 2, 3]));
    const complete = rleFile(version, rows);
    const tableEnd = photoshopPrefix(version, 3, 2, Buffer.alloc(0)).length + 6 * (version === 2 ? 4 : 2);
    const beyondEnd = rleFile(version, rows, [65535, 4, 4, 4, 4, 4]);
    const emptyRow = rleFile(version, rows, [0, 4, 4, 4, 4, 4]);
    for (const bytes of [complete.subarray(0, tableEnd - 1), beyondEnd, emptyRow]) {
      await withFixture(bytes, async (reader, header) => {
        await assert.rejects(decodePhotoshopPreview(reader.read, reader.fileSize, header), previewFailure);
      });
    }
  }
});

test('PackBits source truncation and output underflow or overflow never yield a preview', async () => {
  const invalidRows = [
    Buffer.from([2, 1, 2]), // Literal count=3, only two source bytes.
    Buffer.from([254]), // Repeat count=3, missing value.
    Buffer.from([1, 1, 2]), // Only two decoded bytes, width=3.
    Buffer.from([3, 1, 2, 3, 4]), // Four decoded bytes, width=3.
    Buffer.from([253, 1]), // Repeat count=4, width=3.
    Buffer.from([128]), // A no-op cannot supply the row's pixels.
  ];
  for (const version of [1, 2] as const) {
    for (const invalid of invalidRows) {
      const rows = [invalid, ...Array.from({ length: 5 }, () => Buffer.from([2, 1, 2, 3]))];
      await withFixture(rleFile(version, rows), async (reader, header) => {
        await assert.rejects(decodePhotoshopPreview(reader.read, reader.fileSize, header), previewFailure);
      });
    }
  }
});

test('color/resources/layer section overflows and nonzero PSB high lengths are rejected', async () => {
  for (const version of [1, 2] as const) {
    const prefix = photoshopPrefix(version, 3, 2, Buffer.alloc(0));
    const valid = Buffer.concat([prefix, Buffer.alloc(18)]);
    const badColor = Buffer.from(valid); badColor.writeUInt32BE(0xffffffff, 26);
    const badResources = Buffer.from(valid); badResources.writeUInt32BE(0xffffffff, 30);
    const badLayers = Buffer.from(valid); badLayers.writeUInt32BE(0xffffffff, 34);
    for (const bytes of [badColor, badResources, badLayers]) {
      await withFixture(bytes, async (reader, header) => {
        await assert.rejects(decodePhotoshopPreview(reader.read, reader.fileSize, header), previewFailure);
      });
    }
  }
});

test('unsupported mode, bit depth, channel count and ZIP compression fail explicitly', async () => {
  const valid = Buffer.concat([photoshopPrefix(1, 3, 2, Buffer.alloc(0)), Buffer.alloc(18)]);
  const gray = Buffer.from(valid); gray.writeUInt16BE(1, 24);
  const sixteen = Buffer.from(valid); sixteen.writeUInt16BE(16, 22);
  const alpha = Buffer.from(valid); alpha.writeUInt16BE(4, 12);
  const zip = Buffer.from(valid); zip.writeUInt16BE(2, 38);
  for (const bytes of [gray, sixteen, alpha, zip]) {
    await withFixture(bytes, async (reader, header) => {
      await assert.rejects(decodePhotoshopPreview(reader.read, reader.fileSize, header), previewFailure);
    });
  }
});

test('short physical reads and invalid file size metadata cannot create partial previews', async () => {
  const complete = Buffer.concat([photoshopPrefix(1, 3, 2, Buffer.alloc(0)), Buffer.alloc(18)]);
  await withFixture(complete.subarray(0, complete.length - 1), async (reader, header) => {
    await assert.rejects(decodePhotoshopPreview(reader.read, complete.length, header), previewFailure);
    assert.ok(reader.reads.some(read => read.returned < read.length));
  });
  await withFixture(complete, async (reader, header) => {
    for (const size of [0, -1, 33, NaN, Infinity, complete.length - 0.5]) {
      await assert.rejects(decodePhotoshopPreview(reader.read, size, header), previewFailure);
    }
  });
});

test('a Raw session crops exact source pixels and can enlarge them without changing colors', async () => {
  await withFile('tests/fixtures/photoshop/generated-raw.psd', async (reader, header) => {
    const session = await openPhotoshopComposite(reader.read, reader.fileSize, header);
    assert.deepEqual([session.width, session.height], [3, 2]);
    const crop = await session.decodeRegion({ x: 1, y: 0, width: 2, height: 2 }, { width: 2, height: 2 });
    assert.deepEqual(Array.from(crop.pixels), [0, 255, 0, 255, 0, 0, 255, 255,
      21, 21, 21, 255, 21, 21, 21, 255]);
    const enlarged = await session.decodeRegion({ x: 1, y: 0, width: 1, height: 1 }, { width: 3, height: 3 });
    assert.deepEqual(Array.from(enlarged.pixels), Array.from({ length: 9 }, () => [0, 255, 0, 255]).flat());
  });
});

test('PSD and PSB sessions parse the RLE directory once and reuse it for different regions', async () => {
  for (const version of [1, 2] as const) {
    const rows = [Buffer.from([2, 1, 2, 3]), Buffer.from([254, 4]),
      Buffer.from([2, 5, 6, 7]), Buffer.from([254, 8]),
      Buffer.from([2, 9, 10, 11]), Buffer.from([254, 12])];
    const dataStart = photoshopPrefix(version, 3, 2, Buffer.alloc(0)).length + 6 * (version === 2 ? 4 : 2);
    await withFixture(rleFile(version, rows), async (reader, header) => {
      const session = await openPhotoshopComposite(reader.read, reader.fileSize, header);
      const countAfterOpen = reader.reads.length;
      const first = await session.decodeRegion({ x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 });
      const second = await session.decodeRegion({ x: 1, y: 1, width: 2, height: 1 }, { width: 2, height: 1 });
      assert.deepEqual(Array.from(first.pixels), [1, 5, 9, 255]);
      assert.deepEqual(Array.from(second.pixels), [4, 8, 12, 255, 4, 8, 12, 255]);
      const regionReads = reader.reads.slice(countAfterOpen);
      assert.equal(regionReads.length, 6);
      assert.ok(regionReads.every(read => read.offset >= dataStart));
    });
  }
});

test('a large Raw viewport reads only its requested scanlines without visiting the entire source', async () => {
  await writeLargePhotoshop(1, largePhotoshopPaths.PSD);
  await withFile(largePhotoshopPaths.PSD, async (reader, header) => {
    const session = await openPhotoshopComposite(reader.read, reader.fileSize, header);
    const readCount = reader.reads.length;
    const result = await session.decodeRegion({ x: 100, y: 150, width: 40, height: 30 }, { width: 40, height: 30 });
    assert.equal(result.pixels.length, 40 * 30 * 4);
    const dataStart = reader.fileSize - header.width * header.height * 3;
    const ranges = reader.reads.slice(readCount);
    assert.equal(ranges.length, 3 * 30);
    assert.ok(ranges.reduce((total, read) => total + read.returned, 0) < 1024 * 1024);
    for (const read of ranges) {
      const entry = (read.offset - dataStart) / header.width;
      assert.ok(Number.isInteger(entry));
      const sourceRow = entry % header.height;
      assert.ok(sourceRow >= 150 && sourceRow < 180);
      assert.equal(read.length, header.width);
    }
    for (let pixel = 0; pixel < result.pixels.length; pixel += 4) {
      assert.deepEqual(Array.from(result.pixels.subarray(pixel, pixel + 4)), [...thumbnailColor, 255]);
    }
  });
});

test('regions intersect the source bounds and reject empty or unsafe requests before I/O', async () => {
  await withFile('tests/fixtures/photoshop/generated-raw.psd', async (reader, header) => {
    const session = await openPhotoshopComposite(reader.read, reader.fileSize, header);
    const clipped = await session.decodeRegion({ x: -1, y: -1, width: 3, height: 3 }, { width: 2, height: 2 });
    assert.deepEqual(Array.from(clipped.pixels), [255, 0, 0, 255, 0, 255, 0, 255,
      21, 21, 21, 255, 21, 21, 21, 255]);
    const before = reader.reads.length;
    for (const region of [{ x: 3, y: 0, width: 1, height: 1 }, { x: 0, y: 2, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: Infinity, width: 1, height: 1 }]) {
      await assert.rejects(session.decodeRegion(region, { width: 1, height: 1 }),
        (error: unknown) => error instanceof QuickViewError && error.code === 'INVALID_REGION');
    }
    for (const output of [{ width: 0, height: 1 }, { width: 1.5, height: 1 }, { width: 1366, height: 1 }]) {
      await assert.rejects(session.decodeRegion({ x: 0, y: 0, width: 1, height: 1 }, output),
        (error: unknown) => error instanceof QuickViewError && ['INVALID_DIMENSIONS', 'IMAGE_TOO_LARGE'].includes(error.code));
    }
    assert.equal(reader.reads.length, before);
  });
});

test('viewport cancellation stops before or immediately after a pending range read and permits a fresh request', async () => {
  await withFile('tests/fixtures/photoshop/generated-rle.psd', async (reader, header) => {
    let isCurrent = true;
    let cancelAfterRead = false;
    const read = async (offset: number, length: number) => {
      const bytes = await reader.read(offset, length);
      if (cancelAfterRead) { isCurrent = false; cancelAfterRead = false; }
      return bytes;
    };
    const session = await openPhotoshopComposite(read, reader.fileSize, header);
    const options = { isCurrent: () => isCurrent };
    const region = { x: 0, y: 0, width: 3, height: 2 };
    const output = { width: 3, height: 2 };
    const isCancelled = (error: unknown) => error instanceof QuickViewError && error.code === 'CANCELLED';
    const before = reader.reads.length;
    isCurrent = false;
    await assert.rejects(session.decodeRegion(region, output, options), isCancelled);
    assert.equal(reader.reads.length, before);
    isCurrent = true;
    cancelAfterRead = true;
    await assert.rejects(session.decodeRegion(region, output, options), isCancelled);
    assert.equal(reader.reads.length, before + 1);
    isCurrent = true;
    const result = await session.decodeRegion(region, output, options);
    assert.deepEqual(Array.from(result.pixels), expectedSmall);
  });
});

test('bounded overview samples average a checkerboard instead of aliasing to one pixel', async () => {
  const plane = Buffer.from([0, 255, 255, 0]);
  await withFixture(Buffer.concat([photoshopPrefix(1, 2, 2, Buffer.alloc(0)), plane, plane, plane]), async (reader, header) => {
    const session = await openPhotoshopComposite(reader.read, reader.fileSize, header);
    const result = await session.decodeRegion({ x: 0, y: 0, width: 2, height: 2 }, { width: 1, height: 1 }, { overview: true });
    assert.deepEqual(Array.from(result.pixels), [128, 128, 128, 255]);
  });
});

test('two-row sampling preserves overlapping scanlines without cache eviction corruption', async () => {
  const plane = Buffer.from([0, 10, 20, 30, 40, 50, 60, 70, 80]);
  await withFixture(Buffer.concat([photoshopPrefix(1, 3, 3, Buffer.alloc(0)), plane, plane, plane]), async (reader, header) => {
    const session = await openPhotoshopComposite(reader.read, reader.fileSize, header);
    const result = await session.decodeRegion({ x: 0, y: 0, width: 3, height: 3 }, { width: 2, height: 2 });
    assert.deepEqual(Array.from(result.pixels), [20, 20, 20, 255, 30, 30, 30, 255,
      50, 50, 50, 255, 60, 60, 60, 255]);
  });
});
