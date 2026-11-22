import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';

test('RAW package ships only Brotli WASM below 2 MiB with unchanged upstream engine bytes', () => {
  const dir = 'src/raw-engine', compressed = readFileSync(join(dir, 'flashraw.wasm.br'));
  const bytes = readdirSync(dir).reduce((n, file) => n + statSync(join(dir, file)).size, 0);
  assert.ok(bytes < 2 * 1024 * 1024);
  assert.equal(existsSync(join(dir, 'flashraw.wasm')), false);
  const wasm = brotliDecompressSync(compressed);
  assert.equal(wasm.length, 2918514);
  assert.equal(createHash('sha256').update(wasm).digest('hex'),
    '45a7f332c880fa012d152f8c744ac40f82e99a52a5ccf0fa37b347f84d1109de');
  assert.equal((globalThis as any).WebAssembly.validate(wasm), true);
});

const engineCode = buildSync({ entryPoints: ['src/platform/raw-engine.ts'], bundle: true, platform: 'neutral', format: 'cjs', target: 'es2018', write: false }).outputFiles[0].text;
function engineModule(nativeRequire: unknown, nativeWasm?: unknown) {
  const module = { exports: {} as { rawEngine(): Promise<unknown>; rawFailureMessage(value: unknown): string } };
  runInNewContext(engineCode, { module, exports: module.exports, require: nativeRequire, WXWebAssembly: nativeWasm });
  return module.exports;
}

test('RAW loader preserves require.async receiver, reports native objects by stage and permits retry', async () => {
  let loads = 0, instantiations = 0;
  const nativeRequire = Object.assign(() => {}, { async: async function(this: unknown, path: string) {
    assert.equal(this, nativeRequire); assert.equal(path, '../../raw-engine/entry.js'); loads++;
    if (loads === 1) throw { errMsg: 'subpackage file not found', mod: path };
  } });
  const engine = engineModule(nativeRequire, { instantiate: async () => { instantiations++; throw { errMsg: 'wasm native compile failed' }; } });
  await assert.rejects(engine.rawEngine(), (error: any) => error.code === 'RAW_SUBPACKAGE_LOAD' && /subpackage file not found/.test(error.message));
  assert.equal(instantiations, 0);
  for (let i = 0; i < 2; i++) await assert.rejects(engine.rawEngine(), (error: any) => error.code === 'RAW_ENGINE_INIT' && /wasm native compile failed/.test(error.message));
  assert.equal(loads, 3); assert.equal(instantiations, 2);
});

test('RAW load diagnostics distinguish missing APIs and retain cross-realm Error messages', async () => {
  const absent = engineModule(() => {});
  await assert.rejects(absent.rawEngine(), { code: 'RAW_ENGINE_UNAVAILABLE' });
  const noAsync = engineModule(() => {}, {});
  await assert.rejects(noAsync.rawEngine(), { code: 'RAW_SUBPACKAGE_UNAVAILABLE' });
  assert.equal(noAsync.rawFailureMessage(runInNewContext('new Error("native realm failure")')), 'native realm failure');
  assert.equal(noAsync.rawFailureMessage('native string failure'), 'native string failure');
  assert.equal(noAsync.rawFailureMessage({ errMsg: 'native object failure' }), 'native object failure');
});

for (const wrapped of [false, true]) test(`RAW WASM accepts ${wrapped ? '{instance,module}' : 'direct Instance'} native return shape`, async () => {
  let loads = 0, starts = 0, instantiations = 0;
  const nativeRequire = Object.assign(() => {}, { async: async () => { loads++; } });
  const instance = { exports: { __wbindgen_start: () => { starts++; }, memory: { buffer: new ArrayBuffer(8) } } };
  const engine = engineModule(nativeRequire, { instantiate: async (path: string) => {
    assert.equal(path, '/raw-engine/flashraw.wasm.br'); instantiations++;
    return wrapped ? { instance, module: {} } : instance;
  } });
  const [a, b] = await Promise.all([engine.rawEngine(), engine.rawEngine()]);
  assert.equal((a as { memoryBytes(): number }).memoryBytes(), 8);
  assert.equal((b as { memoryBytes(): number }).memoryBytes(), 8);
  assert.equal(loads, 1); assert.equal(instantiations, 1); assert.equal(starts, 1);
});

test('failed WASM start does not leave a half-initialized engine cached on retry', async () => {
  let attempts = 0;
  const nativeRequire = Object.assign(() => {}, { async: async () => {} });
  const engine = engineModule(nativeRequire, { instantiate: async () => {
    const attempt = ++attempts;
    return { instance: { exports: { memory: { buffer: new ArrayBuffer(8) },
      __wbindgen_start: () => { if (attempt === 1) throw { errMsg: 'native start failed' }; } } } };
  } });
  await assert.rejects(engine.rawEngine(), (error: any) => error.code === 'RAW_ENGINE_INIT' && /native start failed/.test(error.message));
  const ready = await engine.rawEngine(); assert.equal((ready as { memoryBytes(): number }).memoryBytes(), 8);
  assert.equal(attempts, 2);
});
