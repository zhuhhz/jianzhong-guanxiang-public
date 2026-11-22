import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readPsd } from 'ag-psd';
import { readPhotoshopHeader } from '../src/core/photoshop';
import { openPhotoshopComposite } from '../src/core/photoshop-preview';

const { PNG } = require('pngjs'); // Existing development-only encoder; never part of the Mini Program.
async function main() {
const input = process.argv[2];
if (!input) throw new Error('Usage: node node_modules/tsx/dist/cli.mjs tools/psd16-tile-poc.ts <private.psd>');
const source = resolve(input);
const outputDir = resolve('.local-test-output');
const outputPath = resolve(outputDir, 'psd16-center-tile.png');
assert.notEqual(source, outputPath);
const file = await open(source, 'r');
const before = await file.stat();
type Phase = 'diagnostic' | 'core' | 'reference';
let phase: Phase = 'diagnostic';
const reads: { phase: Phase; offset: number; length: number }[] = [];
const memory: { label: string; rss: number; heapUsed: number; external: number; arrayBuffers: number }[] = [];
const sampleMemory = (label: string) => {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  memory.push({ label, rss, heapUsed, external, arrayBuffers });
};
const timer = setInterval(() => sampleMemory(phase), 20);
sampleMemory('baseline-after-imports');
const started = performance.now();
const read = async (offset: number, length: number): Promise<Uint8Array> => {
  assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0
    && length > 0 && length <= 64 * 1024 && offset + length <= before.size, 'Unbounded or invalid source read');
  const bytes = Buffer.alloc(length);
  assert.equal((await file.read(bytes, 0, length, offset)).bytesRead, length, 'Short source read');
  reads.push({ phase, offset, length });
  if (reads.length % 64 === 0) sampleMemory(`${phase}-read-${reads.length}`);
  return bytes;
};
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const code = (b: Uint8Array) => String.fromCharCode(...b);
const section = async (lengthOffset: number, lengthBytes: number) => {
  const data = view(await read(lengthOffset, lengthBytes));
  const length = lengthBytes === 8 ? data.getUint32(0) * 0x100000000 + data.getUint32(4) : data.getUint32(0);
  const dataOffset = lengthOffset + lengthBytes;
  const end = dataOffset + length;
  assert.ok(Number.isSafeInteger(end) && end <= before.size);
  return { lengthOffset, lengthBytes, dataOffset, length, end };
};
const metrics = (value: Phase) => {
  const selected = reads.filter(r => r.phase === value);
  return { count: selected.length, bytes: selected.reduce((n, r) => n + r.length, 0), maxRead: Math.max(0, ...selected.map(r => r.length)) };
};

