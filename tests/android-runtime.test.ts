import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { photoshopPrefix } from './helpers/photoshop-thumbnail';

const { PNG } = require('pngjs') as { PNG: { sync: { read(bytes: Buffer): { width: number; height: number; data: Buffer } } } };

const bundle = () => readFileSync('android/app/src/main/assets/core.js', 'utf8');
test('packaged Android runtime reads a real PSB fixture through the exact base64 bridge contract', async () => {
  const source = readFileSync('tests/fixtures/photoshop/generated-rle.psb');
  const replies: { token: number; metadata: any; bytes: Buffer }[] = [];
  const failures: string[] = [];
  const context: any = {
    TextEncoder, TextDecoder,
    atob: (text: string) => Buffer.from(text, 'base64').toString('binary'),
    btoa: (text: string) => Buffer.from(text, 'binary').toString('base64'),
    AndroidBridge: {
      isCurrent: () => true,
      read(token: number, offset: number, length: number) {
        assert.equal(token, 7);
        assert.ok(Number.isSafeInteger(offset) && offset >= 0 && length <= 1024 * 1024);
        assert.ok(offset <= source.length - length);
        return JSON.stringify({ base64: source.subarray(offset, offset + length).toString('base64') });
      },
      complete(token: number, metadata: string, data: string) {
        replies.push({ token, metadata: JSON.parse(metadata), bytes: Buffer.from(data, 'base64') });
      },
      fail(_token: number, message: string) { failures.push(message); },
    },
  };
  // No DOM, wx, Buffer, require or network APIs inside the packaged runtime.
  runInNewContext(bundle(), context, { timeout: 3000 });
  await context.JzgCore.start(7, 'generated-rle.psb', source.length);
  assert.deepEqual(failures, []);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].metadata.kind, 'rgba');
  assert.equal(replies[0].metadata.format, 'PSB');
  assert.equal(replies[0].bytes.length, replies[0].metadata.width * replies[0].metadata.height * 4);
  assert.ok(replies[0].bytes.some(value => value !== 0));
});

test('packaged runtime reports bridge errors and suppresses obsolete requests', async () => {
  let active = true, reads = 0;
  const failures: string[] = [];
  const context: any = {
    TextEncoder, TextDecoder,
    atob: () => '', btoa: () => '',
    AndroidBridge: {
      isCurrent: () => active,
      read() { reads++; return JSON.stringify({ error: '文件已关闭' }); },
      complete() { assert.fail('No success after failed/cancelled read'); },
      fail(_token: number, message: string) { failures.push(message); },
    },
  };
  runInNewContext(bundle(), context, { timeout: 3000 });
  await context.JzgCore.start(1, 'test.psd', 100);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /文件已关闭/);
  active = false;
  const before = reads;
  await context.JzgCore.start(2, 'test.psd', 100);
  assert.equal(reads, before);
  assert.equal(failures.length, 1);
});

test('packaged runtime exposes only validated static frames for the current SVG animation', async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40">'
    + '<title>动画</title><circle cx="10" cy="20" r="5"><animate attributeName="cx" from="10" to="90" dur="2s" fill="freeze"/>'
    + '</circle></svg>');
  let metadata: { svgDuration?: number } | undefined;
  let initial = '';
  const context: any = {
    TextEncoder, TextDecoder,
    atob: (text: string) => Buffer.from(text, 'base64').toString('binary'),
    btoa: (text: string) => Buffer.from(text, 'binary').toString('base64'),
    AndroidBridge: {
      isCurrent: (token: number) => token === 7,
      read(_token: number, offset: number, length: number) {
        return JSON.stringify({ base64: source.subarray(offset, offset + length).toString('base64') });
      },
      complete(_token: number, json: string, payload: string) {
        metadata = JSON.parse(json);
        initial = Buffer.from(payload, 'base64').toString('utf8');
      },
      fail(_token: number, message: string) { assert.fail(message); },
    },
  };
  runInNewContext(bundle(), context, { timeout: 3000 });
  await context.JzgCore.start(7, 'animated.svg', source.length);
  assert.equal(metadata?.svgDuration, 2);
  const frame = (seconds: number) => Buffer.from(context.JzgCore.svgFrame(7, seconds), 'base64').toString('utf8');
  assert.equal(frame(0), initial);
  assert.match(frame(1), /<title>动画<\/title><circle cx="50"/);
  assert.doesNotMatch(frame(1), /<animate/);
  assert.match(frame(4), /cx="90"/);
  assert.equal(context.JzgCore.svgFrame(7, Infinity), null);
  assert.equal(context.JzgCore.svgFrame(6, 1), null);
  context.JzgCore.clear(7);
  assert.equal(context.JzgCore.svgFrame(7, 1), null);
});

