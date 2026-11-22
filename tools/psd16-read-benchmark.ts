import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readPhotoshopHeader } from '../src/core/photoshop';
import { openPhotoshopComposite } from '../src/core/photoshop-preview';

const { PNG } = require('pngjs');
type Rows = 1 | 8 | 16 | 32;
const strategies: Rows[] = [1, 8, 16, 32];
const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error('Usage: tsx tools/psd16-read-benchmark.ts <private.psd>');

async function worker(rows: Rows) {
  const file = await open(source!, 'r');
  const before = await file.stat();
  let phase = 'prepare';
  let dataStart = Number.POSITIVE_INFINITY;
  let sourceRgbEnd = Number.POSITIVE_INFINITY;
  let valid = true;
  let cancelAt = 0;
  const reads: { phase: string; offset: number; length: number }[] = [];
  const maxima = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  const sample = () => {
    const m = process.memoryUsage();
    for (const k of Object.keys(maxima) as (keyof typeof maxima)[]) maxima[k] = Math.max(maxima[k], m[k]);
  };
  const timer = setInterval(sample, 5);
  const read = async (offset: number, length: number) => {
    assert.ok(Number.isSafeInteger(offset) && length > 0 && length <= 512 * 1024 && offset + length <= before.size);
    if (offset >= dataStart) assert.ok(offset + length <= sourceRgbEnd);
    const bytes = Buffer.alloc(length);
    const pending = file.read(bytes, 0, length, offset);
    if (phase === 'cancel' && offset >= dataStart) { valid = false; cancelAt = performance.now(); }
    assert.equal((await pending).bytesRead, length);
    reads.push({ phase, offset, length });
    return bytes;
  };
  try {
    const header = readPhotoshopHeader(await read(0, 26));
    assert.equal(header.version, 1); assert.equal(header.bitDepth, 16); assert.equal(header.colorModeId, 3);
    let at = 26;
    for (let i = 0; i < 3; i++) at += 4 + (await read(at, 4)).readUInt32BE(0);
    assert.equal((await read(at, 2)).readUInt16BE(0), 0);
    dataStart = at + 2;
    sourceRgbEnd = dataStart + header.width * header.height * 3 * 2;
    const region = { x: Math.floor((header.width - 512) / 2), y: Math.floor((header.height - 512) / 2), width: 512, height: 512 };
    const reference = PNG.sync.read(await readFile(resolve('.local-test-output/psd16-center-tile.png')));
    assert.equal(reference.width, 512); assert.equal(reference.height, 512);
    const expectedHash = createHash('sha256').update(reference.data).digest('hex');
    const session = await openPhotoshopComposite(read, before.size, header, { rgb16Raw: true, rgb16RawBatchRows: rows });
    const runs = [];
    for (let round = 0; round < 3; round++) {
      (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
      phase = `decode-${round}`;
      const m = process.memoryUsage(); sample();
      const started = performance.now();
      const raster = await session.decodeRegion(region, { width: 512, height: 512 });
      const milliseconds = performance.now() - started;
      sample();
      const rgbaHash = createHash('sha256').update(raster.pixels).digest('hex');
      assert.equal(rgbaHash, expectedHash);
      const actual = reads.filter(r => r.phase === phase);
      runs.push({ milliseconds, reads: actual.length, bytes: actual.reduce((sum, r) => sum + r.length, 0),
        maxRead: Math.max(...actual.map(r => r.length)), rgbaHash, beforeMemory: m, afterMemory: process.memoryUsage() });
    }
    phase = 'cancel';
    const cancelStarted = performance.now();
    await assert.rejects(session.decodeRegion(region, { width: 512, height: 512 }, { isCurrent: () => valid }), { code: 'CANCELLED' });
    const cancelFinished = performance.now();
    const cancelledReads = reads.filter(r => r.phase === 'cancel');
    assert.equal(cancelledReads.length, 1);
    assert.ok(cancelAt >= cancelStarted);
    phase = 'recovery';
    const recovered = await session.decodeRegion({ x: region.x, y: region.y, width: 1, height: 1 }, { width: 1, height: 1 });
    assert.deepEqual(Array.from(recovered.pixels), Array.from(reference.data.subarray(0, 4)));
    const after = await stat(source!);
    assert.deepEqual([after.size, after.mtimeMs, after.ctimeMs], [before.size, before.mtimeMs, before.ctimeMs]);
    const sorted = runs.map(r => r.milliseconds).sort((a, b) => a - b);
    return { rows, sourceBytes: before.size, region, pixelReads: runs[0].reads, bytes: runs[0].bytes,
      maxRead: runs[0].maxRead, medianMs: sorted[1], runs, memorySampledMaximum: maxima,
      memoryNote: 'Fresh Node/tsx process per strategy, explicit GC between rounds; sampled every 5ms and at phase checkpoints, not exact peak or device memory',
      rgbaExactToPreviousPoc: true, cancellation: { pendingReads: cancelledReads.length, pendingBytes: cancelledReads[0].length,
        millisecondsAfterCancel: cancelFinished - cancelAt, extraReadsAfterPending: 0,
        method: 'Cancel immediately after issuing the first actual pixel read; wait for that I/O then core CANCELLED', recovery: true },
      sourceOpenedReadOnly: true, sourceSizeAndTimesUnchanged: true };
  } finally { clearInterval(timer); await file.close(); }
}

async function main() {
  const requested = Number(process.argv[3]);
  if (process.argv[3]) {
    assert.ok(strategies.includes(requested as Rows));
    console.log(JSON.stringify(await worker(requested as Rows)));
    return;
  }
  const results = strategies.map(rows => JSON.parse(execFileSync(process.execPath,
    ['--expose-gc', '--require', 'tsx/cjs', __filename, source!, String(rows)], { encoding: 'utf8', maxBuffer: 1024 * 1024 })));
  const directory = resolve('.local-test-output/rgb16-wechat');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `reading-comparison-${Date.now()}.json`);
  const report = { environment: 'Local Node filesystem; no WeChat GUI or device', order: strategies,
    measurement: 'Three decodes per strategy in fresh processes; operating-system caches were not cleared. Metadata reads excluded from pixel-read columns.',
    results };
  await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ path, results: results.map(r => ({ rows: r.rows, reads: r.pixelReads, bytes: r.bytes,
    maxRead: r.maxRead, medianMs: r.medianMs, rssMiB: r.memorySampledMaximum.rss / 1048576,
    arrayBuffersMiB: r.memorySampledMaximum.arrayBuffers / 1048576, rgbaExact: r.rgbaExactToPreviousPoc, cancellation: r.cancellation })) }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
