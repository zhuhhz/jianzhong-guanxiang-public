import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectAi, inspectAiFile } from '../src/core/files';
import { aiContainer } from './helpers/ai-container';

function reader(bytes: Uint8Array) {
  const reads: { offset: number; length: number }[] = [];
  return { reads, read: async (offset: number, length: number) => {
    assert.ok(offset >= 0 && length > 0 && length <= 65536 && offset + length <= bytes.length);
    reads.push({ offset, length }); return bytes.subarray(offset, offset + length);
  } };
}

for (const streams of [false, true]) test(`bounded AI inspection matches the existing valid ${streams ? 'xref stream' : 'classic'} control`, async () => {
  const bytes = await aiContainer(streams), source = reader(bytes);
  const result = await inspectAiFile(source.read, bytes.length);
  assert.deepEqual(result.warnings, inspectAi(bytes).warnings);
  assert.equal(result.pdfVersion, '1.7'); assert.ok(result.xrefOffset > 0);
});

// Structural scanner control only; PDF object validity remains the viewer's job.
function boundaryControl(encrypted = false) {
  const bytes = Buffer.alloc(128 * 1024, 32), xref = bytes.length - 180;
  bytes.write('%PDF-1.7\n', 0); bytes.write('Illustrator', 65531);
  const tail = `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R ${encrypted ? '/Encrypt 2 0 R' : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  bytes.write(tail, xref); return bytes.subarray(0, xref + Buffer.byteLength(tail));
}

test('AI identity split across 64 KiB blocks is retained without a whole-file read', async () => {
  const bytes = boundaryControl(), source = reader(bytes);
  assert.equal((await inspectAiFile(source.read, bytes.length)).pdfVersion, '1.7');
  assert.ok(source.reads.every(r => r.length < bytes.length));
  assert.ok(source.reads.some(r => r.offset === 65536));
});

test('bounded AI validation preserves encryption, malformed index and no-PDF rejection', async () => {
  const encrypted = boundaryControl(true);
  await assert.rejects(inspectAiFile(reader(encrypted).read, encrypted.length), { code: 'AI_ENCRYPTED' });
  const bad = Buffer.from(boundaryControl()); bad.write('xxxx', bad.length - 180);
  // Corrupt the actual startxref target, not an arbitrary whitespace location.
  const xref = Number(/startxref\s+(\d+)/.exec(bad.toString())![1]); bad.write('xxxx', xref);
  await assert.rejects(inspectAiFile(reader(bad).read, bad.length), { code: 'AI_INCOMPLETE' });
  const eps = Buffer.from('%!PS-Adobe Illustrator\n');
  await assert.rejects(inspectAiFile(reader(eps).read, eps.length), { code: 'AI_NO_PDF' });
});

test('bounded AI inspection cancels before and after I/O, rejects short reads, and permits retry', async () => {
  const bytes = boundaryControl(); let current = true, calls = 0;
  const read = async (offset: number, length: number) => {
    calls++; if (length === 65536) current = false; return bytes.subarray(offset, offset + length);
  };
  await assert.rejects(inspectAiFile(read, bytes.length, () => false), { code: 'CANCELLED' }); assert.equal(calls, 0);
  await assert.rejects(inspectAiFile(read, bytes.length, () => current), { code: 'CANCELLED' }); assert.equal(calls, 3);
  await assert.rejects(inspectAiFile(async (o, n) => bytes.subarray(o, o + n - 1), bytes.length), { code: 'TRUNCATED' });
  assert.equal((await inspectAiFile(reader(bytes).read, bytes.length)).pdfVersion, '1.7');
  for (const size of [0, -1, NaN, Infinity]) await assert.rejects(inspectAiFile(read, size), { code: 'EMPTY_FILE' });
});