try {
  const headerBytes = await read(0, 26);
  const header = readPhotoshopHeader(headerBytes);
  const color = await section(26, 4);
  const resources = await section(color.end, 4);
  const layers = await section(resources.end, header.version === 2 ? 8 : 4);
  const compression = view(await read(layers.end, 2)).getUint16(0);
  const composite = { compressionFieldOffset: layers.end, dataOffset: layers.end + 2, compression,
    name: ['RAW', 'RLE', 'ZIP', 'ZIP with Prediction'][compression] ?? 'UNKNOWN' };
  const thumbnails: { id: number; width: number; height: number; jpegStart: number; jpegLength: number }[] = [];
  let resourceCount = 0;
  for (let at = resources.dataOffset; at < resources.end;) {
    assert.ok(++resourceCount <= 4096 && at + 12 <= resources.end);
    const prefix = await read(at, 12);
    assert.equal(code(prefix.subarray(0, 4)), '8BIM');
    const id = view(prefix).getUint16(4);
    const nameBytes = prefix[6] + 1;
    const sizeAt = at + 6 + nameBytes + nameBytes % 2;
    assert.ok(sizeAt + 4 <= resources.end);
    const length = view(sizeAt === at + 8 ? prefix.subarray(8, 12) : await read(sizeAt, 4)).getUint32(0);
    const dataAt = sizeAt + 4;
    const end = dataAt + length + length % 2;
    assert.ok(end <= resources.end);
    if ([1033, 1036].includes(id)) {
      assert.ok(length >= 28);
      const h = view(await read(dataAt, 28)); // Metadata only; no JPEG payload is read.
      thumbnails.push({ id, width: h.getUint32(4), height: h.getUint32(8), jpegStart: dataAt + 28, jpegLength: length - 28 });
    }
    at = end;
  }
  const primary = layers.length ? await section(layers.dataOffset, 4) : undefined;
  const tags: { key: string; offset: number; length: number; signedLayerCount?: number }[] = [];
  let primarySignedCount: number | undefined;
  if (primary) {
    assert.ok(primary.end <= layers.end);
    if (primary.length) primarySignedCount = view(await read(primary.dataOffset, 2)).getInt16(0);
    const mask = await section(primary.end, 4);
    assert.ok(mask.end <= layers.end);
    for (let at = mask.end; at < layers.end;) {
      assert.ok(tags.length < 4096 && at + 12 <= layers.end);
      const h = await read(at, 12);
      assert.equal(code(h.subarray(0, 4)), '8BIM');
      const key = code(h.subarray(4, 8));
      const length = view(h).getUint32(8);
      const end = at + 12 + length + (4 - length % 4) % 4;
      assert.ok(end <= layers.end);
      const signedLayerCount = key === 'Lr16' ? view(await read(at + 12, 2)).getInt16(0) : undefined;
      tags.push({ key, offset: at, length, ...(signedLayerCount === undefined ? {} : { signedLayerCount }) });
      at = end;
    }
  }
  assert.equal(header.version, 1, 'This POC only validates PSD v1');
  assert.equal(header.colorModeId, 3);
  assert.equal(header.bitDepth, 16);
  assert.equal(compression, 0, 'Do not treat RLE/ZIP as random-access Raw pixels');
  assert.ok(header.channels >= 3 && header.width >= 512 && header.height >= 512);
  const rawPlanarBytes = header.width * header.height * header.channels * 2;
  assert.equal(composite.dataOffset + rawPlanarBytes, before.size);
  const region = { x: Math.floor((header.width - 512) / 2), y: Math.floor((header.height - 512) / 2), width: 512, height: 512 };
  const diagnosticMs = performance.now() - started;

  phase = 'core';
  sampleMemory('before-session');
  const preparedAt = performance.now();
  const session = await openPhotoshopComposite(read, before.size, header, { rgb16Raw: true });
  const preparationMs = performance.now() - preparedAt;
  const decodedAt = performance.now();
  const raster = await session.decodeRegion(region, { width: 512, height: 512 });
  const decodeMs = performance.now() - decodedAt;
  sampleMemory('after-decode');
  const corePixelReads = reads.filter(r => r.phase === 'core' && r.offset >= composite.dataOffset);
  assert.equal(corePixelReads.length, 3 * 512);
  for (let c = 0; c < 3; c++) for (let row = 0; row < 512; row++) {
    assert.deepEqual(corePixelReads[c * 512 + row], { phase: 'core',
      offset: composite.dataOffset + ((c * header.height + region.y + row) * header.width + region.x) * 2,
      length: 512 * 2 });
  }
  const encodedAt = performance.now();
  const png: Buffer = PNG.sync.write({ width: 512, height: 512, data: Buffer.from(raster.pixels) });
  const encodeMs = performance.now() - encodedAt;
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const decoded = PNG.sync.read(png);
  assert.equal(decoded.width, 512); assert.equal(decoded.height, 512);
  assert.deepEqual(decoded.data, Buffer.from(raster.pixels));
  sampleMemory('after-png');

  // Independent reference: copy only the selected original RGB16 spans into a
  // small in-memory PSD, then let the unmodified ag-psd Raw reader decode it.
  // No full original image is decoded and no derived PSD is written to disk.
  phase = 'reference';
  const referenceAt = performance.now();
  const planar = Buffer.alloc(512 * 512 * 3 * 2);
  for (let c = 0; c < 3; c++) for (let row = 0; row < 512; row++) {
    const at = composite.dataOffset + c * header.width * header.height * 2
      + ((region.y + row) * header.width + region.x) * 2;
    planar.set(await read(at, 512 * 2), (c * 512 + row) * 512 * 2);
  }
  const prefix = Buffer.alloc(40);
  prefix.set(headerBytes);
  prefix.writeUInt16BE(3, 12); prefix.writeUInt32BE(512, 14); prefix.writeUInt32BE(512, 18);
  const reference = readPsd(Buffer.concat([prefix, planar]), { useImageData: true,
    skipLayerImageData: true, skipThumbnail: true, totalMemoryLimit: 16 * 1024 * 1024 }).imageData!;
  assert.ok(reference.data instanceof Uint16Array);
  let mismatch = 0;
  const minimum = [255, 255, 255]; const maximum = [0, 0, 0];
  for (let i = 0; i < raster.pixels.length; i++) {
    if (raster.pixels[i] !== reference.data[i] >>> 8) mismatch++;
    if (i % 4 < 3) { minimum[i % 4] = Math.min(minimum[i % 4], raster.pixels[i]); maximum[i % 4] = Math.max(maximum[i % 4], raster.pixels[i]); }
    else assert.equal(raster.pixels[i], 255);
  }
  assert.equal(mismatch, 0);
  assert.ok(maximum.some((v, i) => v > minimum[i]), 'Blank or constant output');
  const referenceMs = performance.now() - referenceAt;
  sampleMemory('after-independent-reference');
  for (const thumbnail of thumbnails) assert.ok(reads.every(r => r.offset + r.length <= thumbnail.jpegStart
    || r.offset >= thumbnail.jpegStart + thumbnail.jpegLength), 'A JPEG payload was read');
  const after = await stat(source);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
  await mkdir(outputDir, { recursive: true });
  try { assert.deepEqual(await readFile(outputPath), png, 'Existing output differs; refusing to overwrite'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(outputPath, png, { flag: 'wx' });
  }
  clearInterval(timer);
  const runId = new Date().toISOString().replace(/[^0-9]/g, '');
  const readLogPath = resolve(outputDir, `psd16-range-reads-${runId}.json`);
  const reportPath = resolve(outputDir, `psd16-poc-result-${runId}.json`);
  const result = {
    status: 'TILE_POC_PASS', environment: 'Local Node/tsx only; not WeChat runtime or physical-device validation',
    source: { path: source, bytes: before.size, MiB: before.size / 1048576, header,
      unchanged: { openedReadOnly: true, size: after.size === before.size, mtime: after.mtimeMs === before.mtimeMs,
        ctime: after.ctimeMs === before.ctimeMs, wholeFileHashPerformed: false } },
    diagnostic: { color, resources: { ...resources, resourceCount, thumbnails }, layers: { ...layers, primary, primarySignedCount, tags }, composite },
    region, output: { path: outputPath, width: decoded.width, height: decoded.height, rgbaBytes: raster.pixels.byteLength,
      pngBytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), rgbMinimum: minimum, rgbMaximum: maximum, alpha: 255 },
    timingsMs: { diagnostic: diagnosticMs, preparation: preparationMs, decode: decodeMs, pngEncode: encodeMs,
      independentReference: referenceMs, totalBeforeEvidenceWrite: performance.now() - started },
    reads: { diagnostic: metrics('diagnostic'), core: metrics('core'), independentReference: metrics('reference'),
      total: { count: reads.length, bytes: reads.reduce((n, r) => n + r.length, 0) }, corePixelBytes: corePixelReads.reduce((n, r) => n + r.length, 0), log: readLogPath },
    allocation: { fullOriginalPlanarBytesNotAllocated: rawPlanarBytes, fullOriginalRgbaBytesNotAllocated: header.width * header.height * 4,
      tileRgbaBytes: raster.pixels.byteLength, coreTwoByteRows: 2 * 512 * 2,
      independentReferencePlanarBytes: planar.byteLength, independentReferenceUint16RgbaBytes: reference.data.byteLength },
    memory: { method: 'process.memoryUsage every 20ms, every 64 reads and phase checkpoints; includes Node/tsx, encoding and independent reference',
      sampledMaximum: { rss: Math.max(...memory.map(m => m.rss)), heapUsed: Math.max(...memory.map(m => m.heapUsed)),
        external: Math.max(...memory.map(m => m.external)), arrayBuffers: Math.max(...memory.map(m => m.arrayBuffers)) },
      exactPeakMeasured: false, deviceMemoryMeasured: false, samples: memory },
    correctness: { sourcePixels: 'Original Raw16 composite RGB planes; 16-bit big-endian -> high 8 bits',
      exactRegionReads: true, noJpegPayloadRead: true, noOverviewInput: true, fullOriginalImageDecoded: false,
      independentReference: 'ag-psd 31.0.3 on a cropped Raw16 RGB-only in-memory envelope, not a Photoshop reference', mismatchedValues: mismatch,
      mergedTransparency: 'Not declared by this sample; positive Lr16 count. Separate saved channels are ignored for composite display' },
    limitations: raster.warnings,
    integration: { wechatRuntimeVerified: false, rgb16RequiresExplicitOptIn: true, android: 'NOT_RUN', ios: 'NOT_RUN',
      rle16: 'UNSUPPORTED', zip16: 'UNSUPPORTED', psb16: 'UNSUPPORTED', mergedAlpha16: 'UNSUPPORTED' },
  };
  await writeFile(readLogPath, JSON.stringify(reads, null, 2), { flag: 'wx' });
  await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, sourceBytes: before.size, header, composite, region,
    output: result.output, timingsMs: result.timingsMs, reads: result.reads, memory: result.memory.sampledMaximum,
    exactPeakMeasured: false, mismatch, reportPath }, null, 2));
} finally {
  clearInterval(timer);
  await file.close();
}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