test('packaged runtime reads only the requested PSB detail and streams verified original-size PNG', async () => {
  const width = 1800, height = 4, x = 1374, y = 2;
  const planes = [19, 91, 211].map(value => {
    const plane = Buffer.alloc(width * height);
    plane[y * width + x] = value;
    return plane;
  });
  const source = Buffer.concat([photoshopPrefix(2, width, height, Buffer.alloc(0)), ...planes]);
  const reads: number[] = [], chunks: Buffer[] = [], completion: string[] = [];
  let token = 7, currentRegion = 3, currentExport = 4;
  let metadata: any, region: { width: number; height: number; pixels: number[] } | undefined;
  const context: any = {
    TextEncoder, TextDecoder, setTimeout,
    atob: (text: string) => Buffer.from(text, 'base64').toString('binary'),
    btoa: (text: string) => Buffer.from(text, 'binary').toString('base64'),
    AndroidBridge: {
      isCurrent: (candidate: number) => candidate === token,
      read(candidate: number, offset: number, length: number) {
        assert.equal(candidate, token);
        reads.push(length);
        return JSON.stringify({ base64: source.subarray(offset, offset + length).toString('base64') });
      },
      complete(_token: number, json: string) { metadata = JSON.parse(json); },
      fail(_token: number, message: string) { assert.fail(message); },
      isRegionCurrent: (candidate: number, request: number) => candidate === token && request === currentRegion,
      completeRegion(_token: number, _request: number, width: number, height: number, payload: string) {
        region = { width, height, pixels: [...Buffer.from(payload, 'base64')] };
      },
      failRegion(_token: number, _request: number, message: string) { assert.fail(message); },
      exportCurrent: (candidate: number, request: number) => candidate === token && request === currentExport,
      writePng(_token: number, _request: number, payload: string) {
        const bytes = Buffer.from(payload, 'base64');
        assert.ok(bytes.length <= 64 * 1024);
        chunks.push(bytes);
        return true;
      },
      exportComplete(_token: number, _request: number, message: string) { completion.push(message); },
    },
  };
  runInNewContext(bundle(), context, { timeout: 3000 });
  await context.JzgCore.start(token, 'wide.psb', source.length);
  assert.deepEqual([metadata.width, metadata.height, metadata.sourceWidth, metadata.sourceHeight], [1365, 3, width, height]);
  assert.equal(metadata.regionAvailable, true);
  assert.equal(metadata.exportKind, 'nativePng');
  reads.length = 0;
  await context.JzgCore.region(token, currentRegion - 1, x, y, 1, 1, 1, 1);
  assert.deepEqual(reads, []);
  await context.JzgCore.region(token, currentRegion, x, y, 1, 1, 1, 1);
  assert.deepEqual(region, { width: 1, height: 1, pixels: [19, 91, 211, 255] });
  assert.deepEqual(reads, [1, 1, 1]);
  await context.JzgCore.exportPng(token, currentExport - 1);
  assert.match(completion.shift()!, /取消/);
  assert.equal(chunks.length, 0);
  await context.JzgCore.exportPng(token, currentExport);
  assert.deepEqual(completion, ['']);
  const png = PNG.sync.read(Buffer.concat(chunks));
  assert.deepEqual([png.width, png.height], [width, height]);
  assert.deepEqual([...png.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)], [19, 91, 211, 255]);
  context.JzgCore.clear(token);
  currentExport++;
  await context.JzgCore.exportPng(token, currentExport);
  assert.match(completion[1], /不支持/);
});
