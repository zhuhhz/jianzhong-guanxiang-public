import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { writePngRows, PngRow } from '../src/core/png-stream';

const { PNG } = require('pngjs') as { PNG: { sync: { read(bytes: Buffer): { width: number; height: number; data: Buffer } } } };

function inspect(bytes: Buffer) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks: { type: string; data: Buffer }[] = [];
  let at = 8;
  while (at < bytes.length) {
    const size = bytes.readUInt32BE(at), end = at + 12 + size;
    assert.ok(end <= bytes.length);
    const type = bytes.toString('ascii', at + 4, at + 8);
    // Independent bitwise reference, rather than the encoder's lookup table.
    let crc = 0xffffffff;
    for (let i = at + 4; i < end - 4; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    assert.equal(bytes.readUInt32BE(end - 4), (crc ^ 0xffffffff) >>> 0);
    chunks.push({ type, data: bytes.subarray(at + 8, end - 4) }); at = end;
  }
  assert.equal(at, bytes.length); assert.equal(chunks[chunks.length - 1].type, 'IEND');
  return chunks;
}

async function* rows(data: number[][]): AsyncIterable<PngRow> {
  for (let y = 0; y < data.length; y++) yield { y, data: Uint8Array.from(data[y]) };
}

test('streaming RGB and RGBA PNG: IHDR, independent CRC, one zlib stream, exact alpha and pixels', async () => {
  for (const channels of [3, 4] as const) {
    const source = channels === 3 ? [[255, 0, 4, 20, 30, 40], [0, 128, 255, 99, 0, 17]] :
      [[255, 0, 4, 0, 20, 30, 40, 128], [0, 128, 255, 255, 99, 0, 17, 254]];
    const pieces: Buffer[] = [], progress: number[] = [];
    const stats = await writePngRows(2, 2, channels, rows(source), async bytes => { pieces.push(Buffer.from(bytes)); }, {
      onProgress: n => progress.push(n),
    });
    const bytes = Buffer.concat(pieces), chunks = inspect(bytes), image = PNG.sync.read(bytes);
    assert.equal(image.width, 2); assert.equal(image.height, 2);
    assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'sRGB', 'IDAT', 'IEND']);
    assert.deepEqual(chunks[0].data, Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, channels === 3 ? 2 : 6, 0, 0, 0]));
    assert.deepEqual(inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data))), Buffer.from(source.flatMap(row => [0, ...row])));
    const expected = source.flatMap(row => channels === 4 ? row : row.flatMap((v, i) => i % 3 === 2 ? [v, 255] : [v]));
    assert.deepEqual(image.data, Buffer.from(expected));
    assert.deepEqual(progress, [1, 2]); assert.equal(stats.bytesWritten, bytes.length); assert.equal(stats.rowsWritten, 2);
  }
});

test('large incompressible rows produce bounded IDAT chunks with real sink backpressure', async () => {
  const width = 100000, row = new Uint8Array(width * 3);
  let random = 1029384756;
  for (let i = 0; i < row.length; i++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; row[i] = random & 255; }
  let requested = 0, unlock!: () => void, blocked!: () => void, writes = 0, maxWrite = 0;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const pending = new Promise<void>(resolve => { blocked = resolve; });
  const source = (async function* () { for (let y = 0; y < 3; y++) { requested++; yield { y, data: row }; } })();
  const output: Buffer[] = [];
  const task = writePngRows(width, 3, 3, source, async bytes => {
    writes++; maxWrite = Math.max(maxWrite, bytes.length);
    if (bytes.length > 12 && Buffer.from(bytes.subarray(4, 8)).toString() === 'IDAT' && output.length === 3) {
      blocked(); await gate;
    }
    output.push(Buffer.from(bytes));
  });
  await pending;
  assert.equal(requested, 1); const frozenWrites = writes;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(writes, frozenWrites); assert.equal(requested, 1);
  unlock(); const stats = await task;
  assert.equal(requested, 3); assert.ok(stats.idatChunks > 40);
  assert.ok(stats.maxQueuedBytes <= 256 * 1024); assert.ok(maxWrite <= 16 * 1024 + 12);
  const chunks = inspect(Buffer.concat(output));
  const inflated = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  for (let y = 0; y < 3; y++) {
    assert.equal(inflated[y * (row.length + 1)], 0);
    assert.deepEqual(inflated.subarray(y * (row.length + 1) + 1, (y + 1) * (row.length + 1)), Buffer.from(row));
  }
});

