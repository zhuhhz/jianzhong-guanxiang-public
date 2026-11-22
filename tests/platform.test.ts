import assert from 'node:assert/strict';
import { accessSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { brotliDecompressSync } from 'node:zlib';
import { chooseDesignFile, cleanupPreview, preparePreview, openAiDocument, sharePdfDocument, savePng, previewRawJpeg, saveRawJpeg, type ChosenFile } from '../src/platform/wechat';
import { LIMITS } from '../src/core/shared';
import { parseSvg } from '../src/core/svg';
import { largePhotoshopPaths, photoshopPrefix, resource, thumbnailColor, thumbnailData,
  thumbnailJpeg, writeLargePhotoshop } from './helpers/photoshop-thumbnail';
import { raw16 } from './helpers/photoshop-16bit';
import { aiContainer } from './helpers/ai-container';
import { readPhotoshopHeader } from '../src/core/photoshop';
import { readPhotoshopIcc } from '../src/core/icc';
import { tiffImage } from './helpers/tiff';
import { matrixIcc } from './helpers/icc';
import { inspectIcc } from '../src/core/icc';
import { cameraRaw } from './helpers/camera-raw';
import { rawPreviewJpeg } from '../src/core/camera-raw';
import { checkJpegHeader } from '../src/core/photoshop-thumbnail';

const { PNG } = createRequire(__filename)('pngjs');
const fixtures = resolve('tests/fixtures');
const testResults = resolve('test-results');

test('import sources keep all RAW file extensions and request chat images without an extension filter', async () => {
  const source = bridge.file('selected.psd', new Uint8Array([1]));
  const requests: Record<string, any>[] = [];
  (wx as any).chooseMessageFile = (options: any) => { requests.push(options); options.success({ tempFiles: [{ ...source, type: 'image' }] }); };
  await chooseDesignFile(); await chooseDesignFile('chat-image'); await chooseDesignFile('chat-all');
  assert.equal(requests[0].type, 'file'); assert.ok(requests[0].extension.includes('psd'));
  for (const extension of ['arw', 'cr2', 'cr3', 'nef', 'raf', 'dng']) assert.ok(requests[0].extension.includes(extension));
  assert.equal(requests[1].type, 'image'); assert.equal('extension' in requests[1], false);
  assert.equal(requests[2].type, 'all'); assert.equal('extension' in requests[2], false);
});

test('album directly requests original images from album only and rejects an absent native API', async () => {
  let media: any;
  (wx as any).chooseMedia = (options: any) => { media = options; options.success({ type: 'image', tempFiles: [{ tempFilePath: '/local/returned.jpg', size: 100 }] }); };
  const result = await chooseDesignFile('album'); assert.equal(result.source, 'album');
  assert.deepEqual(media.sizeType, ['original']); assert.deepEqual(media.sourceType, ['album']);
  assert.deepEqual(media.mediaType, ['image']); assert.equal(media.count, 1);
  (wx as any).chooseMedia = undefined;
  await assert.rejects(chooseDesignFile('album'), { code: 'API_UNAVAILABLE' });
});

test('album cancellation and privacy denial remain distinct and never read a photo', async () => {
  (wx as any).chooseMedia = (options: any) => options.fail({ errMsg: 'chooseMedia:fail cancel' });
  await assert.rejects(chooseDesignFile('album'), /已取消选择/);
  (wx as any).chooseMedia = (options: any) => options.fail({ errMsg: 'privacy cancel', errno: 112 });
  await assert.rejects(chooseDesignFile('album'), { code: 'PRIVACY_CONFIG' });
  assert.equal(bridge.reads.length, 0);
});

test('incomplete asynchronous picker results reject instead of throwing inside a native callback', async () => {
  (wx as any).chooseMessageFile = (options: any) => queueMicrotask(() => options.success({}));
  await assert.rejects(chooseDesignFile(), { code: 'NO_FILE_EMPTY_LIST',
    pickerDiagnostic: 'source=chat-file;list=missing;count=unknown;path=missing;tempFilePath=missing' });
  (wx as any).chooseMedia = (options: any) => queueMicrotask(() => options.success({ type: 'image' }));
  await assert.rejects(chooseDesignFile('album'), { code: 'NO_FILE_EMPTY_LIST',
    pickerDiagnostic: 'source=album;list=missing;count=unknown;path=missing;tempFilePath=missing' });
  assert.equal(bridge.reads.length, 0);
});

test('picker diagnostics distinguish empty lists from missing paths without including private callback values', async () => {
  const privateValues = { name: 'private-name.ARW', GPS: 'private-gps', EXIF: 'private-exif', errMsg: 'private-native-message' };
  for (const source of ['chat-file', 'chat-image', 'chat-all', 'album'] as const) {
    for (const testCase of [
      { files: [], code: 'NO_FILE_EMPTY_LIST', shape: 'list=array;count=0;path=missing;tempFilePath=missing' },
      { files: [{ ...privateValues }], code: 'NO_FILE_PATH_MISSING', shape: 'list=array;count=1;path=missing;tempFilePath=missing' },
      { files: [{ ...privateValues, path: '', tempFilePath: '' }], code: 'NO_FILE_PATH_MISSING', shape: 'list=array;count=1;path=empty;tempFilePath=empty' },
      { files: [{ path: null, tempFilePath: 123 }, { path: '/local/second-private.ARW' }], code: 'NO_FILE_PATH_MISSING', shape: 'list=array;count=many;path=other;tempFilePath=other' },
      { files: { 0: privateValues, length: 1 }, code: 'NO_FILE_PATH_MISSING', shape: 'list=other;count=unknown;path=missing;tempFilePath=missing' },
    ]) {
      const picker = (options: any) => options.success({ ...privateValues, tempFiles: testCase.files });
      (wx as any).chooseMessageFile = picker; (wx as any).chooseMedia = picker;
      await assert.rejects(chooseDesignFile(source), (error: unknown) => {
        const actual = error as Error & { code: string; pickerDiagnostic: string };
        assert.equal(actual.code, testCase.code);
        assert.equal(actual.pickerDiagnostic, `source=${source};${testCase.shape}`);
        assert.doesNotMatch(`${actual.message} ${JSON.stringify(actual)}`, /private|GPS|EXIF|\/local\//);
        return true;
      });
    }
  }
  assert.equal(bridge.reads.length, 0);
});

test('picker aliases are reported as structure but never guessed as a usable file path', async () => {
  (wx as any).chooseMessageFile = (options: any) => options.success({ tempFiles: [{ tempFilePath: '/local/private-photo.jpg', name: 'private.ARW' }] });
  await assert.rejects(chooseDesignFile('chat-all'), { code: 'NO_FILE_PATH_MISSING',
    pickerDiagnostic: 'source=chat-all;list=array;count=1;path=missing;tempFilePath=string' });
  (wx as any).chooseMedia = (options: any) => options.success({ tempFiles: [{ path: '/local/private-photo.jpg', name: 'private.ARW' }] });
  await assert.rejects(chooseDesignFile('album'), { code: 'NO_FILE_PATH_MISSING',
    pickerDiagnostic: 'source=album;list=array;count=1;path=string;tempFilePath=missing' });
  assert.equal(bridge.reads.length, 0);
});

test('valid picker paths retain normal and cross-realm or array-like callback behavior', async () => {
  const entry = { path: '/local/selected.ARW', name: 'selected.ARW', size: 123, type: 'file' };
  for (const files of [runInNewContext('([{path:"/local/selected.ARW",name:"selected.ARW",size:123,type:"file"}])'), { 0: entry, length: 1 }]) {
    (wx as any).chooseMessageFile = (options: any) => options.success({ tempFiles: files });
    const chosen = await chooseDesignFile('chat-all');
    assert.equal(chosen.path, entry.path); assert.equal(chosen.name, entry.name); assert.equal(chosen.size, entry.size);
  }
  (wx as any).chooseMedia = (options: any) => options.success({ tempFiles: { 0: { tempFilePath: entry.path, size: 123 }, length: 1 }, type: 'image' });
  const album = await chooseDesignFile('album');
  assert.equal(album.path, entry.path); assert.equal(album.source, 'album');
  assert.equal(bridge.reads.length, 0);
});

for (const format of ['JPEG', 'PNG'] as const) test(`returned ${format} bytes cannot enable RAW even under an ARW filename`, async () => {
  const bytes = format === 'JPEG' ? thumbnailJpeg : PNG.sync.write({ width: 2, height: 3, data: Buffer.alloc(24, 255) });
  const source = { ...bridge.file('returned.ARW', bytes), source: 'chat-image' as const, reportedType: 'RAW' };
  const width = format === 'JPEG' ? 64 : 2, height = format === 'JPEG' ? 48 : 3;
  let saved = '';
  (wx as any).getImageInfo = (options: any) => options.success({ width, height, orientation: 'up', type: format.toLowerCase(), path: source.path });
  (wx as any).saveImageToPhotosAlbum = (options: any) => { saved = options.filePath; options.success({}); };
  const canvas = new NodeCanvas(), result = await preparePreview(source, canvas.native());
  assert.equal(result.info.format, format); assert.equal(result.originalImage, format);
  assert.deepEqual([result.info.width, result.info.height], [width, height]);
  assert.equal(result.previewPath, source.path); assert.equal(result.exportPath, source.path);
  assert.equal(result.prepareNative, undefined); assert.equal(result.detail, undefined); assert.equal(result.rawAutoPath, undefined);
  assert.ok(result.info.warnings.some(w => /原始 RAW 不可用/.test(w)));
  await savePng(result.exportPath!, '图片'); assert.equal(saved, source.path);
  await cleanupPreview(); assert.deepEqual(readFileSync(source.path), bytes);
  assert.equal(bridge.writes.length, 0); assert.equal(bridge.exports.length, 0); assert.equal(canvas.createdImages, 0);
  assert.ok(bridge.reads.every(r => r.length <= 4096));
});

test('a RAW returned without its extension is identified by CFA structure and reuses its parsed directories', async () => {
  const source = { ...bridge.file('wx-image', cameraRaw()), source: 'album' as const };
  const result = await preparePreview(source, new NodeCanvas().native());
  assert.equal(result.info.format, 'RAW'); assert.equal(result.originalImage, undefined);
  assert.ok(result.info.warnings.some(w => /TIFF\/CFA RAW/.test(w)));
  assert.equal(bridge.reads.filter(r => r.position === 10).length, 1);
});

test('ordinary TIFF image messages retain the existing first-page route when RAW probing is inapplicable', async () => {
  const source = { ...bridge.file('wx-image', tiffImage({ morePages: true })), source: 'chat-image' as const };
  const result = await preparePreview(source, new NodeCanvas().native());
  assert.equal(result.info.format, 'TIFF'); assert.equal(result.originalImage, undefined);
});

test('HEIC and malformed CR3/RAF stop without pretending they were decoded', async () => {
  for (const [brand, code] of [['heic', 'UNSUPPORTED_IMAGE'], ['crx ', 'RAW_PREVIEW_UNAVAILABLE']] as const) {
    const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write(brand, 8);
    const source = bridge.file('selected-image', bytes);
    await assert.rejects(preparePreview(source, new NodeCanvas().native()), { code });
  }
  const raf = bridge.file('selected-image.raf', Buffer.from('FUJIFILMCCD-RAW 0201'));
  await assert.rejects(preparePreview(raf, new NodeCanvas().native()), { code: 'INVALID_RAW' });
});

test('all-types chat selection rejects a video header even when its returned name is a design file', async () => {
  const video = Buffer.alloc(24); video.writeUInt32BE(24); video.write('ftypisom', 4);
  const source = bridge.file('not-a-design.psd', video), canvas = new NodeCanvas();
  (wx as any).chooseMessageFile = (options: any) => {
    assert.equal(options.type, 'all'); assert.equal('extension' in options, false);
    options.success({ tempFiles: [{ ...source, type: 'video' }] });
  };
  const selected = await chooseDesignFile('chat-all');
  await assert.rejects(preparePreview(selected, canvas.native()), { code: 'UNSUPPORTED_FORMAT' });
  assert.equal(canvas.createdImages, 0);
  assert.ok(bridge.reads.filter(read => read.path === source.path).every(read => read.length <= 4096));
});

test('camera JPEG viewing and saving use full stored bytes and retain them through in-flight cleanup', async () => {
  const source = bridge.file('camera.nef', cameraRaw()), result = await preparePreview(source, new NodeCanvas().native());
  assert.ok(result.rawJpeg); const path = result.rawJpeg.path, before = readFileSync(path);
  let viewed: any;
  (wx as any).previewImage = (options: any) => { viewed = options; options.success({}); };
  await previewRawJpeg(path, () => true); assert.deepEqual(viewed.urls, [path]); assert.equal(viewed.current, path);
  let finish!: () => void, saved = '';
  (wx as any).saveImageToPhotosAlbum = (options: any) => { saved = options.filePath; finish = () => options.success({}); };
  const task = saveRawJpeg(path, () => true);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await cleanupPreview(); assert.equal(existsSync(path), true); assert.deepEqual(readFileSync(path), before);
  finish(); await task; assert.equal(saved, path); assert.equal(existsSync(path), false);
  assert.ok(existsSync(source.path)); assert.equal(bridge.exports.length, 0);
});

test('camera JPEG permission/storage failures allow retry, and stale or unowned paths cannot save', async () => {
  const source = bridge.file('camera.dng', cameraRaw()), result = await preparePreview(source, new NodeCanvas().native()), path = result.rawJpeg!.path;
  for (const [errMsg, code] of [['auth deny', 'ALBUM_PERMISSION'], ['ENOSPC storage quota', 'STORAGE_FULL']] as const) {
    (wx as any).saveImageToPhotosAlbum = (options: any) => options.fail({ errMsg });
    await assert.rejects(saveRawJpeg(path, () => true), { code }); assert.ok(existsSync(path));
  }
  let count = 0;
  (wx as any).saveImageToPhotosAlbum = (options: any) => { count++; options.success({}); };
  await assert.rejects(saveRawJpeg(path, () => false), { code: 'CANCELLED' });
  await assert.rejects(saveRawJpeg(source.path, () => true), { code: 'INVALID_JPEG_PATH' });
  await saveRawJpeg(path, () => true); assert.equal(count, 1);
  (wx as any).saveImageToPhotosAlbum = (options: any) => options.fail({ errMsg: 'saveImageToPhotosAlbum:fail cancel' });
  await assert.rejects(saveRawJpeg(path, () => true), { code: 'CANCELLED' }); assert.ok(existsSync(path));
});

test('CR3 above 32 MiB bypasses only the RAW front gate and does not load mdat sensor bytes', async () => {
  const ftyp = Buffer.alloc(20); ftyp.writeUInt32BE(20); ftyp.write('ftypcrx ', 4);
  const prvw = Buffer.alloc(8); prvw.writeUInt32BE(8 + thumbnailJpeg.length); prvw.write('PRVW', 4);
  const mdat = Buffer.alloc(72); mdat.write('mdat', 4);
  const source = bridge.file('large.cr3', Buffer.concat([ftyp, prvw, thumbnailJpeg, mdat]));
  truncateSync(source.path, 40 * 1024 * 1024);
  const result = await preparePreview(source, new NodeCanvas().native());
  assert.equal(result.info.format, 'RAW'); assert.ok(result.rawJpeg);
  const reads = bridge.reads.filter(r => r.path === source.path);
  assert.ok(reads.every(r => r.length <= 65536)); assert.ok(reads.reduce((a, r) => a + r.length, 0) < 4096);
});

test('optional six-format real RAWs preserve camera JPEG scans through the local native adapter', {
  skip: !process.env.RAW_M1_DIR,
}, async () => {
  const root = process.env.RAW_M1_DIR!;
  const names = readdirSync(root).filter(name => /\.(arw|cr2|cr3|nef|raf|dng)$/i.test(name));
  assert.equal(new Set(names.map(name => name.split('.').pop()!.toLowerCase())).size, 6);
  for (const name of names) {
    const path = join(root, name), before = statSync(path);
    const result = await preparePreview({ path, name, size: before.size }, new NodeCanvas().native());
    assert.equal(result.info.format, 'RAW'); assert.ok(result.rawJpeg);
    const bytes = readFileSync(result.rawJpeg.path); let delivered = '';
    (wx as any).previewImage = (options: any) => { assert.equal(options.current, result.rawJpeg!.path); options.success({}); };
    (wx as any).saveImageToPhotosAlbum = (options: any) => { delivered = options.filePath; assert.deepEqual(readFileSync(delivered), bytes); options.success({}); };
    const beforeDelivery = bridge.reads.length, beforeExports = bridge.exports.length;
    await previewRawJpeg(result.rawJpeg.path, () => true); await saveRawJpeg(result.rawJpeg.path, () => true);
    assert.equal(bridge.reads.length, beforeDelivery); assert.equal(bridge.exports.length, beforeExports);
    assert.equal(delivered, result.rawJpeg.path);
    assert.ok(bridge.reads.filter(r => r.path === path).every(r => r.length <= 65536));
    const after = statSync(path); assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs);
  }
});

test('ordinary images reject native type mismatch, damaged data and size overflow without full reads', async () => {
  const source = bridge.file('returned.arw', thumbnailJpeg);
  (wx as any).getImageInfo = (options: any) => options.success({ width: 64, height: 48, type: 'png' });
  await assert.rejects(preparePreview(source, new NodeCanvas().native()), { code: 'INVALID_IMAGE' });
  (wx as any).getImageInfo = (options: any) => options.fail({ errMsg: '/private/path decode fail' });
  await assert.rejects(preparePreview(source, new NodeCanvas().native()), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /JPEG.*RAW 不可用/); assert.doesNotMatch(error.message, /private\/path/); return true;
  });
  bridge.stats.set(source.path, 33 * 1024 * 1024);
  await assert.rejects(preparePreview(source, new NodeCanvas().native()), { code: 'FILE_TOO_LARGE', message: /JPEG.*RAW 不可用/ });
  assert.ok(bridge.reads.every(r => r.length <= 4096));
});
type Kind = 'readdir' | 'write' | 'png' | 'read';
type Callbacks = { success?: (value?: any) => void; fail?: (value: { errMsg: string; errno?: number }) => void; complete?: () => void };
type NodeImageData = { width: number; height: number; data: Uint8ClampedArray };

