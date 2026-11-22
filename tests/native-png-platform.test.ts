import assert from 'node:assert/strict';
import { accessSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, test } from 'node:test';
import { cleanupPreview, saveNativePng, preparePreview, type ChosenFile } from '../src/platform/wechat';
import { inspectIcc } from '../src/core/icc';
import { matrixIcc } from './helpers/icc';
import { raw16 } from './helpers/photoshop-16bit';
import { photoshopPrefix, resource } from './helpers/photoshop-thumbnail';
import { tiffImage } from './helpers/tiff';

const { PNG } = createRequire(__filename)('pngjs');
type Callbacks = { success?: (result?: any) => void; fail?: (error: { errMsg: string; errno?: number }) => void; complete?: () => void };

// Real Node file I/O behind WeChat-shaped callbacks; this is not device evidence.
class NativeBridge {
  root = mkdtempSync(join(resolve('test-results'), 'native-png-'));
  userData = join(this.root, 'userdata');
  descriptors = new Map<string, number>();
  opened: string[] = [];
  closed: string[] = [];
  writes: { path: string; position: number; requested: number; written: number }[] = [];
  reads: { path: string; position: number; length: number }[] = [];
  canvasExports = 0;
  writeLimit = Infinity;
  writeFailure?: { errMsg: string; errno?: number };
  activeWrites = 0;
  maximumWrites = 0;
  holdWrite?: { started: () => void; release?: () => void };
  delivery?: { filePath: string; options: Callbacks };
  constructor() { mkdirSync(this.userData); }
  file(name: string, bytes: Uint8Array): ChosenFile {
    const path = join(this.root, name); writeFileSync(path, bytes);
    return { path, name, size: bytes.byteLength };
  }
  gateWrite() {
    let started!: () => void;
    const pending = new Promise<void>(resolveStarted => { started = resolveStarted; });
    const gate = { started, release: undefined as (() => void) | undefined };
    this.holdWrite = gate;
    return { started: pending, release: () => gate.release?.() };
  }
  wx() {
    const execute = (options: Callbacks, action: () => unknown) => {
      try { const value = action(); queueMicrotask(() => { options.success?.(value); options.complete?.(); }); }
      catch (error) { queueMicrotask(() => { options.fail?.({ errMsg: String(error) }); options.complete?.(); }); }
    };
    const filesystem = {
      accessSync,
      stat: (options: Callbacks & { path: string }) => execute(options, () => ({ stats: statSync(options.path) })),
      readFile: (options: Callbacks & { filePath: string; position: number; length: number }) => execute(options, () => {
        this.reads.push({ path: options.filePath, position: options.position, length: options.length });
        const fd = openSync(options.filePath, 'r'), bytes = Buffer.alloc(options.length);
        try { const n = readSync(fd, bytes, 0, bytes.length, options.position); return { data: Uint8Array.from(bytes.subarray(0, n)).buffer }; }
        finally { closeSync(fd); }
      }),
      mkdir: (options: Callbacks & { dirPath: string }) => execute(options, () => mkdirSync(options.dirPath, { recursive: true })),
      readdir: (options: Callbacks & { dirPath: string }) => execute(options, () => ({ files: readdirSync(options.dirPath) })),
      unlink: (options: Callbacks & { filePath: string }) => execute(options, () => unlinkSync(options.filePath)),
      open: (options: Callbacks & { filePath: string; flag: string }) => execute(options, () => {
        assert.equal(options.flag, 'wx');
        const fd = openSync(options.filePath, options.flag), id = String(fd);
        this.opened.push(options.filePath); this.descriptors.set(id, fd); return { fd: id };
      }),
      write: (options: Callbacks & { fd: string; data: ArrayBuffer; position: number }) => {
        this.activeWrites++; this.maximumWrites = Math.max(this.maximumWrites, this.activeWrites);
        const finish = () => {
          this.activeWrites--;
          if (this.writeFailure) { options.fail?.(this.writeFailure); options.complete?.(); return; }
          try {
            assert.ok(options.data instanceof ArrayBuffer, 'bridge receives a bounded native ArrayBuffer');
            assert.ok(options.data.byteLength <= 64 * 1024);
            const fd = this.descriptors.get(options.fd)!;
            const bytes = Buffer.from(options.data), count = Math.min(bytes.length, this.writeLimit);
            const written = count ? writeSync(fd, bytes, 0, count, options.position) : 0;
            this.writes.push({ path: this.opened[this.opened.length - 1], position: options.position, requested: bytes.length, written });
            options.success?.({ bytesWritten: written }); options.complete?.();
          } catch (error) { options.fail?.({ errMsg: String(error) }); options.complete?.(); }
        };
        const gate = this.holdWrite;
        if (gate) { this.holdWrite = undefined; gate.release = () => queueMicrotask(finish); gate.started(); }
        else queueMicrotask(finish);
      },
      close: (options: Callbacks & { fd: string }) => execute(options, () => {
        closeSync(this.descriptors.get(options.fd)!); this.descriptors.delete(options.fd); this.closed.push(options.fd);
      }),
    };
    return {
      env: { USER_DATA_PATH: this.userData },
      canIUse: () => true,
      getFileSystemManager: () => filesystem,
      canvasToTempFilePath: (options: Callbacks & { canvas: FakeCanvas }) => execute(options, () => {
        this.canvasExports++;
        const path = join(this.root, `preview-${this.canvasExports}.png`);
        const image = options.canvas.image!;
        writeFileSync(path, PNG.sync.write({ ...image, data: Buffer.from(image.data) }));
        return { tempFilePath: path };
      }),
      saveImageToPhotosAlbum: (options: Callbacks & { filePath: string }) => { this.delivery = { filePath: options.filePath, options }; },
    };
  }
}

