import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { checkFileSize, detectFormat, inspectAi } from '../src/core/files';
import { checkImageBudget, LIMITS, QuickViewError, utf8ByteLength } from '../src/core/shared';
import { aiContainer } from './helpers/ai-container';

const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const failure = (action: () => unknown, code: string) => assert.throws(action,
  (error: unknown) => error instanceof QuickViewError && error.code === code);

test('Photoshop signature and version override filename; renamed invalid files fail', () => {
  assert.equal(detectFormat(bytes('8BPS\0\x01'), 'wrong.svg'), 'PSD');
  assert.equal(detectFormat(bytes('8BPS\0\x02'), 'wrong.psd'), 'PSB');
  failure(() => detectFormat(bytes('8BPS\0\x03'), 'x.psb'), 'UNSUPPORTED_VERSION');
  failure(() => detectFormat(bytes('8BPS'), 'x.psd'), 'TRUNCATED');
  failure(() => detectFormat(bytes('not a Photoshop document'), 'x.psd'), 'UNSUPPORTED_FORMAT');
});

test('ordinary PDF is rejected while PDF-compatible AI remains supported; SVG selection still requires strict parse afterward', () => {
  assert.equal(detectFormat(bytes('%PDF-1.7\n'), 'example.AI'), 'AI');
  assert.equal(detectFormat(bytes('<?xml version="1.0"?><svg/>'), 'file'), 'SVG');
  failure(() => detectFormat(bytes('%PDF-1.7\n'), 'ordinary.pdf'), 'UNSUPPORTED_FORMAT');
  failure(() => detectFormat(bytes('%PDF-1.7\n'), 'renamed.svg'), 'UNSUPPORTED_FORMAT');
  failure(() => detectFormat(bytes('not a PDF'), 'broken.pdf'), 'UNSUPPORTED_FORMAT');
  failure(() => detectFormat(bytes('%!PS-Adobe-3.0 Illustrator'), 'legacy.ai'), 'AI_NO_PDF');
  failure(() => detectFormat(bytes('garbage'), 'broken.ai'), 'INVALID_AI');
});

test('file size and working memory guards have concrete independent limits', () => {
  checkFileSize('PSD', LIMITS.photoshopBytes);
  checkFileSize('SVG', LIMITS.svgBytes);
  checkFileSize('AI', LIMITS.aiBytes);
  failure(() => checkFileSize('PSB', LIMITS.photoshopBytes + 1), 'FILE_TOO_LARGE');
  failure(() => checkFileSize('AI', LIMITS.aiBytes + 1), 'FILE_TOO_LARGE');
  failure(() => checkFileSize('SVG', LIMITS.svgBytes + 1), 'FILE_TOO_LARGE');
  failure(() => checkFileSize('SVG', 0), 'EMPTY_FILE');
  failure(() => checkImageBudget(5000, 1, 100), 'IMAGE_TOO_LARGE');
  failure(() => checkImageBudget(2049, 2049, 100), 'IMAGE_TOO_LARGE');
  failure(() => checkImageBudget(2048, 2048, 1), 'MEMORY_BUDGET');
  failure(() => checkImageBudget(100, 100, Number.MAX_SAFE_INTEGER), 'MEMORY_BUDGET');
  failure(() => checkImageBudget(NaN, 10, 100), 'INVALID_DIMENSIONS');
  assert.equal(checkImageBudget(100, 100, 100), 240300);
  assert.equal(utf8ByteLength('设计🙂稿'), Buffer.byteLength('设计🙂稿'));
});

const upstreamPath = 'tests/fixtures/ai/upstream-illustrator-grid.ai';
const upstream = existsSync(upstreamPath) ? new Uint8Array(readFileSync(upstreamPath)) : undefined;
test('actual four-page upstream AI passes compatibility checks and independent PDF parser', { skip: !upstream }, async () => {
  assert.ok(upstream);
  assert.equal(createHash('sha256').update(upstream).digest('hex'), 'af0f68462ff032c81309744f6ddc5c06f032949074f59464763bf8bf14517084');
  assert.equal(detectFormat(upstream.subarray(0, 4096), 'illustrator-grid.ai'), 'AI');
  assert.equal(inspectAi(upstream).warnings.length, 2);
  const document = await PDFDocument.load(upstream, { updateMetadata: false });
  assert.equal(document.getPageCount(), 4);
  assert.equal(document.getCreator(), 'Adobe Illustrator CC 2015 (Macintosh)');
});

test('truncated, fake and inconsistent PDF-compatible AI fail with accurate reasons', async () => {
  const source = upstream ?? await aiContainer();
  failure(() => inspectAi(bytes('garbage Illustrator')), 'AI_NO_PDF');
  failure(() => inspectAi(bytes('%PDF-1.7\nnot an AI\n%%EOF')), 'AI_IDENTITY');
  failure(() => inspectAi(source.slice(0, source.length - 20)), 'AI_INCOMPLETE');
  const replaced = Buffer.from(source).toString('latin1').replace(/startxref\s+\d+/, 'startxref\n9007199254740993');
  failure(() => inspectAi(new Uint8Array(Buffer.from(replaced, 'latin1'))), 'AI_INCOMPLETE');
  const incorrect = Buffer.from(source).toString('latin1').replace(/startxref\s+\d+/, 'startxref\n10');
  failure(() => inspectAi(new Uint8Array(Buffer.from(incorrect, 'latin1'))), 'AI_INCOMPLETE');
});

for (const streams of [false, true]) {
  test(`generated valid PDF container (${streams ? 'xref stream' : 'classic xref'}) checked without a PDF reader`, async () => {
    // Synthetic container exercises structure, not an independent Illustrator export.
    const encoded = await aiContainer(streams);
    assert.ok(inspectAi(encoded).warnings.length);
    const roundtrip = await PDFDocument.load(encoded);
    assert.equal(roundtrip.getPageCount(), 1);
  });
}