// This is a Node filesystem/Canvas bridge contract test, never native Canvas/DevTools proof.
class NodeCanvas {
  private canvasWidth = 1;
  private canvasHeight = 1;
  sizes: number[] = [];
  get width() { return this.canvasWidth; }
  set width(value: number) { this.sizes.push(value); this.canvasWidth = value; }
  get height() { return this.canvasHeight; }
  set height(value: number) { this.sizes.push(value); this.canvasHeight = value; }
  pixels?: NodeImageData;
  sources: string[] = [];
  createdImages = 0;
  puts: NodeImageData[] = [];
  getContext() {
    return {
      createImageData: (width: number, height: number): NodeImageData => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (image: NodeImageData) => { this.pixels = { ...image, data: image.data.slice() }; this.puts.push(this.pixels); },
      drawImage: () => { throw new Error('This bridge does not rasterize SVG.'); },
    };
  }
  createImage() {
    this.createdImages++;
    const canvas = this;
    return { onload: () => {}, onerror: () => {}, set src(value: string) {
      canvas.sources.push(value);
      queueMicrotask(() => this.onerror());
    } };
  }
  native(): WechatMiniprogram.Canvas { return this as unknown as WechatMiniprogram.Canvas; }
}

class NodeBridge {
  root: string;
  userData: string;
  stats = new Map<string, number>();
  sdkVersion = '3.15.0';
  pickerFailure?: { errMsg: string; errno: number };
  pickerCalls = 0;
  binaryRead = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;
  reads: { path: string; length: number; position?: number; encoding?: string }[] = [];
  writes: string[] = [];
  copies: { source: string; destination: string }[] = [];
  unlinks: string[] = [];
  exports: { path: string; width: number; height: number; pixels: Uint8Array }[] = [];
  gates: { kind: Kind; match: (path: string) => boolean; armed: boolean; pending?: () => void; notify: () => void }[] = [];
  constructor() {
    mkdirSync(testResults, { recursive: true });
    this.root = mkdtempSync(join(testResults, 'platform-'));
    this.userData = join(this.root, 'userdata');
    mkdirSync(this.userData, { recursive: true });
  }
  gate(kind: Kind, match: (path: string) => boolean = () => true) {
    let notify!: () => void;
    const started = new Promise<void>(resolveStarted => { notify = resolveStarted; });
    const state = { kind, match, armed: true, pending: undefined as (() => void) | undefined, notify };
    this.gates.push(state);
    return { started, release: () => { const pending = state.pending; state.pending = undefined; if (pending) queueMicrotask(pending); } };
  }
  dispatch(kind: Kind | undefined, path: string, callback: () => void) {
    const gate = this.gates.find(entry => entry.armed && entry.kind === kind && entry.match(path));
    if (gate) { gate.armed = false; gate.pending = callback; gate.notify(); }
    else queueMicrotask(callback);
  }
  releaseAll() { for (const gate of this.gates) { if (gate.pending) queueMicrotask(gate.pending); gate.pending = undefined; } }
  file(name: string, data: string | Uint8Array): ChosenFile {
    const path = join(this.root, name);
    writeFileSync(path, data);
    return { path, name, size: statSync(path).size };
  }
  fixture(relative: string): ChosenFile {
    const path = join(fixtures, relative);
    return { path, name: basename(path), size: statSync(path).size };
  }
  wx() {
    const execute = (options: Callbacks, path: string, action: () => unknown, kind?: Kind) => {
      try {
        const value = action();
        this.dispatch(kind, path, () => { options.success?.(value); options.complete?.(); });
      } catch (error) {
        queueMicrotask(() => { options.fail?.({ errMsg: String(error) }); options.complete?.(); });
      }
    };
    const filesystem = {
      accessSync,
      stat: (options: Callbacks & { path: string }) => execute(options, options.path, () => {
        const stats = statSync(options.path);
        return { stats: { size: this.stats.get(options.path) ?? stats.size, isFile: () => stats.isFile() } };
      }),
      readFile: (options: Callbacks & { filePath: string; position: number; length: number; encoding?: string }) => execute(options, options.filePath, () => {
        this.reads.push({ path: options.filePath, length: options.length,
          ...(options.position ? { position: options.position } : {}), encoding: options.encoding });
        const descriptor = openSync(options.filePath, 'r');
        let bytes = Buffer.alloc(options.length);
        try { bytes = bytes.subarray(0, readSync(descriptor, bytes, 0, options.length, options.position)); }
        finally { closeSync(descriptor); }
        return { data: options.encoding ? bytes.toString('utf8') : this.binaryRead(bytes) };
      }, 'read'),
      mkdir: (options: Callbacks & { dirPath: string }) => execute(options, options.dirPath, () => mkdirSync(options.dirPath, { recursive: true })),
      writeFile: (options: Callbacks & { filePath: string; data: string | ArrayBuffer }) => execute(options, options.filePath, () => {
        this.writes.push(options.filePath);
        writeFileSync(options.filePath, typeof options.data === 'string' ? options.data : Buffer.from(options.data));
      }, 'write'),
      copyFile: (options: Callbacks & { srcPath: string; destPath: string }) => execute(options, options.destPath, () => {
        this.copies.push({ source: options.srcPath, destination: options.destPath });
        this.writes.push(options.destPath); // All owned writes, including native copies.
        copyFileSync(options.srcPath, options.destPath);
      }, 'write'),
      readdir: (options: Callbacks & { dirPath: string }) => execute(options, options.dirPath, () => ({ files: readdirSync(options.dirPath) }), 'readdir'),
      unlink: (options: Callbacks & { filePath: string }) => execute(options, options.filePath, () => { this.unlinks.push(options.filePath); unlinkSync(options.filePath); }),
    };
    return {
      env: { USER_DATA_PATH: this.userData },
      canIUse: () => true,
      getAppBaseInfo: () => ({ SDKVersion: this.sdkVersion }),
      getSystemInfoSync: () => ({ SDKVersion: this.sdkVersion }),
      chooseMessageFile: (options: Callbacks) => {
        this.pickerCalls++;
        queueMicrotask(() => this.pickerFailure ? options.fail?.(this.pickerFailure)
          : options.success?.({ tempFiles: [this.fixture('photoshop/generated-raw.psd')] }));
      },
      getFileSystemManager: () => filesystem,
      arrayBufferToBase64: (buffer: ArrayBuffer) => Buffer.from(buffer).toString('base64'),
      canvasToTempFilePath: (options: Callbacks & { canvas: NodeCanvas; width?: number; height?: number; destWidth: number; destHeight: number }) => {
        assert.equal(options.width ?? options.canvas.width, options.destWidth);
        assert.equal(options.height ?? options.canvas.height, options.destHeight);
        assert.equal(options.destWidth, options.canvas.width);
        assert.equal(options.destHeight, options.canvas.height);
        const image = options.canvas.pixels;
        assert.ok(image, 'PNG export must receive actual putImageData pixels');
        assert.equal(image.width, options.destWidth);
        assert.equal(image.height, options.destHeight);
        const path = join(this.root, `native-${this.exports.length}.png`);
        this.exports.push({ path, width: options.destWidth, height: options.destHeight, pixels: Uint8Array.from(image.data) });
        writeFileSync(path, PNG.sync.write({ width: options.destWidth, height: options.destHeight, data: Buffer.from(image.data) }));
        this.dispatch('png', path, () => options.success?.({ tempFilePath: path }));
      },
    };
  }
}