class FakeCanvas {
  width = 1; height = 1;
  image?: { width: number; height: number; data: Uint8ClampedArray };
  getContext() { return {
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: (image: FakeCanvas['image']) => { this.image = image; },
  }; }
  native() { return this as unknown as WechatMiniprogram.Canvas; }
}

function rgb8(version: 1 | 2, rle: boolean) {
  const width = 4, height = 3, prefix = photoshopPrefix(version, width, height, resource(1039, matrixIcc(true)));
  const value = (c: number, x: number, y: number) => (c * 71 + y * 13 + x * 29) & 255;
  const planes: Buffer[] = [];
  for (let c = 0; c < 3; c++) for (let y = 0; y < height; y++) planes.push(Buffer.from(Array.from({ length: width }, (_, x) => value(c, x, y))));
  if (!rle) return { bytes: Buffer.concat([prefix, ...planes]), width, height, value };
  prefix.writeUInt16BE(1, prefix.length - 2);
  const size = version === 1 ? 2 : 4, table = Buffer.alloc(planes.length * size);
  planes.forEach((row, i) => size === 2 ? table.writeUInt16BE(row.length + 1, i * size) : table.writeUInt32BE(row.length + 1, i * size));
  return { bytes: Buffer.concat([prefix, table, ...planes.map(row => Buffer.concat([Buffer.from([width - 1]), row]))]), width, height, value };
}

let bridge: NativeBridge;
beforeEach(() => {
  mkdirSync(resolve('test-results'), { recursive: true }); bridge = new NativeBridge();
  (globalThis as unknown as { wx: typeof wx }).wx = bridge.wx() as unknown as typeof wx;
});
afterEach(async () => {
  await cleanupPreview();
  for (const fd of bridge.descriptors.values()) closeSync(fd);
  rmSync(bridge.root, { recursive: true, force: true });
});

test('native PNG adapter preserves exact RGB8 PSD/PSB Raw/RLE source pixels and preview cache', async () => {
  for (const version of [1, 2] as const) for (const rle of [false, true]) {
    const sample = rgb8(version, rle), source = bridge.file(`source-${version}-${rle}.${version === 1 ? 'psd' : 'psb'}`, sample.bytes);
    const prepared = await preparePreview(source, new FakeCanvas().native());
    assert.ok(prepared.prepareNative); const previewPath = prepared.previewPath, exportPath = prepared.exportPath;
    const canvasCalls = bridge.canvasExports, progress: number[] = [];
    const path = await prepared.prepareNative(() => true, rows => progress.push(rows));
    assert.equal(bridge.canvasExports, canvasCalls, 'original export never uses Canvas');
    assert.equal(prepared.previewPath, previewPath); assert.equal(prepared.exportPath, exportPath);
    assert.notEqual(path, previewPath); assert.ok(existsSync(source.path));
    const png = PNG.sync.read(readFileSync(path)); assert.equal(png.width, sample.width); assert.equal(png.height, sample.height);
    for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
      for (let c = 0; c < 3; c++) assert.equal(png.data[(y * sample.width + x) * 4 + c], sample.value(c, x, y));
      assert.equal(png.data[(y * sample.width + x) * 4 + 3], 255);
    }
    assert.deepEqual(progress, [1, 2, 3]); assert.equal(bridge.descriptors.size, 0);
  }
});