test('cancellation, source failure, short/extra/misordered rows and sink errors never produce IEND', async () => {
  const cases = [
    { source: rows([[1, 2]]), code: 'PNG_ROW' },
    { source: rows([[1, 2, 3], [4, 5, 6]]), code: 'PNG_ROW' },
    { source: rows([]), code: 'PNG_ROW' },
    { source: (async function* () { yield { y: 1, data: Uint8Array.from([1, 2, 3]) }; })(), code: 'PNG_ROW' },
    { source: (async function* (): AsyncIterable<PngRow> { throw new Error('source failed'); })(), message: 'source failed' },
  ];
  for (const item of cases) {
    const types: string[] = [];
    await assert.rejects(writePngRows(1, 1, 3, item.source, async b => { types.push(Buffer.from(b.subarray(4, 8)).toString()); }),
      item.code ? { code: item.code } : { message: item.message });
    assert.ok(!types.includes('IEND'));
  }
  let current = true, sourceClosed = false;
  const source = (async function* () { try { yield { y: 0, data: new Uint8Array(3) }; current = false; yield { y: 1, data: new Uint8Array(3) }; } finally { sourceClosed = true; } })();
  const parts: string[] = [];
  await assert.rejects(writePngRows(1, 2, 3, source, async b => { parts.push(Buffer.from(b.subarray(4, 8)).toString()); }, { isCurrent: () => current }), { code: 'CANCELLED' });
  assert.ok(sourceClosed); assert.ok(!parts.includes('IEND'));
  await assert.rejects(writePngRows(1, 1, 3, rows([[0, 0, 0]]), async () => { throw new Error('disk full'); }), { message: 'disk full' });
});

test('invalid dimensions reject before any write; unmanaged color can omit the sRGB assertion', async () => {
  for (const dimensions of [[0, 1], [1, 0], [1.1, 1], [0x80000000, 1], [3000000, 1]]) {
    await assert.rejects(writePngRows(dimensions[0], dimensions[1], 3, rows([]), async () => { assert.fail('unexpected write'); }), { code: 'PNG_DIMENSIONS' });
  }
  const parts: Buffer[] = [];
  await writePngRows(1, 1, 3, rows([[0, 0, 0]]), async b => { parts.push(Buffer.from(b)); }, { srgb: false });
  assert.ok(!inspect(Buffer.concat(parts)).some(c => c.type === 'sRGB'));
});

test('periodic event-loop yield lets a cancellation event interrupt a synchronously resolved sink', async () => {
  let current = true, count = 0, closed = false;
  const source = (async function* () {
    try { for (let y = 0; y < 100; y++) yield { y, data: new Uint8Array(3) }; }
    finally { closed = true; }
  })();
  await assert.rejects(writePngRows(1, 100, 3, source, async () => {}, {
    isCurrent: () => current,
    onProgress: n => { count = n; if (n === 1) setTimeout(() => { current = false; }, 0); },
  }), { code: 'CANCELLED' });
  assert.equal(count, 32); assert.ok(closed);
});

test('serial callback source exports reused rows exactly and obeys write backpressure', async () => {
  let consumed = 0, unlock!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const values = (y: number) => {
    const data = new Uint8Array(6016 * 3); let random = y + 1029384756;
    for (let i = 0; i < data.length; i++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; data[i] = random & 255; }
    return data;
  };
  const source = async (consume: (row: PngRow) => Promise<void>) => {
    const data = new Uint8Array(6016 * 3);
    for (let y = 0; y < 35; y++) { data.set(values(y)); await consume({ y, data }); consumed++; }
  };
  const output: Buffer[] = [];
  let paused = false;
  const task = writePngRows(6016, 35, 3, source, async bytes => {
    const type = Buffer.from(bytes.subarray(4, 8)).toString();
    if (!paused && type === 'IDAT') { paused = true; entered(); await gate; }
    output.push(Buffer.from(bytes));
  });
  await blocked; const before = consumed;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(consumed, before); assert.ok(consumed < 35);
  unlock(); await task;
  const png = PNG.sync.read(Buffer.concat(output));
  assert.equal(png.width, 6016); assert.equal(png.height, 35);
  for (let y = 0; y < 35; y++) for (const x of [0, 3008, 6015]) {
    const expected = values(y).subarray(x * 3, x * 3 + 3);
    assert.deepEqual([...png.data.subarray((y * 6016 + x) * 4, (y * 6016 + x) * 4 + 4)], [...expected, 255]);
  }
});

test('serial callback keeps strict order/length diagnostics and cancellation before the next row', async () => {
  for (const sourceRow of [{ y: 1, data: new Uint8Array(3) }, { y: 0, data: new Uint8Array(2) }]) {
    await assert.rejects(writePngRows(1, 1, 3, async consume => { await consume(sourceRow); }, async () => {}), (error: any) => {
      assert.equal(error.code, 'PNG_ROW'); assert.match(error.message, /预期行号 0、3 字节/);
      assert.match(error.message, new RegExp(`实际行号 ${sourceRow.y}、${sourceRow.data.byteLength} 字节`)); return true;
    });
  }
  let active = true, calls = 0;
  await assert.rejects(writePngRows(1, 2, 3, async consume => {
    await consume({ y: 0, data: new Uint8Array(3) }); calls++;
    await consume({ y: 1, data: new Uint8Array(3) }); calls++;
  }, async () => {}, { isCurrent: () => active, onProgress: () => { active = false; } }), { code: 'CANCELLED' });
  assert.equal(calls, 1);
});