let bridge: NodeBridge;
function autoCanvas(orientation = 1) {
  const canvas = new NodeCanvas(), transforms: number[][] = [];
  let imageReady!: () => void;
  const started = new Promise<void>(resolve => { imageReady = resolve; });
  let finish: (() => void) | undefined;
  (canvas as any).getContext = () => ({
    setTransform: (...m: number[]) => transforms.push(m),
    drawImage: () => {},
    getImageData: () => {
      const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      for (let i = 0; i < data.length; i += 4) { const v = 20 + (i / 4 % 80); data.set([v, v, v, 255], i); }
      return { width: canvas.width, height: canvas.height, data };
    },
    putImageData: (image: NodeImageData) => { canvas.pixels = image; },
  });
  (canvas as any).createImage = () => {
    const image = { onload: () => {}, onerror: () => {}, set src(_path: string) { finish = () => image.onload(); imageReady(); } };
    return image;
  };
  return { canvas, transforms, started, finish: () => finish!(), orientation };
}
test('RAW Auto bridge displays a bounded oriented PNG, retains the original JPEG and releases work files', async () => {
  const source = cameraRaw(true, 8), file = bridge.file('portrait.ARW', source), mock = autoCanvas(8);
  const task = preparePreview(file, mock.canvas.native());
  await mock.started; mock.finish();
  const result = await task;
  assert.equal(result.previewPath, result.rawAutoPath); assert.ok(result.rawOriginalPath);
  assert.deepEqual(readFileSync(result.rawOriginalPath!), Buffer.from(rawPreviewJpeg(thumbnailJpeg, 8)));
  const decoded = PNG.sync.read(readFileSync(result.rawAutoPath!));
  assert.deepEqual([decoded.width, decoded.height], [48, 64]);
  assert.deepEqual(mock.transforms[0], [0, -1, 1, 0, 0, 64]);
  assert.ok(decoded.data[0] > 20); assert.equal(result.exportPath, result.rawAutoPath); assert.equal(result.prepareNative, undefined);
  assert.equal(mock.canvas.width, 1); assert.equal(mock.canvas.height, 1);
  assert.equal(bridge.writes.filter(p => p.endsWith('.jpg') && existsSync(p)).length, 1);
  let finish!: () => void;
  (wx as any).saveImageToPhotosAlbum = (options: Callbacks) => { finish = () => options.success?.(); };
  const saving = savePng(result.rawAutoPath!, 'PNG', true, () => true);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await cleanupPreview(); assert.equal(existsSync(result.rawAutoPath!), true); assert.equal(existsSync(result.rawOriginalPath!), false);
  finish(); await saving; assert.equal(existsSync(result.rawAutoPath!), false);
  assert.deepEqual(readFileSync(file.path), source);
});
test('RAW Auto bridge cancels during JPEG load without publishing stale PNG or touching originals', async () => {
  const file = bridge.file('camera.ARW', cameraRaw()), mock = autoCanvas();
  const task = preparePreview(file, mock.canvas.native());
  const stopped = assert.rejects(task, { code: 'CANCELLED' });
  await mock.started; await cleanupPreview(); mock.finish(); await stopped;
  assert.equal(bridge.exports.length, 0); assert.ok(existsSync(file.path));
  assert.equal(mock.canvas.width, 1);
});
test('Node bridge: RAW embedded JPEG opens without Canvas, cannot export sensor PNG, and cleans its own copy', async () => {
  const source = cameraRaw();
  const file = bridge.file('camera.ARW', source), canvas = new NodeCanvas();
  const result = await preparePreview(file, canvas.native());
  assert.equal(result.info.format, 'RAW');
  assert.deepEqual([result.info.width, result.info.height], [64, 48]);
  assert.deepEqual(readFileSync(result.previewPath!), Buffer.from(rawPreviewJpeg(thumbnailJpeg, 1)));
  assert.equal(result.exportPath, undefined); assert.equal(result.prepareNative, undefined);
  assert.equal(result.info.exportSupported, false); assert.equal(canvas.createdImages, 0);
  assert.equal(bridge.reads.every(read => read.length <= 64 * 1024), true);
  await cleanupPreview(); assert.equal(existsSync(result.previewPath!), false);
  assert.deepEqual(readFileSync(file.path), source);
});
test('Node bridge: optional real large ARW passes the range adapter without full-file reads', {
  skip: !process.env.RAW_REAL_DIR,
}, async () => {
  const path = join(process.env.RAW_REAL_DIR!, '_ZYJ0230.ARW'), before = statSync(path);
  const result = await preparePreview({ path, name: basename(path), size: before.size }, new NodeCanvas().native());
  assert.equal(result.info.format, 'RAW');
  assert.deepEqual([result.info.width, result.info.height], [1080, 1616]);
  const reads = bridge.reads.filter(item => item.path === path);
  assert.ok(reads.every(item => item.length <= 64 * 1024));
  assert.ok(reads.reduce((n, item) => n + item.length, 0) < before.size / 10);
  assert.equal(result.prepareNative, undefined);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  await cleanupPreview(); assert.equal(existsSync(result.previewPath!), false); assert.ok(existsSync(path));
});
beforeEach(() => {
  bridge = new NodeBridge();
  (globalThis as unknown as { wx: typeof wx }).wx = bridge.wx() as unknown as typeof wx;
});
afterEach(async () => {
  bridge.releaseAll();
  await cleanupPreview();
  assert.ok(resolve(bridge.root).startsWith(`${testResults}${sep}`));
  rmSync(bridge.root, { recursive: true, force: true });
});

test('Node bridge: disk stat overrides picker metadata and real PSD pixels reach Canvas and PNG', async () => {
  const source = bridge.fixture('photoshop/generated-raw.psd');
  const original = readFileSync(source.path);
  const canvas = new NodeCanvas();
  const result = await preparePreview({ ...source, size: 1 }, canvas.native());
  assert.equal(result.info.filesize, original.length);
  assert.equal(result.info.exportSupported, true);
  const expected = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    21, 21, 21, 255, 21, 21, 21, 255, 21, 21, 21, 255];
  assert.deepEqual(Array.from(canvas.puts[0].data), expected);
  const png = PNG.sync.read(readFileSync(result.exportPath!));
  assert.deepEqual([png.width, png.height], [3, 2]);
  assert.deepEqual(Array.from(png.data), expected);
  assert.deepEqual(readFileSync(source.path), original);
  assert.deepEqual([canvas.width, canvas.height], [1, 1]);
});

test('chat material opening uses the actual PSD bytes and rejects a JPEG named PSD', async () => {
  const source = bridge.fixture('photoshop/generated-raw.psd');
  const result = await preparePreview({ ...source, source: 'chat-open', size: 0 }, new NodeCanvas().native());
  assert.equal(result.info.format, 'PSD');
  assert.equal(result.info.filesize, statSync(source.path).size);
  assert.deepEqual([result.info.width, result.info.height], [3, 2]);
  const mislabeled = bridge.file('image.psd', thumbnailJpeg);
  await assert.rejects(preparePreview({ ...mislabeled, source: 'chat-open' }, new NodeCanvas().native()), { code: 'INVALID_PHOTOSHOP' });
});

for (const compression of [1, 5, 8]) {
  test(`Node bridge: TIFF compression ${compression} uses existing Canvas preview and preserves the source`, async () => {
    const original = tiffImage({ compression }), source = bridge.file('design.tiff', original);
    const canvas = new NodeCanvas();
    const result = await preparePreview(source, canvas.native());
    assert.equal(result.info.format, 'TIFF');
    assert.deepEqual([result.info.width, result.info.height], [2, 1]);
    assert.equal(result.info.exportSupported, true);
    assert.equal(result.prepareNative, undefined);
    assert.deepEqual([...canvas.puts[0].data], [255, 0, 0, 255, 0, 255, 0, 255]);
    const png = PNG.sync.read(readFileSync(result.previewPath!));
    assert.deepEqual([...png.data], [...canvas.puts[0].data]);
    assert.deepEqual(readFileSync(source.path), Buffer.from(original));
    assert.deepEqual([canvas.width, canvas.height], [1, 1]);
    if (compression === 1) assert.ok(bridge.reads.every(read => read.position !== 0 || read.length !== original.length));
  });
}

test('Node bridge: real CR3 returned as video by the all-types picker is identified by bytes and keeps the 6720px JPEG', {
  skip: !process.env.RAW_M1_DIR,
}, async () => {
  const path = join(process.env.RAW_M1_DIR!, 'Canon-EOS-R.CR3'), before = statSync(path);
  (wx as any).chooseMessageFile = (options: any) => {
    assert.equal(options.type, 'all'); assert.equal('extension' in options, false);
    options.success({ tempFiles: [{ path, name: 'wx-video.mp4', type: 'video', size: before.size }] });
  };
  const selected = await chooseDesignFile('chat-all');
  assert.equal(selected.reportedType, 'video'); assert.equal(selected.source, 'chat-all');
  const result = await preparePreview(selected, new NodeCanvas().native());
  assert.equal(result.info.format, 'RAW');
  assert.deepEqual([result.rawJpeg?.width, result.rawJpeg?.height], [6720, 4480]);
  assert.match(result.info.warnings[0], /从微信聊天选择文件/);
  assert.equal(result.detail, undefined); assert.equal(result.prepareNative, undefined);
  assert.equal(statSync(path).size, before.size); assert.equal(statSync(path).mtimeMs, before.mtimeMs);
});