test('native RGB16 five-channel adapter converts uint16 ICC before quantization, ignores extras', async () => {
  const sample = raw16({ width: 5, height: 3, channels: 5, count: 1, resources: resource(1039, matrixIcc()) });
  const source = bridge.file('rgb16.psd', sample.bytes), prepared = await preparePreview(source, new FakeCanvas().native());
  assert.ok(prepared.prepareNative); const path = await prepared.prepareNative(() => true, () => {});
  const png = PNG.sync.read(readFileSync(path)), color = inspectIcc(matrixIcc());
  for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) {
    const expected = color.convert!(sample.value(0, x, y) / 65535, sample.value(1, x, y) / 65535, sample.value(2, x, y) / 65535);
    for (let c = 0; c < 3; c++) assert.equal(png.data[(y * 5 + x) * 4 + c], Math.round(expected[c] * 255));
    assert.equal(png.data[(y * 5 + x) * 4 + 3], 255);
  }
});

test('TIFF Raw/LZW/Deflate native PNG preserves original dimensions, alpha and preview cache', async () => {
  for (const compression of [1, 5, 8]) for (const components of [3, 4]) {
    const pixels = components === 3 ? [255, 0, 0, 0, 255, 0] : [255, 0, 0, 0, 0, 255, 0, 128];
    const original = tiffImage({ compression, components, extras: components === 4 ? [2] : [], pixels: Uint8Array.from(pixels) });
    const source = bridge.file('native.tif', original);
    const prepared = await preparePreview(source, new FakeCanvas().native());
    assert.equal(prepared.info.exportSupported, true);
    assert.equal(prepared.exportPath, prepared.previewPath);
    assert.ok(prepared.prepareNative);
    const canvasCalls = bridge.canvasExports, progress: number[] = [];
    const path = await prepared.prepareNative(() => true, rows => progress.push(rows));
    const png = PNG.sync.read(readFileSync(path));
    assert.deepEqual([png.width, png.height], [2, 1]);
    assert.deepEqual([...png.data], components === 3 ? [255, 0, 0, 255, 0, 255, 0, 255] : pixels);
    assert.deepEqual(progress, [1]);
    assert.notEqual(path, prepared.previewPath);
    assert.equal(bridge.canvasExports, canvasCalls);
    assert.deepEqual(readFileSync(source.path), Buffer.from(original));
    assert.equal(bridge.descriptors.size, 0);
  }
});

test('TIFF RGB16 native PNG ignores independent extras and preserves source RGB in 8-bit output', async () => {
  const pixels = Uint8Array.of(255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 255, 255);
  const source = bridge.file('extra-channels.tif', tiffImage({ bits: 16, components: 5, extras: [0, 0], pixels }));
  const prepared = await preparePreview(source, new FakeCanvas().native());
  const path = await prepared.prepareNative!(() => true, () => {});
  assert.deepEqual([...PNG.sync.read(readFileSync(path)).data], [255, 0, 0, 255, 0, 255, 0, 255]);
  assert.ok(bridge.reads.every(read => read.length <= 512 * 1024));
});

test('TIFF native PNG applies ICC before 16-bit quantization and writes a verified sRGB tag', async () => {
  const profile = matrixIcc(), color = inspectIcc(profile);
  const values = [0x1234, 0x5678, 0x9abc], pixels = new Uint8Array(10);
  values.forEach((value, i) => new DataView(pixels.buffer).setUint16(i * 2, value, true));
  const source = bridge.file('color.tif', tiffImage({ width: 1, bits: 16, components: 5, extras: [0, 0], pixels, icc: profile }));
  const prepared = await preparePreview(source, new FakeCanvas().native());
  const path = await prepared.prepareNative!(() => true, () => {});
  const bytes = readFileSync(path), png = PNG.sync.read(bytes);
  const expected = color.convert!(values[0] / 65535, values[1] / 65535, values[2] / 65535).map(value => Math.round(value * 255));
  assert.deepEqual([...png.data], [...expected, 255]);
  assert.equal(bytes.toString('ascii', 37, 41), 'sRGB');
});

test('TIFF native cancellation closes and deletes only its incomplete PNG', async () => {
  const source = bridge.file('cancel.tif', tiffImage({ width: 2, height: 40, pixels: new Uint8Array(2 * 40 * 3) }));
  const prepared = await preparePreview(source, new FakeCanvas().native());
  let current = true;
  await assert.rejects(prepared.prepareNative!(() => current, rows => { if (rows === 3) current = false; }), { code: 'CANCELLED' });
  assert.equal(bridge.descriptors.size, 0);
  assert.ok(!existsSync(bridge.opened[bridge.opened.length - 1]));
  assert.ok(existsSync(source.path) && existsSync(prepared.previewPath!));
});