test('Node bridge: built CR2 page saves the 160px overview PNG and real 6720px JPEG separately', {
  skip: !process.env.RAW_M1_DIR,
}, async () => {
  const path = join(process.env.RAW_M1_DIR!, 'Canon-5D-Mark-IV.CR2'), before = statSync(path), mock = autoCanvas(), { canvas } = mock;
  const source = { path, name: basename(path), size: before.size };
  let definition: Record<string, any> = {};
  const saved: string[] = [];
  const wx = { ...bridge.wx(), nextTick: (done: () => void) => done(), showToast: () => {},
    saveImageToPhotosAlbum: (options: Callbacks & { filePath: string }) => { saved.push(options.filePath); options.success?.(); },
    chooseMessageFile: (options: { success: (result: unknown) => void }) => options.success({ tempFiles: [source] }) };
  runInNewContext(readFileSync('dist/pages/index/index.js', 'utf8'), {
    Page: (value: Record<string, any>) => { definition = value; }, wx, console, setTimeout, clearTimeout,
  });
  const page: Record<string, any> = { ...definition, data: { ...definition.data }, getCanvas: async () => canvas.native(),
    setData(update: Record<string, unknown>, callback?: () => void) { Object.assign(this.data, update); callback?.(); } };
  const choosing = page.chooseChatFile(); await mock.started; mock.finish(); await choosing;
  assert.equal(page.data.errorMessage, ''); assert.equal(page.data.rawJpegInline, true);
  const jpeg = readFileSync(page.data.previewPath);
  assert.deepEqual(checkJpegHeader(jpeg), { width: 6720, height: 4480 });
  assert.equal(page.data.previewPath, page.rawJpegPath); assert.equal(page.data.rawAutoEnabled, false);
  assert.equal(page.data.canRawPixels, false); assert.equal(page.data.canNative, false);
  assert.equal(page.data.previewAtOriginalSize, false);
  const reads = bridge.reads.length, exports = bridge.exports.length;
  await page.saveImage(); page.toggleRawAuto(); await page.saveImage(); await page.saveOriginalImage();
  assert.notEqual(saved[0], saved[1]);
  for (const png of saved.slice(0, 2).map(file => PNG.sync.read(readFileSync(file)))) assert.deepEqual([png.width, png.height], [160, 120]);
  assert.equal(saved[2], page.rawJpegPath); assert.deepEqual(readFileSync(saved[2]), jpeg);
  assert.equal(bridge.reads.length, reads); assert.equal(bridge.exports.length, exports);
  assert.ok(canvas.sizes.every(n => n <= 160));
  if (process.env.RAW_SAVE_METRICS) {
    const input = bridge.reads.filter(read => read.path === path);
    console.log(`CR2 source import: ${input.length} reads, ${input.reduce((total, read) => total + read.length, 0)} bytes, max ${Math.max(...input.map(read => read.length))}; mode switches and three saves: 0 source reads`);
  }
  page.backToHome(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(statSync(path).size, before.size); assert.equal(statSync(path).mtimeMs, before.mtimeMs);
});

test('Node bridge: built RAW page exposes original sensor pixels using the actual shipped WASM and async subpackage contract', {
  skip: !process.env.RAW_SENSOR_FILE,
}, async () => {
  const path = process.env.RAW_SENSOR_FILE!, canvas = new NodeCanvas();
  if (process.env.RAW_SENSOR_REFERENCE) {
    // Independently decoded real camera JPEG; this emulates only the small Canvas
    // reference. RAW pixels below still come from the actual shipped WASM.
    const reference = PNG.sync.read(readFileSync(process.env.RAW_SENSOR_REFERENCE));
    const context = canvas.getContext();
    (canvas as any).getContext = () => ({ ...context, setTransform: () => {}, drawImage: () => {},
      getImageData: () => {
        assert.equal(canvas.width, reference.width); assert.equal(canvas.height, reference.height);
        return { width: reference.width, height: reference.height, data: new Uint8ClampedArray(reference.data) };
      } });
    (canvas as any).createImage = () => ({ onload: () => {}, onerror: () => {}, set src(_value: string) { queueMicrotask(() => this.onload()); } });
  }
  const source = { path, name: basename(path), size: statSync(path).size };
  let definition: Record<string, any> = {}, requests = 0;
  const requireStub = Object.assign(() => { throw new Error('Unexpected runtime require'); }, {
    async: async function(this: unknown, requested: string) { assert.equal(this, requireStub); assert.equal(requested, '../../raw-engine/entry.js'); requests++; return {}; },
  });
  const saved: string[] = [], nativeWx = bridge.wx(), fs = nativeWx.getFileSystemManager();
  const descriptors = new Set<number>();
  if (process.env.RAW_SAVE_METRICS) Object.assign(fs, {
    open(options: Callbacks & { filePath: string; flag: string }) {
      const fd = openSync(options.filePath, options.flag); descriptors.add(fd); options.success?.({ fd: String(fd) });
    },
    write(options: Callbacks & { fd: string; data: ArrayBuffer; position: number }) {
      options.success?.({ bytesWritten: writeSync(Number(options.fd), Buffer.from(options.data), 0, options.data.byteLength, options.position) });
    },
    close(options: Callbacks & { fd: string }) {
      const fd = Number(options.fd); closeSync(fd); descriptors.delete(fd); options.success?.(); options.complete?.();
    },
  });
  const wx = { ...nativeWx, nextTick: (callback: () => void) => callback(), showToast: () => {},
    saveImageToPhotosAlbum: (options: Callbacks & { filePath: string }) => { saved.push(options.filePath); options.success?.(); },
    chooseMessageFile: (options: { success: (result: unknown) => void }) => options.success({ tempFiles: [source] }) };
  runInNewContext(readFileSync('dist/pages/index/index.js', 'utf8'), {
    Page: (value: Record<string, any>) => { definition = value; }, wx, console, setTimeout, clearTimeout, require: requireStub,
    WXWebAssembly: { instantiate: async (asset: string, imports: unknown) => {
      assert.equal(asset, '/raw-engine/flashraw.wasm.br');
      return await (globalThis as any).WebAssembly.instantiate(brotliDecompressSync(readFileSync(`dist${asset}`)), imports);
    } },
  });
  const page: Record<string, any> = { ...definition, data: { ...definition.data }, getCanvas: async () => canvas.native(),
    setData(update: Record<string, unknown>, callback?: () => void) { Object.assign(this.data, update); callback?.(); } };
  const initialRead = bridge.reads.length, initialStart = performance.now();
  await page.chooseChatFile();
  assert.equal(page.data.errorMessage, ''); assert.equal(requests, 1);
  assert.equal(page.data.format, 'RAW'); assert.equal(page.data.canRawPixels, true); assert.ok(page.detail);
  assert.ok(page.data.canSave); assert.equal(typeof page.data.rawAutoAvailable, 'boolean');
  if (process.env.RAW_SENSOR_REFERENCE) {
    assert.equal(page.data.rawAutoEnabled, true);
    assert.ok(page.data.warnings.some((warning: string) => /在线性阶段补偿 \+/.test(warning)));
    const original = canvas.puts[0].data, optimized = canvas.puts[canvas.puts.length - 1].data;
    let before = 0, after = 0;
    for (let i = 0; i < original.length; i += 4) { before += original[i] + original[i+1] + original[i+2]; after += optimized[i] + optimized[i+1] + optimized[i+2]; }
    assert.ok(after > before * 2);
    if (process.env.RAW_AUTO_OVERVIEW_OUT) copyFileSync(page.data.previewPath, process.env.RAW_AUTO_OVERVIEW_OUT);
    if (process.env.RAW_AUTO_BASELINE_OUT) copyFileSync(page.rawOriginalPath, process.env.RAW_AUTO_BASELINE_OUT);
  }
  if (process.env.RAW_INITIAL_PROFILE_OUT) {
    const reads = bridge.reads.slice(initialRead).filter(read => read.path === path), image = canvas.puts[0];
    const { createHash } = await import('node:crypto');
    writeFileSync(process.env.RAW_INITIAL_PROFILE_OUT, JSON.stringify({
      environment: 'Node file/native API bridge, not device timing', reads: reads.length,
      bytes: reads.reduce((n, read) => n + read.length, 0), maxRead: Math.max(...reads.map(read => read.length)),
      milliseconds: performance.now() - initialStart, width: image.width, height: image.height,
      rgbaSha256: createHash('sha256').update(image.data).digest('hex'),
      rawAutoEnabled: page.data.rawAutoEnabled,
      autoWarning: page.data.warnings.find((warning: string) => /在线性阶段补偿 \+/.test(warning)),
    }, null, 2), { flag: 'wx' });
  }
  const patch = await page.detail.render({ x: 100, y: 200, width: 128, height: 128 }, { width: 128, height: 128 }, () => true);
  assert.equal(PNG.sync.read(readFileSync(patch)).width, 128);
  if (process.env.RAW_SENSOR_REFERENCE) {
    page.setRawAuto(false);
    const base = await page.detail.render({ x: 100, y: 200, width: 128, height: 128 }, { width: 128, height: 128 }, () => true);
    const a = PNG.sync.read(readFileSync(patch)).data, b = PNG.sync.read(readFileSync(base)).data;
    assert.ok(a.reduce((n: number, v: number) => n+v, 0) > b.reduce((n: number, v: number) => n+v, 0));
    await page.detail.release(base); page.setRawAuto(true);
  }
  await page.detail.release(patch);
  // Exercise actual Page scale/viewport publication, not only the decoder's direct ROI method.
  const area = { left: 0, top: 0, width: 400, height: 400 };
  let scale = 4.33, pan = 0;
  page.createSelectorQuery = () => {
    const query: Record<string, any> = { select: () => query, boundingClientRect: () => query,
      exec: (done: (value: unknown[]) => void) => done([area, {
        left: 200 * (1 - scale) + pan, top: 200 * (1 - scale), width: 400 * scale, height: 400 * scale,
      }]) };
    return query;
  };
  for (const change of [{ scale: 4.33, pan: 0 }, { scale: 12, pan: -40 }]) {
    scale = change.scale; pan = change.pan;
    const firstRead = bridge.reads.length;
    page.onScale({ detail: { scale, x: pan, y: 0 } });
    clearTimeout(page.detailTimer); page.refreshDetail(); await page.detailTask;
    assert.ok(page.detail, page.data.warnings.join('\n'));
    assert.ok(page.data.detailPath); const png = PNG.sync.read(readFileSync(page.data.detailPath));
    assert.ok(png.width > 1 && png.height > 1 && png.width <= 1365 && png.height <= 1365);
    assert.ok(bridge.reads.slice(firstRead).some(read => read.path === path));
  }
  if (process.env.RAW_SAVE_METRICS) {
    const importAndDetail = bridge.reads.filter(read => read.path === path);
    let start = bridge.reads.length;
    page.toggleRawAuto(); await page.saveImage(); await page.saveCameraJpeg();
    assert.equal(bridge.reads.length, start);
    assert.equal(saved[0], page.rawOriginalPath); assert.equal(saved[1], page.rawJpegPath);
    assert.equal(page.data.canNative, true);
    try {
      const beforeCanvasExports = bridge.exports.length;
      await page.saveOriginalImage();
      assert.equal(page.data.nativeState, 'READY', page.data.errorMessage);
      assert.equal(saved[2], page.nativePath);
      const fd = openSync(saved[2], 'r');
      try {
        const header = Buffer.alloc(29); assert.equal(readSync(fd, header, 0, header.length, 0), header.length);
        assert.deepEqual([header.readUInt32BE(16), header.readUInt32BE(20), header[24], header[25]], [page.detail.width, page.detail.height, 8, 2]);
      } finally { closeSync(fd); }
      assert.equal(bridge.exports.length, beforeCanvasExports);
      const nativeReads = bridge.reads.slice(start).filter(read => read.path === path);
      assert.ok(nativeReads.length && nativeReads.every(read => read.position && read.length <= 65536));
      start = bridge.reads.length;
      await page.saveOriginalImage(); assert.equal(saved[3], saved[2]); assert.equal(bridge.reads.length, start);
      for (const [phase, reads] of [['import and detail', importAndDetail], ['native PNG', nativeReads]] as const) {
        console.log(`Sony ${phase}: ${reads.length} reads, ${reads.reduce((total, read) => total + read.length, 0)} bytes, max ${Math.max(...reads.map(read => read.length))}`);
      }
    } finally { for (const fd of descriptors) closeSync(fd); }
  }
  page.backToHome();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(existsSync(path)); assert.equal(page.data.canRawPixels, false);
});

test('Node bridge: the built TIFF page runs without browser text globals and decodes actual pixels', {
  skip: process.env.TIFF_BUILT_TEST !== '1',
}, async () => {
  const source = bridge.file('built.tif', tiffImage({ compression: 8 }));
  let selectedSource = source;
  const canvas = new NodeCanvas();
  let definition: Record<string, any> = {};
  const wx = { ...bridge.wx(), nextTick: (callback: () => void) => callback(),
    chooseMessageFile: (options: { success: (result: unknown) => void }) => options.success({ tempFiles: [selectedSource] }) };
  runInNewContext(readFileSync('dist/pages/index/index.js', 'utf8'), {
    Page: (value: Record<string, any>) => { definition = value; }, wx, console, setTimeout, clearTimeout,
  });
  const page: Record<string, any> = { ...definition, data: { ...definition.data }, getCanvas: async () => canvas.native(),
    setData(update: Record<string, unknown>, callback?: () => void) { Object.assign(this.data, update); callback?.(); } };
  await page.chooseFile();
  assert.equal(page.data.errorMessage, '');
  assert.equal(page.data.format, 'TIFF');
  assert.deepEqual([...canvas.puts[0].data], [255, 0, 0, 255, 0, 255, 0, 255]);
  selectedSource = bridge.file('built-detail.tif', tiffImage({ width: 1400, height: 4,
    pixels: Uint8Array.from({ length: 1400 * 4 * 3 }, (_, i) => i % 256) }));
  await page.chooseFile();
  assert.equal(page.data.errorMessage, '');
  assert.equal(page.data.zoomMax, 64);
  assert.ok(page.detail);
  const region = { x: 100, y: 1, width: 2, height: 2 };
  const tile = await page.detail.render(region, region, () => true);
  const image = PNG.sync.read(readFileSync(tile));
  assert.equal(image.data[0], ((1400 + 100) * 3) % 256);
  await page.detail.release(tile);
  assert.ok(!existsSync(tile));
  const profile = matrixIcc();
  selectedSource = bridge.file('built-color.tif', tiffImage({ width: 1, pixels: Uint8Array.of(100, 80, 60), compression: 8, icc: profile }));
  await page.chooseFile();
  assert.equal(page.data.errorMessage, '');
  const expected = inspectIcc(profile).convert!(100 / 255, 80 / 255, 60 / 255).map(value => Math.round(value * 255));
  assert.deepEqual([...canvas.puts[canvas.puts.length - 1].data], [...expected, 255]);
});

test('Node bridge: TIFF detail cancels stale reads, rejects concurrent rendering and releases its own PNG', async () => {
  const source = bridge.file('detail.tif', tiffImage({ width: 1400, height: 6, pixels: Uint8Array.from({ length: 1400 * 6 * 3 }, (_, i) => i % 256) }));
  const prepared = await preparePreview(source, new NodeCanvas().native());
  assert.ok(prepared.detail);
  const overview = readFileSync(prepared.exportPath!);
  const region = { x: 2, y: 1, width: 4, height: 3 };
  const gate = bridge.gate('read', path => path === source.path);
  let current = true;
  const pending = prepared.detail.render(region, region, () => current);
  const cancelled = assert.rejects(pending, { code: 'CANCELLED' });
  await gate.started;
  await assert.rejects(prepared.detail.render(region, region, () => true), { code: 'PREVIEW_BUSY' });
  current = false; gate.release(); await cancelled;
  const path = await prepared.detail.render(region, region, () => true);
  const image = PNG.sync.read(readFileSync(path));
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 3; c++) {
    assert.equal(image.data[(y * 4 + x) * 4 + c], (((y + 1) * 1400 + x + 2) * 3 + c) % 256);
  }
  assert.deepEqual(readFileSync(prepared.exportPath!), overview);
  await prepared.detail.release(source.path);
  assert.ok(existsSync(source.path));
  await prepared.detail.release(path);
  assert.ok(!existsSync(path));
});

test('Node bridge: optional real TIFF range previews stay bounded and preserve originals', {
  skip: !process.env.TIFF_REAL_FILES,
}, async context => {
  const paths: string[] = JSON.parse(process.env.TIFF_REAL_FILES!);
  for (const [index, path] of paths.entries()) {
    const before = statSync(path), canvas = new NodeCanvas(), start = performance.now();
    const result = await preparePreview({ path, name: basename(path), size: before.size }, canvas.native());
    const png = PNG.sync.read(readFileSync(result.previewPath!));
    assert.equal(result.info.format, 'TIFF');
    assert.ok(png.width <= LIMITS.canvasSide && png.height <= LIMITS.canvasSide);
    assert.ok(png.data.some((value: number, i: number) => i % 4 !== 3 && value !== 0));
    const reads = bridge.reads.filter(read => read.path === path);
    assert.ok(reads.every(read => read.length <= 512 * 1024 && read.length < before.size));
    assert.ok(!bridge.writes.includes(path) && !bridge.unlinks.includes(path));
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
    assert.equal(statSync(path).size, before.size);
    const output = resolve(process.env.TIFF_REAL_OUTPUT || '.local-test-output/tiff-real');
    mkdirSync(output, { recursive: true });
    copyFileSync(result.previewPath!, join(output, `${index}.png`));
    context.diagnostic(JSON.stringify({ name: basename(path), bytes: before.size, source: [result.info.width, result.info.height],
      preview: [png.width, png.height], reads: reads.length, maxRead: Math.max(...reads.map(read => read.length)),
      totalRead: reads.reduce((sum, read) => sum + read.length, 0), elapsedMs: Math.round(performance.now() - start),
      arrayBuffers: process.memoryUsage().arrayBuffers }));
    assert.ok(result.detail);
    const overview = readFileSync(result.exportPath!);
    const region = index === 0 ? { x: 2800, y: 8700, width: 1024, height: 768 } : { x: 2700, y: 900, width: 1024, height: 768 };
    const tileReadsAt = bridge.reads.length, tileStart = performance.now();
    const tile = await result.detail.render(region, region, () => true);
    const tileElapsed = performance.now() - tileStart;
    copyFileSync(tile, join(output, `${index}-detail.png`));
    const tileReads = bridge.reads.slice(tileReadsAt).filter(read => read.path === path);
    assert.equal(tileReads.length, region.height);
    assert.ok(tileReads.every(read => read.length <= region.width * (index === 0 ? 3 : 10)));
    const stats = { region, elapsedMs: Math.round(tileElapsed), reads: tileReads.length,
      maxRead: Math.max(...tileReads.map(read => read.length)), totalRead: tileReads.reduce((sum, read) => sum + read.length, 0) };
    writeFileSync(join(output, `${index}-detail.json`), JSON.stringify(stats));
    let previous = tile;
    for (let move = 1; move <= 4; move++) {
      const next = await result.detail.render({ ...region, x: region.x + move * 20 }, region, () => true);
      await result.detail.release(previous); previous = next;
    }
    await result.detail.release(previous);
    assert.deepEqual(readFileSync(result.exportPath!), overview);
    assert.equal(bridge.exports.filter(entry => existsSync(entry.path)).length, 1);
    context.diagnostic(JSON.stringify({ detail: index, ...stats, repeatedPans: 4, overviewUnchanged: true }));
  }
});

test('Node bridge: real cross-realm ArrayBuffers decode the complete RLE PSD into exact PNG pixels', async () => {
  bridge.binaryRead = bytes => {
    const result = runInNewContext('Uint8Array.from(bytes).buffer', { bytes: Array.from(bytes) }) as ArrayBuffer;
    assert.equal(Object.prototype.toString.call(result), '[object ArrayBuffer]');
    assert.equal(result instanceof ArrayBuffer, false);
    assert.equal(result.byteLength, bytes.length);
    return result;
  };
  const source = bridge.fixture('photoshop/generated-rle.psd');
  const result = await preparePreview(source, new NodeCanvas().native());
  const png = PNG.sync.read(readFileSync(result.exportPath!));
  assert.deepEqual([png.width, png.height], [3, 2]);
  assert.deepEqual(Array.from(png.data), [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    21, 21, 21, 255, 21, 21, 21, 255, 21, 21, 21, 255]);
});

test('Node bridge: a short cross-realm full read is still rejected after a complete valid PSD header', async () => {
  let reads = 0;
  bridge.binaryRead = bytes => runInNewContext('Uint8Array.from(bytes).buffer', {
    bytes: Array.from(++reads === 2 ? bytes.subarray(0, bytes.length - 1) : bytes),
  }) as ArrayBuffer;
  const canvas = new NodeCanvas();
  await assert.rejects(preparePreview(bridge.fixture('photoshop/generated-rle.psd'), canvas.native()), { code: 'TRUNCATED' });
  assert.equal(reads, 2);
  assert.deepEqual(canvas.puts, []);
  assert.deepEqual(bridge.exports, []);
});

test('Node bridge: oversized stat probes bounded Photoshop ranges without reading the reported full file', async () => {
  const source = bridge.fixture('photoshop/generated-raw.psd');
  bridge.stats.set(source.path, LIMITS.photoshopBytes + 1);
  const canvas = new NodeCanvas();
  await assert.rejects(preparePreview({ ...source, size: 1 }, canvas.native()), { code: 'PHOTOSHOP_PREVIEW_UNAVAILABLE' });
  assert.equal(bridge.reads[0].length, 26);
  assert.ok(bridge.reads.some(read => (read.position ?? 0) > 0));
  assert.ok(bridge.reads.every(read => read.length < LIMITS.photoshopBytes));
  assert.deepEqual(canvas.puts, []);
  assert.ok(canvas.sizes.every(side => side <= LIMITS.canvasSide));
  assert.deepEqual(bridge.exports, []);
});

test('Node bridge: oversized dimensions with an incomplete composite cannot trigger a full read or PNG', async () => {
  const bytes = new Uint8Array(8192);
  bytes.set(readFileSync(join(fixtures, 'photoshop/generated-raw.psd')));
  new DataView(bytes.buffer).setUint32(18, 4097);
  const source = bridge.file('large-dimension.psd', bytes);
  const canvas = new NodeCanvas();
  await assert.rejects(preparePreview(source, canvas.native()), { code: 'PHOTOSHOP_PREVIEW_UNAVAILABLE' });
  assert.equal(bridge.reads[0].length, 4096);
  assert.ok(bridge.reads.some(read => (read.position ?? 0) > 0));
  assert.ok(bridge.reads.every(read => read.length < source.size));
  assert.deepEqual(canvas.puts, []);
  assert.ok(canvas.sizes.every(side => side <= LIMITS.canvasSide));
  assert.deepEqual(bridge.exports, []);
});

for (const format of ['psd', 'psb']) {
  test(`Node bridge: ${format.toUpperCase()} width 1366 probes preview ranges without exporting its incomplete composite`, async () => {
    const bytes = new Uint8Array(8192);
    bytes.set(readFileSync(join(fixtures, `photoshop/generated-raw.${format}`)));
    new DataView(bytes.buffer).setUint32(18, 1366);
    const source = bridge.file(`canvas-limit.${format}`, bytes);
    const canvas = new NodeCanvas();
    await assert.rejects(preparePreview(source, canvas.native()), { code: 'PHOTOSHOP_PREVIEW_UNAVAILABLE' });
    assert.equal(bridge.reads[0].length, 4096);
    assert.ok(bridge.reads.some(read => (read.position ?? 0) > 0));
    assert.ok(bridge.reads.every(read => read.length < source.size));
    assert.equal(canvas.puts.length, 0);
    assert.ok(canvas.sizes.every(side => side <= 1365));
    assert.equal(bridge.exports.length, 0);
  });
}

for (const [format, version] of [['PSD', 1], ['PSB', 2]] as const) {
  test(`Node bridge: a real 36 MiB ${format} produces a bounded 1365 by 1024 PNG from sampled composite rows`, async () => {
    const path = resolve(largePhotoshopPaths[format]);
    await writeLargePhotoshop(version, path);
    const source: ChosenFile = { path, name: basename(path), size: statSync(path).size };
    assert.ok(source.size > LIMITS.photoshopBytes);
    const canvas = new NodeCanvas();
    const result = await preparePreview(source, canvas.native());
    assert.deepEqual([result.info.width, result.info.height], [4096, 3072]);
    assert.equal(result.info.format, format);
    assert.equal(result.info.exportSupported, true);
    assert.equal(result.previewPath, result.exportPath);
    assert.ok(result.info.warnings.some(warning => /降采样/.test(warning) && /非原尺寸/.test(warning)));
    assert.equal(bridge.exports.length, 1);
    assert.equal(canvas.createdImages, 0);
    const png = PNG.sync.read(readFileSync(result.exportPath!));
    assert.deepEqual([png.width, png.height], [1365, 1024]);
    const expected = [...thumbnailColor, 255];
    assert.ok(png.data.every((value: number, index: number) => value === expected[index % 4]));
    assert.ok(canvas.sizes.every(side => side <= LIMITS.canvasSide));
    assert.deepEqual([canvas.width, canvas.height], [1, 1]);
    const reads = bridge.reads.filter(read => read.path === source.path);
    assert.equal(reads[0].length, 26);
    assert.ok(reads.some(read => (read.position ?? 0) > 0));
    const compositeStart = source.size - 4096 * 3072 * 3;
    assert.ok(reads.some(read => (read.position ?? 0) >= compositeStart), 'Preview must read the saved composite, not enlarge the embedded JPEG.');
    assert.ok(reads.every(read => read.length <= 2 * 1024 * 1024));
    assert.ok(reads.reduce((sum, read) => sum + read.length, 0) < source.size);
    assert.ok(bridge.writes.every(path => path !== source.path));
    assert.ok(bridge.unlinks.every(path => path !== source.path));
    assert.equal(statSync(source.path).size, source.size);
  });
}

for (const [name, version, compression] of [['unsupported', 1, 2], ['truncated', 2, 0]] as const) {
  test(`Node bridge: a ${name} composite keeps only its valid owned JPEG thumbnail and never exports PNG`, async () => {
    const prefix = photoshopPrefix(version, 4096, 3072, resource(1036, thumbnailData()));
    prefix.writeUInt16BE(compression, prefix.length - 2);
    const original = Buffer.concat([prefix, Buffer.alloc(8192 - prefix.length)]);
    const source = bridge.file(`thumbnail-${name}.${version === 1 ? 'psd' : 'psb'}`, original);
    const canvas = new NodeCanvas();
    const result = await preparePreview(source, canvas.native());
    assert.equal(result.info.exportSupported, false);
    assert.equal(result.exportPath, undefined);
    assert.match(result.previewPath!, /[\\/]quickview-v1[\\/]qv_[\w]+\.jpg$/);
    assert.deepEqual(readFileSync(result.previewPath!), thumbnailJpeg);
    assert.ok(result.info.warnings.some(warning => /低分辨率.*缩略图/.test(warning)));
    assert.deepEqual(canvas.puts, []);
    assert.ok(canvas.sizes.every(side => side <= LIMITS.canvasSide));
    assert.deepEqual(bridge.exports, []);
    assert.ok(bridge.reads.every(read => read.length < source.size));
    assert.deepEqual(readFileSync(source.path), original);
    assert.ok(bridge.writes.every(path => path !== source.path));
    await cleanupPreview();
    assert.equal(existsSync(result.previewPath!), false);
    assert.deepEqual(readFileSync(source.path), original);
    assert.ok(bridge.unlinks.every(path => path !== source.path));
  });
}

test('Node bridge: cancellation during a segmented read stops before later reads, thumbnail writes or PNG export', async () => {
  const prefix = photoshopPrefix(1, 4096, 3072, resource(1036, thumbnailData()));
  const source = bridge.file('cancelled-thumbnail.psd', Buffer.concat([prefix, Buffer.alloc(8192 - prefix.length)]));
  const pendingRead = bridge.gate('read', path => path === source.path && bridge.reads.length === 2);
  const canvas = new NodeCanvas();
  const task = preparePreview(source, canvas.native());
  const rejection = assert.rejects(task, { code: 'CANCELLED' });
  await pendingRead.started;
  assert.ok((bridge.reads[1].position ?? 0) > 0);
  const readCount = bridge.reads.length;
  await cleanupPreview();
  pendingRead.release();
  await rejection;
  assert.equal(bridge.reads.length, readCount);
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(bridge.exports, []);
  assert.deepEqual(canvas.puts, []);
  assert.equal(existsSync(source.path), true);
});

test('Node bridge: SVG width 1366 retains safe native preview while never allocating a large Canvas', async () => {
  const source = bridge.file('wide.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1366" height="1"><rect width="1366" height="1" fill="red"/></svg>');
  const canvas = new NodeCanvas();
  const result = await preparePreview(source, canvas.native());
  assert.equal(result.info.width, 1366);
  assert.match(result.previewPath!, /^data:image\/svg\+xml;base64,/);
  assert.equal(result.info.exportSupported, false);
  assert.equal(result.exportPath, undefined);
  assert.ok(result.info.warnings.some(warning => /1365/.test(warning)));
  assert.ok(canvas.sizes.every(side => side <= 1365));
  assert.deepEqual(canvas.sources, []);
  assert.deepEqual(bridge.exports, []);
});

test('Node bridge: SDK 2.10 receives an upgrade message before picker invocation, including legacy system-info fallback', async () => {
  bridge.sdkVersion = '2.10.0';
  await assert.rejects(chooseDesignFile(), { code: 'SDK_TOO_OLD', message: /升级微信/ });
  (globalThis as unknown as { wx: Record<string, unknown> }).wx.getAppBaseInfo = undefined;
  await assert.rejects(chooseDesignFile(), { code: 'SDK_TOO_OLD', message: /升级微信/ });
  assert.equal(bridge.pickerCalls, 0);
  assert.deepEqual(bridge.reads, []);
});

for (const errno of [112, 103, 104]) {
  test(`Node bridge: privacy errno ${errno} remains actionable instead of becoming a silent selection cancellation`, async () => {
    bridge.pickerFailure = { errno, errMsg: 'chooseMessageFile:fail privacy cancel' };
    await assert.rejects(chooseDesignFile(), { code: errno === 112 ? 'PRIVACY_CONFIG' : 'PRIVACY_DENIED', message: /隐私/ });
    assert.equal(bridge.pickerCalls, 1);
    assert.deepEqual(bridge.reads, []);
  });
}