test('optional real TIFF exports original PNG dimensions through the native file adapter', {
  skip: !process.env.TIFF_NATIVE_REAL_FILES,
}, async context => {
  const paths: string[] = JSON.parse(process.env.TIFF_NATIVE_REAL_FILES!);
  const output = resolve(process.env.TIFF_NATIVE_OUTPUT || '.local-test-output/tiff-png');
  mkdirSync(output, { recursive: true });
  const results: Record<string, unknown>[] = [];
  for (const [index, path] of paths.entries()) {
    const before = statSync(path);
    const prepared = await preparePreview({ path, name: basename(path), size: before.size }, new FakeCanvas().native());
    assert.ok(prepared.prepareNative && prepared.exportPath);
    const start = performance.now(), readStart = bridge.reads.length, canvasCalls = bridge.canvasExports;
    let lastRow = 0;
    const png = await prepared.prepareNative(() => true, row => { assert.equal(row, ++lastRow); });
    const elapsedMs = Math.round(performance.now() - start);
    assert.equal(lastRow, prepared.info.height);
    assert.equal(bridge.canvasExports, canvasCalls);
    const reads = bridge.reads.slice(readStart).filter(read => read.path === path);
    assert.ok(reads.every(read => read.length <= 512 * 1024 && read.length < before.size));
    assert.equal(bridge.descriptors.size, 0);
    const head = Buffer.alloc(29), fd = openSync(png, 'r');
    try { assert.equal(readSync(fd, head, 0, 29, 0), 29); } finally { closeSync(fd); }
    assert.deepEqual([head.readUInt32BE(16), head.readUInt32BE(20)], [prepared.info.width, prepared.info.height]);
    assert.equal(head[24], 8);
    const saved = join(output, `${index}-original.png`);
    copyFileSync(png, saved);
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
    assert.equal(statSync(path).size, before.size);
    const result = { name: basename(path), sourceBytes: before.size, width: prepared.info.width, height: prepared.info.height,
      output: saved, pngBytes: statSync(png).size, elapsedMs, sourceReads: reads.length,
      maxRead: Math.max(...reads.map(read => read.length)), totalRead: reads.reduce((sum, read) => sum + read.length, 0),
      arrayBuffersAtEnd: process.memoryUsage().arrayBuffers };
    results.push(result);
    context.diagnostic(JSON.stringify(result));
  }
  writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
});

test('native writer retries short writes in strict sequence without concurrent native writes', async () => {
  const sample = rgb8(1, false), source = bridge.file('short.psd', sample.bytes);
  const prepared = await preparePreview(source, new FakeCanvas().native()); bridge.writeLimit = 7;
  const path = await prepared.prepareNative!(() => true, () => {});
  assert.ok(bridge.writes.length > 10); assert.equal(bridge.maximumWrites, 1);
  let position = 0;
  for (const write of bridge.writes) { assert.equal(write.position, position); assert.ok(write.written <= 7); position += write.written; }
  assert.equal(statSync(path).size, position); assert.equal(PNG.sync.read(readFileSync(path)).width, 4);
  assert.equal(bridge.descriptors.size, 0); assert.equal(bridge.closed.length, 1);
});

test('zero-progress and native storage errors close descriptors and remove partial PNG without source changes', async () => {
  for (const failure of ['zero', 'storage'] as const) {
    const sample = rgb8(1, false), source = bridge.file(`${failure}.psd`, sample.bytes);
    const prepared = await preparePreview(source, new FakeCanvas().native());
    bridge.writeLimit = failure === 'zero' ? 0 : Infinity;
    bridge.writeFailure = failure === 'storage' ? { errno: 1300202, errMsg: 'storage limit exceeded' } : undefined;
    await assert.rejects(prepared.prepareNative!(() => true, () => {}), { code: failure === 'zero' ? 'SHORT_WRITE' : 'STORAGE_FULL' });
    assert.equal(bridge.descriptors.size, 0); assert.equal(existsSync(bridge.opened[bridge.opened.length - 1]), false);
    assert.deepEqual(readFileSync(source.path), sample.bytes); assert.ok(existsSync(prepared.previewPath!));
  }
});