test('Node bridge: only reserialized safe SVG reaches the image API; unsupported Canvas keeps preview and explains PNG unavailability', async () => {
  const text = readFileSync(join(fixtures, 'svg/basic.svg'), 'utf8').replace('<rect', '<!--PRIVATE_SOURCE_COMMENT--><rect');
  const source = bridge.file('shapes.svg', text);
  const canvas = new NodeCanvas();
  const result = await preparePreview(source, canvas.native());
  assert.equal(result.info.format, 'SVG');
  assert.equal(result.info.exportSupported, false);
  assert.equal(result.exportPath, undefined);
  assert.ok(result.info.warnings.some(warning => /SVG.*PNG|Canvas.*SVG/.test(warning)));
  assert.equal(canvas.sources.length, 1);
  assert.equal(canvas.sources[0], result.previewPath);
  assert.match(result.previewPath!, /^data:image\/svg\+xml;base64,/);
  const sanitized = Buffer.from(result.previewPath!.split(',')[1], 'base64').toString('utf8');
  assert.match(sanitized, /^<svg /);
  assert.doesNotMatch(sanitized, /PRIVATE_SOURCE_COMMENT|<\?xml|<script|https:\/\//);
  assert.equal(readFileSync(bridge.writes[0], 'utf8'), sanitized);
  assert.equal(readFileSync(source.path, 'utf8'), text);
  assert.deepEqual(bridge.exports, []);
});

test('Node bridge: scripts and external SVG references never reach an image or owned file write', async () => {
  for (const name of ['script.svg', 'external-resource.svg']) {
    const canvas = new NodeCanvas();
    const source = bridge.fixture(`svg/${name}`);
    const before = readFileSync(source.path);
    await assert.rejects(preparePreview(source, canvas.native()));
    assert.deepEqual(canvas.sources, []);
    assert.deepEqual(readFileSync(source.path), before);
  }
  assert.deepEqual(bridge.writes, []);
});

test('Node bridge: a valid sub-1 MiB SVG exceeding the serialized 512 KiB bridge budget stops before writes or image creation', async () => {
  const text = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<rect x="0" y="0" width="1" height="1" fill="#123456"/>'.repeat(9000)}</svg>`;
  assert.ok(Buffer.byteLength(text) < LIMITS.svgBytes);
  assert.ok(Buffer.byteLength(parseSvg(text).svg) > 512 * 1024, 'The permitted geometry must actually exceed the serialized bridge budget.');
  const source = bridge.file('too-complex.svg', text);
  const canvas = new NodeCanvas();
  await assert.rejects(preparePreview(source, canvas.native()), { code: 'SVG_TOO_COMPLEX' });
  assert.deepEqual(bridge.writes, []);
  assert.equal(canvas.createdImages, 0);
  assert.deepEqual(bridge.exports, []);
});

test('Node bridge: only checked AI content is copied byte-for-byte to an owned PDF without changing the source', async () => {
  const source = bridge.file('generated-control.ai', await aiContainer());
  const original = readFileSync(source.path);
  const result = await preparePreview(source, new NodeCanvas().native());
  assert.equal(result.info.format, 'AI');
  assert.equal(result.info.exportSupported, false);
  assert.match(result.documentPath!, /[\\/]quickview-v1[\\/]qv_[\w]+\.pdf$/);
  assert.deepEqual(readFileSync(result.documentPath!), original);
  assert.deepEqual(readFileSync(source.path), original);
  const writes = bridge.writes.length;
  const invalid = bridge.file('truncated.ai', original.subarray(0, original.length - 50));
  await assert.rejects(preparePreview(invalid, new NodeCanvas().native()), { code: 'AI_INCOMPLETE' });
  assert.equal(bridge.writes.length, writes);
  assert.ok(bridge.writes.every(path => path !== source.path && path !== invalid.path));
});

test('Node bridge: cleanup removes owned derivatives and generated PNG only', async () => {
  const source = bridge.fixture('photoshop/generated-raw.psd');
  const result = await preparePreview(source, new NodeCanvas().native());
  const ownedDirectory = join(bridge.userData, 'quickview-v1');
  mkdirSync(ownedDirectory, { recursive: true });
  const owned = ['qv_previous_1.pdf', 'qv_previous_2.svg', 'qv_previous_3.jpg'].map(name => join(ownedDirectory, name));
  const preserved = ['original.psd', 'notes.pdf', 'image.svg', 'original.jpg', 'qv_invalid-name.pdf', 'qv_invalid-name.jpg'].map(name => join(ownedDirectory, name));
  for (const path of [...owned, ...preserved]) writeFileSync(path, 'preserve boundary');
  const outside = join(bridge.root, 'user-original.png');
  writeFileSync(outside, 'original image');
  await cleanupPreview();
  for (const path of [...owned, result.previewPath!]) assert.equal(existsSync(path), false);
  for (const path of [...preserved, source.path, outside]) assert.equal(existsSync(path), true);
});

test('Node bridge: a late cancelled export cannot delete or cancel the newer in-flight AI preview', async () => {
  const latePng = bridge.gate('png');
  const oldTask = preparePreview(bridge.fixture('photoshop/generated-raw.psd'), new NodeCanvas().native());
  const oldRejection = assert.rejects(oldTask, { code: 'CANCELLED' });
  await latePng.started;
  await cleanupPreview();
  const newWrite = bridge.gate('write', path => path.endsWith('.pdf'));
  const newTask = preparePreview(bridge.file('generated-control.ai', await aiContainer()), new NodeCanvas().native());
  await newWrite.started;
  const newPath = bridge.writes[0];
  assert.equal(existsSync(newPath), true);
  latePng.release();
  await oldRejection;
  assert.equal(existsSync(bridge.exports[0].path), false);
  assert.equal(existsSync(newPath), true);
  newWrite.release();
  const current = await newTask;
  assert.equal(current.documentPath, newPath);
  assert.equal(existsSync(current.documentPath!), true);
});

test('Node bridge: a generation token captured before queued startup cleanup cancels the superseded selection before source reads', async () => {
  mkdirSync(join(bridge.userData, 'quickview-v1'), { recursive: true });
  const initialCleanup = bridge.gate('readdir');
  const firstFile = bridge.fixture('photoshop/generated-raw.psd');
  const first = preparePreview(firstFile, new NodeCanvas().native());
  const firstRejection = assert.rejects(first, { code: 'CANCELLED' });
  await initialCleanup.started;
  const secondFile = bridge.file('generated-control.ai', await aiContainer());
  const second = preparePreview(secondFile, new NodeCanvas().native());
  initialCleanup.release();
  await firstRejection;
  const result = await second;
  assert.equal(result.info.format, 'AI');
  assert.equal(bridge.reads.some(read => read.path === firstFile.path), false);
  assert.equal(existsSync(result.documentPath!), true);
});

test('Node bridge HD: repeated RLE regions reuse the prepared index and leave overview export bytes unchanged', async () => {
  const width = 1366;
  const rows = [10, 110, 20, 120, 30, 130].map(value => {
    const encoded: number[] = [];
    for (let remaining = width; remaining > 0;) {
      const count = Math.min(128, remaining);
      encoded.push(257 - count, value);
      remaining -= count;
    }
    return Buffer.from(encoded);
  });
  const prefix = photoshopPrefix(1, width, 2, Buffer.alloc(0));
  prefix.writeUInt16BE(1, prefix.length - 2);
  const table = Buffer.alloc(rows.length * 2);
  rows.forEach((row, index) => table.writeUInt16BE(row.length, index * 2));
  const original = Buffer.concat([prefix, table, ...rows]);
  const source = bridge.file('hd-indexed-rle.psd', original);
  const canvas = new NodeCanvas();
  const prepared = await preparePreview(source, canvas.native());
  assert.ok(prepared.detail);
  assert.deepEqual([prepared.detail.width, prepared.detail.height], [1366, 2]);
  const exportPath = prepared.exportPath!;
  const overview = readFileSync(exportPath);
  const indexReads = () => bridge.reads.filter(read => read.path === source.path
    && read.position === prefix.length && read.length === table.length).length;
  assert.equal(indexReads(), 1);
  const beforeRegions = bridge.reads.length;
  const dataStart = prefix.length + table.length;
  const first = await prepared.detail.render({ x: 100, y: 0, width: 16, height: 1 }, { width: 16, height: 1 }, () => true);
  const second = await prepared.detail.render({ x: 1000, y: 1, width: 8, height: 1 }, { width: 8, height: 1 }, () => true);
  for (const [path, width, color] of [[first, 16, [10, 20, 30, 255]], [second, 8, [110, 120, 130, 255]]] as const) {
    const png = PNG.sync.read(readFileSync(path));
    assert.deepEqual([png.width, png.height], [width, 1]);
    assert.ok(png.data.every((value: number, index: number) => value === color[index % 4]));
  }
  assert.equal(indexReads(), 1);
  assert.ok(bridge.reads.slice(beforeRegions).every(read => read.path === source.path && (read.position ?? 0) >= dataStart));
  assert.equal(prepared.previewPath, exportPath);
  assert.equal(prepared.exportPath, exportPath);
  assert.deepEqual(readFileSync(exportPath), overview);
  assert.deepEqual(readFileSync(source.path), original);
  assert.deepEqual([canvas.width, canvas.height], [1, 1]);
});

test('Node bridge HD: release deletes only its own detail PNG and preserves overview and user files', async () => {
  const path = resolve(largePhotoshopPaths.PSD);
  await writeLargePhotoshop(1, path);
  const source = { path, name: basename(path), size: statSync(path).size };
  const prepared = await preparePreview(source, new NodeCanvas().native());
  assert.ok(prepared.detail);
  const overview = readFileSync(prepared.exportPath!);
  const originalPng = bridge.file('user-original.png', Buffer.from('user-owned image'));
  const detail = await prepared.detail.render({ x: 100, y: 150, width: 40, height: 30 }, { width: 40, height: 30 }, () => true);
  const png = PNG.sync.read(readFileSync(detail));
  assert.deepEqual([png.width, png.height], [40, 30]);
  assert.ok(png.data.every((value: number, index: number) => value === [...thumbnailColor, 255][index % 4]));
  await prepared.detail.release(prepared.exportPath!);
  await prepared.detail.release(source.path);
  await prepared.detail.release(originalPng.path);
  assert.deepEqual(readFileSync(prepared.exportPath!), overview);
  assert.equal(statSync(source.path).size, source.size);
  assert.deepEqual(readFileSync(originalPng.path), Buffer.from('user-owned image'));
  assert.equal(existsSync(detail), true);
  await prepared.detail.release(detail);
  await prepared.detail.release(detail);
  assert.equal(existsSync(detail), false);
  assert.deepEqual(bridge.unlinks, [detail]);
  assert.equal(prepared.previewPath, prepared.exportPath);
  assert.deepEqual(readFileSync(prepared.exportPath!), overview);
});

test('Node bridge HD: viewport cancellation before and during a range read creates no PNG and allows another region', async () => {
  const path = resolve(largePhotoshopPaths.PSD);
  await writeLargePhotoshop(1, path);
  const source = { path, name: basename(path), size: statSync(path).size };
  const canvas = new NodeCanvas();
  const prepared = await preparePreview(source, canvas.native());
  assert.ok(prepared.detail);
  const rect = { x: 100, y: 150, width: 40, height: 30 };
  const output = { width: 40, height: 30 };
  const before = { reads: bridge.reads.length, exports: bridge.exports.length, puts: canvas.puts.length };
  await assert.rejects(prepared.detail.render(rect, output, () => false), { code: 'CANCELLED' });
  assert.equal(bridge.reads.length, before.reads);
  assert.equal(bridge.exports.length, before.exports);
  let current = true;
  const pending = bridge.gate('read', candidate => candidate === source.path);
  const render = prepared.detail.render(rect, output, () => current);
  const cancelled = assert.rejects(render, { code: 'CANCELLED' });
  await pending.started;
  assert.equal(bridge.reads.length, before.reads + 1);
  current = false;
  pending.release();
  await cancelled;
  assert.equal(bridge.reads.length, before.reads + 1);
  assert.equal(bridge.exports.length, before.exports);
  assert.equal(canvas.puts.length, before.puts); // Stub history, not a native-memory measurement.
  const fresh = await prepared.detail.render(rect, output, () => true);
  assert.equal(existsSync(fresh), true);
  assert.equal(bridge.exports.length, before.exports + 1);
  assert.equal(prepared.previewPath, prepared.exportPath);
  assert.equal(existsSync(prepared.exportPath!), true);
});

test('Node bridge HD: replacing the file cancels an in-flight old session and protects the new overview', async () => {
  const path = resolve(largePhotoshopPaths.PSD);
  await writeLargePhotoshop(1, path);
  const source = { path, name: basename(path), size: statSync(path).size };
  const previous = await preparePreview(source, new NodeCanvas().native());
  assert.ok(previous.detail);
  const rect = { x: 100, y: 150, width: 40, height: 30 };
  const output = { width: 40, height: 30 };
  const pending = bridge.gate('read', candidate => candidate === source.path);
  const render = previous.detail.render(rect, output, () => true);
  const cancelled = assert.rejects(render, { code: 'CANCELLED' });
  await pending.started;
  const next = await preparePreview(bridge.fixture('photoshop/generated-raw.psd'), new NodeCanvas().native());
  const nextBytes = readFileSync(next.exportPath!);
  const reads = bridge.reads.length;
  const exports = bridge.exports.length;
  pending.release();
  await cancelled;
  assert.equal(bridge.reads.length, reads);
  assert.equal(bridge.exports.length, exports);
  assert.equal(existsSync(previous.previewPath!), false);
  await assert.rejects(previous.detail.render(rect, output, () => true), { code: 'CANCELLED' });
  assert.equal(bridge.reads.length, reads);
  await previous.detail.release(next.exportPath!);
  assert.deepEqual(readFileSync(next.exportPath!), nextBytes);
  assert.equal(statSync(source.path).size, source.size);
  assert.ok(bridge.unlinks.every(candidate => candidate !== source.path && candidate !== next.exportPath));
});

test('Node bridge RGB16: the existing adapter renders a real 512px tile and keeps the overview export unchanged', async () => {
  const fixture = raw16({ width: 600, height: 520, channels: 5, count: 1 });
  const source = bridge.file('rgb16-five-channels.psd', fixture.bytes);
  const canvas = new NodeCanvas();
  const prepared = await preparePreview(source, canvas.native());
  assert.ok(prepared.detail && prepared.previewPath && prepared.exportPath);
  assert.equal(prepared.info.bitDepth, 16);
  assert.equal(prepared.detail.previewWidth, 600);
  const overview = readFileSync(prepared.exportPath);
  const firstRead = bridge.reads.length;
  const rect = { x: 44, y: 4, width: 512, height: 512 };
  const path = await prepared.detail.render(rect, { width: 512, height: 512 }, () => true);
  const png = PNG.sync.read(readFileSync(path));
  assert.deepEqual([png.width, png.height], [512, 512]);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const pixel = (y * 512 + x) * 4;
    for (let c = 0; c < 3; c++) assert.equal(png.data[pixel + c], fixture.value(c, x + rect.x, y + rect.y) >>> 8);
    assert.equal(png.data[pixel + 3], 255);
  }
  assert.ok(bridge.reads.slice(firstRead).every(read => read.length < source.size
    && (read.position ?? 0) >= fixture.dataOffset
    && (read.position ?? 0) + read.length <= fixture.dataOffset + 600 * 520 * 3 * 2));
  assert.deepEqual(readFileSync(prepared.exportPath), overview);
  assert.equal(prepared.previewPath, prepared.exportPath);
  await prepared.detail.release(path);
  assert.equal(existsSync(path), false);
  assert.deepEqual(readFileSync(source.path), fixture.bytes);
  assert.deepEqual([canvas.width, canvas.height], [1, 1]);
});

test('Node bridge RGB16: unsupported compression and merged transparency retain the safe JPEG-only fallback', async () => {
  for (const options of [{ compression: 1 }, { compression: 2 }, { compression: 3 }, { count: -1 }]) {
    const fixture = raw16({ channels: 5, resources: resource(1036, thumbnailData()), ...options });
    const source = bridge.file(`rgb16-fallback-${options.compression ?? 'alpha'}.psd`, fixture.bytes);
    const prepared = await preparePreview(source, new NodeCanvas().native());
    assert.equal(prepared.detail, undefined);
    assert.equal(prepared.exportPath, undefined);
    assert.equal(prepared.info.exportSupported, false);
    assert.ok(prepared.previewPath!.endsWith('.jpg'));
    assert.deepEqual(readFileSync(prepared.previewPath!), thumbnailJpeg);
    assert.ok(prepared.info.warnings.some(text => text.includes('低分辨率')));
  }
});

test('Node bridge RGB16: full visible patch exceeds 512px and uses original samples at bounded output sizes', async () => {
  const fixture = raw16({ width: 600, height: 520, channels: 5, count: 1 });
  const source = bridge.file('rgb16-visible.psd', fixture.bytes);
  const phases: string[] = [];
  const prepared = await preparePreview(source, new NodeCanvas().native(), phase => phases.push(phase));
  assert.deepEqual(phases, ['metadata', 'preview']);
  assert.deepEqual(prepared.exportSize, { width: 600, height: 520 });
  const overview = readFileSync(prepared.exportPath!);
  const rect = { x: 10, y: 2, width: 580, height: 516 };
  for (const factor of [1, 2]) {
    const before = bridge.reads.length;
    const path = await prepared.detail!.render(rect, { width: 580 / factor, height: 516 / factor }, () => true);
    const image = PNG.sync.read(readFileSync(path));
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      for (let c = 0; c < 3; c++) {
        let expected = 0;
        for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
          expected += fixture.value(c, rect.x + x * factor + dx, rect.y + y * factor + dy) >>> 8;
        }
        assert.equal(image.data[(y * image.width + x) * 4 + c], Math.round(expected / (factor * factor)));
      }
      assert.equal(image.data[(y * image.width + x) * 4 + 3], 255);
    }
    assert.ok(bridge.reads.slice(before).every(read => read.length <= 512 * 1024
      && (read.position ?? 0) >= fixture.dataOffset
      && (read.position ?? 0) + read.length <= fixture.dataOffset + 600 * 520 * 3 * 2));
    await prepared.detail!.release(path);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readFileSync(prepared.exportPath!), overview);
  }
  assert.deepEqual(readFileSync(source.path), fixture.bytes);
});

test('Node bridge RGB16: invalid tile geometry is rejected without reading or altering the overview', async () => {
  const fixture = raw16({ width: 600, height: 520, channels: 5, count: 1 });
  const prepared = await preparePreview(bridge.file('rgb16-geometry.psd', fixture.bytes), new NodeCanvas().native());
  assert.ok(prepared.detail);
  const before = bridge.reads.length;
  for (const [rect, output] of [
    [{ x: 0, y: 0, width: 601, height: 512 }, { width: 601, height: 512 }],
    [{ x: 0.5, y: 0, width: 512, height: 512 }, { width: 512, height: 512 }],
    [{ x: 100, y: 0, width: 512, height: 512 }, { width: 512, height: 512 }],
    [{ x: 0, y: 0, width: 512, height: 512 }, { width: 513, height: 512 }],
    [{ x: 0, y: 0, width: 512, height: 512 }, { width: 0, height: 256 }],
    [{ x: 0, y: 0, width: 512, height: 512 }, { width: 256.5, height: 256 }],
  ] as const) await assert.rejects(prepared.detail.render(rect, output, () => true), { code: 'INVALID_REGION' });
  assert.equal(bridge.reads.length, before);
  assert.ok(existsSync(prepared.exportPath!));
});

test('Node bridge RGB16: cancelling a tile creates no PNG and a fresh request still succeeds', async () => {
  const fixture = raw16({ width: 600, height: 520, channels: 5, count: 1 });
  const source = bridge.file('rgb16-cancel.psd', fixture.bytes);
  const prepared = await preparePreview(source, new NodeCanvas().native());
  assert.ok(prepared.detail);
  const before = { reads: bridge.reads.length, exports: bridge.exports.length };
  const gate = bridge.gate('read', p => p === source.path);
  let current = true;
  const task = prepared.detail.render({ x: 44, y: 4, width: 512, height: 512 }, { width: 512, height: 512 }, () => current);
  const rejected = assert.rejects(task, { code: 'CANCELLED' });
  await gate.started;
  current = false;
  gate.release();
  await rejected;
  assert.equal(bridge.reads.length, before.reads + 1);
  assert.equal(bridge.exports.length, before.exports);
  const path = await prepared.detail.render({ x: 44, y: 4, width: 512, height: 512 }, { width: 512, height: 512 }, () => true);
  assert.ok(existsSync(path) && existsSync(prepared.exportPath!));
});

test('Node bridge RGB16: private real-file tile matches independent full-precision source reads and ICC without exporting the tile',
  { skip: !process.env.PSD16_REAL_PATH }, async () => {
    const path = resolve(process.env.PSD16_REAL_PATH!);
    const before = statSync(path);
    const canvas = new NodeCanvas();
    const started = performance.now();
    const prepared = await preparePreview({ path, name: basename(path), size: before.size }, canvas.native());
    const overviewMs = performance.now() - started;
    assert.ok(prepared.detail && prepared.exportPath && prepared.previewPath);
    assert.deepEqual([prepared.detail.width, prepared.detail.height], [6016, 4016]);
    const overview = readFileSync(prepared.exportPath);
    const begin = bridge.reads.length;
    const rendering = performance.now();
    const tilePath = await prepared.detail.render({ x: 2752, y: 1752, width: 512, height: 512 },
      { width: 512, height: 512 }, () => true);
    const detailMs = performance.now() - rendering;
    const tile = readFileSync(tilePath);
    const png = PNG.sync.read(tile);
    assert.deepEqual([png.width, png.height], [512, 512]);
    // The V1 POC was deliberately unmanaged. V1.1 must compare to original
    // uint16 samples followed by ICC, not demand the obsolete unconverted PNG.
    const fd = openSync(path, 'r');
    try {
      const read = async (offset: number, length: number) => {
        const bytes = Buffer.alloc(length); assert.equal(readSync(fd, bytes, 0, length, offset), length); return bytes;
      };
      const header = readPhotoshopHeader(await read(0, 26));
      const color = await readPhotoshopIcc(read, before.size, header);
      let offset = 26;
      for (let i = 0; i < 3; i++) offset += 4 + (await read(offset, 4)).readUInt32BE(0);
      assert.equal((await read(offset, 2)).readUInt16BE(0), 0); offset += 2;
      const values = new Float64Array(512 * 512 * 3);
      for (let c = 0; c < 3; c++) for (let y = 0; y < 512; y++) {
        const row = await read(offset + ((c * header.height + 1752 + y) * header.width + 2752) * 2, 1024);
        for (let x = 0; x < 512; x++) values[(y * 512 + x) * 3 + c] = row.readUInt16BE(x * 2) / 65535;
      }
      assert.ok(color.convert);
      for (let i = 0; i < 512 * 512; i++) {
        const expected = color.convert!(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]);
        for (let c = 0; c < 3; c++) assert.ok(Math.abs(png.data[i * 4 + c] - Math.round(expected[c] * 255)) <= 1);
        assert.equal(png.data[i * 4 + 3], 255);
      }
    } finally { closeSync(fd); }
    assert.equal(prepared.exportPath, prepared.previewPath);
    assert.notEqual(prepared.exportPath, tilePath);
    assert.deepEqual(readFileSync(prepared.exportPath), overview);
    const tileReads = bridge.reads.slice(begin).filter(r => r.path === path);
    assert.equal(tileReads.length, 96);
    assert.ok(tileReads.every(r => r.length <= 512 * 1024 && r.length < before.size));
    const after = statSync(path);
    assert.deepEqual([after.size, after.mtimeMs, after.ctimeMs], [before.size, before.mtimeMs, before.ctimeMs]);
    const output = resolve('.local-test-output/rgb16-wechat');
    mkdirSync(output, { recursive: true });
    const id = Date.now();
    const overviewPath = join(output, `adapter-overview-${id}.png`);
    const pngPath = join(output, `adapter-tile-${id}.png`);
    writeFileSync(overviewPath, overview, { flag: 'wx' });
    writeFileSync(pngPath, tile, { flag: 'wx' });
    writeFileSync(join(output, `adapter-result-${id}.json`), JSON.stringify({
      environment: 'Node filesystem/Canvas API stubs using the actual private PSD; NOT WeChat runtime or device proof',
      source: path, sourceBytes: before.size, sourceOpenedReadOnly: true, sourceSizeAndTimesUnchanged: true,
      overview: { path: overviewPath, width: PNG.sync.read(overview).width, height: PNG.sync.read(overview).height, milliseconds: overviewMs },
      detail: { path: pngPath, x: 2752, y: 1752, width: 512, height: 512, milliseconds: detailMs,
        reads: tileReads.length, bytes: tileReads.reduce((sum, r) => sum + r.length, 0), maxRead: Math.max(...tileReads.map(r => r.length)),
        originalUint16AndIccChecked: true, maxQuantizationTolerance: 1 },
      exportRemainsOverview: true, android: 'NOT_RUN', ios: 'NOT_RUN',
    }, null, 2), { flag: 'wx' });
  });

test('Node bridge PDF: compatible bytes and pages survive viewing while an old copy is replaced', async () => {
  const { PDFDocument, PDFName, PDFString } = await import('pdf-lib');
  const doc = await PDFDocument.create(); doc.addPage(); doc.addPage(); doc.setCreator('Adobe Illustrator');
  doc.catalog.set(PDFName.of('AIPrivateData'), PDFString.of('project-owned structural test'));
  const original = await doc.save({ useObjectStreams: false });
  const source = bridge.file('multi.ai', original);
  const prepared = await preparePreview(source, new NodeCanvas().native());
  const path = prepared.documentPath!;
  assert.deepEqual(readFileSync(path), Buffer.from(original));
  assert.equal((await PDFDocument.load(readFileSync(path))).getPageCount(), 2);
  let request: any; let calls = 0;
  (wx as any).openDocument = (options: any) => { calls++; request = options; };
  assert.equal(calls, 0);
  const opening = openAiDocument(path);
  assert.equal(calls, 1); assert.equal(request.filePath, path);
  assert.equal(request.fileType, 'pdf'); assert.equal(request.showMenu, false);
  await cleanupPreview(); assert.equal(existsSync(path), true);
  const next = await preparePreview(bridge.file('next.ai', await aiContainer()), new NodeCanvas().native());
  assert.ok(existsSync(next.documentPath!) && existsSync(path));
  request.success(); await opening;
  assert.equal(existsSync(path), false); assert.ok(existsSync(next.documentPath!));
  assert.deepEqual(readFileSync(source.path), Buffer.from(original));
});