test('cancelling a pending native write stops later I/O and cleanup waits for close before deleting', async () => {
  const sample = rgb8(1, true), source = bridge.file('cancel.psd', sample.bytes);
  const prepared = await preparePreview(source, new FakeCanvas().native()), gate = bridge.gateWrite();
  let current = true;
  const pending = prepared.prepareNative!(() => current, () => {}), rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await gate.started; const path = bridge.opened[bridge.opened.length - 1];
  assert.equal(bridge.descriptors.size, 1); assert.ok(existsSync(path));
  current = false; await cleanupPreview(); assert.ok(existsSync(path), 'active writer is leased through close');
  const reads = bridge.reads.length; gate.release(); await rejected;
  assert.equal(bridge.reads.length, reads); assert.equal(bridge.writes.length, 1);
  assert.equal(bridge.descriptors.size, 0); assert.equal(existsSync(path), false); assert.ok(existsSync(source.path));
});

test('album saving holds a completed PNG through cleanup, then deletes it after the native callback', async () => {
  const sample = rgb8(1, false), source = bridge.file('album.psd', sample.bytes);
  const prepared = await preparePreview(source, new FakeCanvas().native());
  const path = await prepared.prepareNative!(() => true, () => {});
  const pending = saveNativePng(path, () => true);
  for (let i = 0; i < 8 && bridge.delivery?.filePath !== path; i++) await new Promise<void>(resolveTick => setImmediate(resolveTick));
  assert.equal(bridge.delivery?.filePath, path);
  await cleanupPreview(); assert.ok(existsSync(path));
  bridge.delivery!.options.success?.(); await pending;
  assert.equal(existsSync(path), false); assert.ok(existsSync(source.path));
});

test('failed album saving preserves the completed PNG and retries without reading source pixels again', async () => {
  const sample = rgb8(1, false), source = bridge.file('album-retry.psd', sample.bytes);
  const prepared = await preparePreview(source, new FakeCanvas().native());
  const path = await prepared.prepareNative!(() => true, () => {});
  const bytes = readFileSync(path), sourceReads = bridge.reads.filter(read => read.path === source.path).length;
  const getDelivery = (): NativeBridge['delivery'] => bridge.delivery;
  const failed = saveNativePng(path, () => true), rejected = assert.rejects(failed, { code: 'ALBUM_PERMISSION' });
  for (let i = 0; i < 8 && bridge.delivery?.filePath !== path; i++) await new Promise<void>(resolveTick => setImmediate(resolveTick));
  bridge.delivery!.options.fail?.({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }); await rejected;
  assert.deepEqual(readFileSync(path), bytes); bridge.delivery = undefined;
  const retry = saveNativePng(path, () => true);
  for (let i = 0; i < 8 && getDelivery()?.filePath !== path; i++) await new Promise<void>(resolveTick => setImmediate(resolveTick));
  const delivery = getDelivery(); assert.ok(delivery); assert.equal(delivery.filePath, path);
  delivery.options.success?.(); await retry;
  assert.equal(bridge.reads.filter(read => read.path === source.path).length, sourceReads);
  assert.deepEqual(readFileSync(source.path), sample.bytes);
});

test('leaving during PNG validation stops album saving and releases the pending derivative cleanup', async () => {
  const sample = rgb8(1, false), source = bridge.file('album-cancel-validation.psd', sample.bytes);
  const prepared = await preparePreview(source, new FakeCanvas().native());
  const path = await prepared.prepareNative!(() => true, () => {});
  const manager = wx.getFileSystemManager() as any, stat = manager.stat;
  let validation: any, current = true;
  manager.stat = (options: any) => { validation = options; };
  const pending = saveNativePng(path, () => current), rejected = assert.rejects(pending, { code: 'CANCELLED' });
  current = false; await cleanupPreview(); assert.ok(existsSync(path));
  manager.stat = stat; stat(validation); await rejected;
  assert.equal(bridge.delivery, undefined); assert.equal(existsSync(path), false); assert.ok(existsSync(source.path));
});

test('missing streaming APIs and RGB8 alpha retain preview but omit original-export entry', async () => {
  const api = wx.getFileSystemManager() as unknown as Record<string, unknown>;
  const open = api.open; api.open = undefined;
  const sample = rgb8(1, false), source = bridge.file('api.psd', sample.bytes);
  // The bridge returns a stable native manager, matching FileSystemManager usage.
  const getManager = wx.getFileSystemManager;
  wx.getFileSystemManager = (() => api) as unknown as typeof wx.getFileSystemManager;
  try { const prepared = await preparePreview(source, new FakeCanvas().native()); assert.ok(prepared.previewPath); assert.equal(prepared.prepareNative, undefined); }
  finally { api.open = open; wx.getFileSystemManager = getManager; }
  const alpha = bridge.file('alpha.psd', readFileSync('tests/fixtures/photoshop/generated-alpha.psd'));
  const prepared = await preparePreview(alpha, new FakeCanvas().native());
  assert.ok(prepared.previewPath); assert.equal(prepared.prepareNative, undefined);
});