test('Node bridge: ordinary PDFs are rejected before copying, including a renamed PDF', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create(); doc.addPage();
  const bytes = await doc.save({ useObjectStreams: false });
  for (const name of ['ordinary.pdf', 'renamed.svg']) {
    const source = bridge.file(name, bytes);
    await assert.rejects(preparePreview(source, new NodeCanvas().native()), { code: 'UNSUPPORTED_FORMAT' });
    assert.deepEqual(readFileSync(source.path), Buffer.from(bytes));
  }
  const disguised = bridge.file('ordinary.ai', bytes);
  await assert.rejects(preparePreview(disguised, new NodeCanvas().native()), { code: 'AI_IDENTITY' });
  assert.equal(bridge.copies.length, 0); assert.equal(bridge.exports.length, 0);
});

test('Node bridge PDF: the picker excludes PDF and oversized ordinary PDF stops before native copying', async () => {
  let request: any;
  (wx as any).chooseMessageFile = (options: any) => { request = options; options.fail({ errMsg: 'chooseMessageFile:fail cancel' }); };
  await assert.rejects(chooseDesignFile(), /已取消选择/);
  assert.deepEqual(request.extension, ['arw', 'cr2', 'cr3', 'nef', 'raf', 'dng', 'raw', 'psd', 'psb', 'tif', 'tiff', 'ai', 'svg', 'jpg', 'jpeg', 'png']);
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create(); doc.addPage();
  const source = bridge.file('oversized.pdf', await doc.save({ useObjectStreams: false }));
  bridge.stats.set(source.path, LIMITS.aiBytes + 1);
  await assert.rejects(preparePreview(source, new NodeCanvas().native()), { code: 'FILE_TOO_LARGE' });
  assert.equal(bridge.copies.length, 0); assert.ok(bridge.reads.every(r => r.length <= 26));
});

test('Node bridge PDF sharing: native API runs in the same stack without async filesystem work and retains its copy until completion', async () => {
  const source = bridge.file('share.ai', await aiContainer());
  const original = readFileSync(source.path);
  const prepared = await preparePreview(source, new NodeCanvas().native()), path = prepared.documentPath!;
  const before = { reads: bridge.reads.length, copies: bridge.copies.length, writes: bridge.writes.length };
  const manager = wx.getFileSystemManager(), stat = manager.stat;
  let request: any, calls = 0, stats = 0;
  (manager as any).stat = () => { stats++; throw new Error('Sharing must not await stat before its user gesture API'); };
  (wx as any).shareFileMessage = (options: any) => { calls++; request = options; };
  const sharing = sharePdfDocument(path, '设计:稿/检查.AI', () => true);
  assert.equal(calls, 1, 'The native call must occur before returning the promise to the tap handler');
  assert.equal(stats, 0); assert.equal(request.filePath, path); assert.equal(request.fileName, '设计_稿_检查.pdf');
  assert.deepEqual({ reads: bridge.reads.length, copies: bridge.copies.length, writes: bridge.writes.length }, before);
  manager.stat = stat;
  await cleanupPreview(); assert.ok(existsSync(path));
  const next = await preparePreview(bridge.file('next.ai', await aiContainer()), new NodeCanvas().native());
  assert.ok(existsSync(path) && existsSync(next.documentPath!));
  request.success(); await sharing;
  assert.equal(existsSync(path), false); assert.ok(existsSync(next.documentPath!));
  assert.deepEqual(readFileSync(source.path), original);
});

test('Node bridge PDF sharing: native viewers and sharing each keep a lease until all callbacks settle', async () => {
  const prepared = await preparePreview(bridge.file('leased.ai', await aiContainer()), new NodeCanvas().native()), path = prepared.documentPath!;
  let viewing: any, sharing: any;
  (wx as any).openDocument = (options: any) => { viewing = options; };
  (wx as any).shareFileMessage = (options: any) => { sharing = options; };
  const opened = openAiDocument(path), shared = sharePdfDocument(path, 'leased.pdf', () => true);
  const rejected = assert.rejects(shared, { code: 'SHARE_CANCELLED' });
  assert.equal(sharing.fileName, 'leased.pdf');
  await cleanupPreview(); assert.ok(existsSync(path));
  sharing.fail({ errMsg: 'shareFileMessage:fail cancel' }); await rejected; assert.ok(existsSync(path));
  viewing.success(); await opened; assert.equal(existsSync(path), false);
});

test('Node bridge PDF sharing: unavailable API, stale state and unowned paths never invoke native sharing', async () => {
  const prepared = await preparePreview(bridge.file('checked.ai', await aiContainer()), new NodeCanvas().native()), path = prepared.documentPath!;
  await assert.rejects(sharePdfDocument(path, 'checked.ai', () => true), { code: 'API_UNAVAILABLE' });
  let calls = 0;
  (wx as any).shareFileMessage = () => { calls++; };
  await assert.rejects(sharePdfDocument(path, 'checked.ai', () => false), { code: 'CANCELLED' });
  await assert.rejects(sharePdfDocument(bridge.fixture('photoshop/generated-raw.psd').path, 'checked.ai', () => true), { code: 'INVALID_PDF_PATH' });
  const canIUse = wx.canIUse;
  (wx as any).canIUse = (name: string) => name !== 'shareFileMessage';
  await assert.rejects(sharePdfDocument(path, 'checked.ai', () => true), { code: 'API_UNAVAILABLE' });
  wx.canIUse = canIUse;
  await cleanupPreview();
  await assert.rejects(sharePdfDocument(path, 'checked.ai', () => true), { code: 'FILE_EXPIRED' });
  assert.equal(calls, 0);
});

test('Node bridge PDF sharing: privacy, cancellation and exact native errors stay distinct and failed requests release their leases', async () => {
  const prepared = await preparePreview(bridge.file('fail.ai', await aiContainer()), new NodeCanvas().native()), path = prepared.documentPath!;
  for (const [error, code, message] of [
    [{ errMsg: 'shareFileMessage:fail cancel' }, 'SHARE_CANCELLED', /已取消分享/],
    [{ errno: 104, errMsg: 'shareFileMessage:fail privacy cancel' }, 'PRIVACY_DENIED', /隐私/],
    [{ errno: 112, errMsg: 'shareFileMessage:fail privacy banned' }, 'PRIVACY_CONFIG', /隐私/],
    [{ errMsg: 'shareFileMessage:fail can only be invoked by user TAP gesture' }, 'PLATFORM_ERROR', /can only be invoked by user TAP gesture/],
    [{ errMsg: 'shareFileMessage:fail ENOENT no such file' }, 'FILE_EXPIRED', /临时文件已失效/],
  ] as const) {
    (wx as any).shareFileMessage = (options: any) => options.fail(error);
    await assert.rejects(sharePdfDocument(path, 'fail.pdf', () => true), { code, message });
  }
  (wx as any).shareFileMessage = () => { throw new Error('shareFileMessage:fail thrown native error'); };
  await assert.rejects(sharePdfDocument(path, 'fail.pdf', () => true), { code: 'PLATFORM_ERROR', message: /thrown native error/ });
  await cleanupPreview(); assert.equal(existsSync(path), false);
});

test('Node bridge PDF: unavailable viewing, native failure and expiration preserve original AI', async () => {
  const original = await aiContainer(), source = bridge.file('source.ai', original);
  const prepared = await preparePreview(source, new NodeCanvas().native()); const path = prepared.documentPath!;
  const canIUse = wx.canIUse; (wx as any).canIUse = () => false;
  await assert.rejects(openAiDocument(path), { code: 'API_UNAVAILABLE' });
  wx.canIUse = canIUse;
  (wx as any).openDocument = (options: any) => options.fail({ errMsg: 'openDocument:fail unknown' });
  await assert.rejects(openAiDocument(path), { code: 'PLATFORM_ERROR' });
  assert.deepEqual(readFileSync(source.path), Buffer.from(original));
  await cleanupPreview(); assert.equal(existsSync(path), false);
  (wx as any).openDocument = (options: any) => options.fail({ errMsg: 'openDocument:fail ENOENT no such file' });
  await assert.rejects(openAiDocument(path), { code: 'FILE_EXPIRED' });
});

test('Node bridge PDF: document menu stays disabled and pending native opening protects its derivative', async () => {
  const prepared = await preparePreview(bridge.file('menu.ai', await aiContainer()), new NodeCanvas().native());
  let request: any;
  (wx as any).openDocument = (options: any) => { request = options; };
  const opening = openAiDocument(prepared.documentPath!);
  assert.equal(request.showMenu, false); assert.equal(request.fileType, 'pdf');
  await cleanupPreview(); assert.ok(existsSync(prepared.documentPath!));
  request.success(); await opening; assert.equal(existsSync(prepared.documentPath!), false);
});

test('Node bridge HQ export: lazy full-composition output is cached and cancellation preserves the quick overview', async () => {
  const fixture = raw16({ width: 1500, height: 16, channels: 5, count: 1 });
  const source = bridge.file('hq.psd', fixture.bytes), canvas = new NodeCanvas();
  const prepared = await preparePreview(source, canvas.native());
  assert.ok(prepared.prepareExport && prepared.detail && prepared.exportSize);
  const overview = readFileSync(prepared.exportPath!), before = bridge.exports.length;
  const gate = bridge.gate('read', p => p === source.path); let current = true;
  const pending = prepared.prepareExport(() => current), cancelled = assert.rejects(pending, { code: 'CANCELLED' });
  await gate.started; current = false; gate.release(); await cancelled;
  assert.equal(bridge.exports.length, before); assert.deepEqual(readFileSync(prepared.exportPath!), overview);
  const path = await prepared.prepareExport(() => true), png = PNG.sync.read(readFileSync(path));
  assert.deepEqual([png.width, png.height], [prepared.exportSize.width, prepared.exportSize.height]);
  assert.notEqual(path, prepared.exportPath); const reads = bridge.reads.length;
  assert.equal(await prepared.prepareExport(() => true), path); assert.equal(bridge.reads.length, reads);
  assert.deepEqual(readFileSync(prepared.exportPath!), overview);
  assert.deepEqual([canvas.width, canvas.height], [1, 1]);
});

test('Node bridge PDF: overlapping native viewers retain their copy until every callback settles', async () => {
  const prepared = await preparePreview(bridge.file('overlapping.ai', await aiContainer()), new NodeCanvas().native());
  const requests: any[] = [];
  (wx as any).openDocument = (options: any) => { requests.push(options); };
  const first = openAiDocument(prepared.documentPath!), second = openAiDocument(prepared.documentPath!);
  const failed = assert.rejects(second, { code: 'PLATFORM_ERROR' });
  assert.equal(requests.length, 2);
  await cleanupPreview(); assert.ok(existsSync(prepared.documentPath!));
  requests[0].success(); await first; assert.ok(existsSync(prepared.documentPath!));
  requests[1].fail({ errMsg: 'openDocument:fail native error' }); await failed;
  assert.equal(existsSync(prepared.documentPath!), false);
});

test('Node bridge AI: source inspection is bounded and PDF creation uses the official native copy API', async () => {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.create(); doc.addPage();
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(
    'Illustrator project-generated metadata ' + ' '.repeat(200000), { Type: 'Metadata', Subtype: 'XML' })));
  const bytes = await doc.save({ useObjectStreams: false }), source = bridge.file('bounded.ai', bytes);
  const result = await preparePreview(source, new NodeCanvas().native());
  assert.equal(bridge.copies.length, 1); assert.equal(bridge.copies[0].source, source.path);
  assert.equal(bridge.copies[0].destination, result.documentPath);
  assert.ok(bridge.reads.every(read => read.length <= 65536 && read.length < bytes.length));
  assert.deepEqual(readFileSync(result.documentPath!), Buffer.from(bytes));
});

test('Node bridge AI: cancelled native copying retains its target until completion and cleans late output', async () => {
  const source = bridge.file('cancel-copy.ai', await aiContainer()), gate = bridge.gate('write', p => p.endsWith('.pdf'));
  const task = preparePreview(source, new NodeCanvas().native()), rejected = assert.rejects(task, { code: 'CANCELLED' });
  await gate.started; const target = bridge.copies[0].destination;
  await cleanupPreview(); assert.ok(existsSync(target));
  gate.release(); await rejected;
  assert.equal(existsSync(target), false); assert.ok(existsSync(source.path));
});

test('Node bridge AI: oversized files stop before copying; unavailable or corrupt copies fail safely', async () => {
  const source = bridge.file('oversized.ai', await aiContainer());
  bridge.stats.set(source.path, 33 * 1024 * 1024);
  await assert.rejects(preparePreview(source, new NodeCanvas().native()), { code: 'FILE_TOO_LARGE' });
  assert.equal(bridge.copies.length, 0); assert.ok(bridge.reads.every(r => r.length <= 26));
  bridge.stats.delete(source.path);
  const manager = wx.getFileSystemManager() as any, copy = manager.copyFile;
  manager.copyFile = undefined;
  await assert.rejects(preparePreview(source, new NodeCanvas().native()), { code: 'API_UNAVAILABLE' });
  manager.copyFile = (options: any) => { writeFileSync(options.destPath, 'partial'); options.success(); };
  await assert.rejects(preparePreview(source, new NodeCanvas().native()), { code: 'TRUNCATED' });
  assert.equal(readdirSync(join(bridge.userData, 'quickview-v1')).filter(p => p.endsWith('.pdf')).length, 0);
  manager.copyFile = copy;
});
