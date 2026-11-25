import { checkFileSize, detectFormat, inspectAiFile, isTiffHeader, RAW_EXTENSIONS, type FileInfo } from '../core/files';
import { readCameraRawDirectory, readCameraRawPreview, rawPreviewJpeg } from '../core/camera-raw';
import { autoRawTone } from '../core/raw-auto';
import { rawExposure } from '../core/raw-exposure';
import { openRawSensor } from '../core/camera-raw-sensor';
import { rawEngine, rawFailureMessage } from './raw-engine';
import { previewReader } from '../core/preview-reader';
import { decodePhotoshop, readPhotoshopHeader, type PhotoshopHeader } from '../core/photoshop';
import { readPhotoshopThumbnail } from '../core/photoshop-thumbnail';
import { openPhotoshopComposite, type PhotoshopRegion, type CompositeSession } from '../core/photoshop-preview';
import { writePngRows, type PngRowSource } from '../core/png-stream';
import { parseSvg } from '../core/svg';
import { decodeTiff } from '../core/tiff';
import { inspectTiffFile, previewRawTiff, rawTiffRows } from '../core/tiff-preview';
import { checkImageBudget, LIMITS, QuickViewError, utf8ByteLength } from '../core/shared';

export type ImportSource = 'chat-file' | 'chat-image' | 'chat-all' | 'album';
export interface ChosenFile { path: string; name: string; size: number; source?: ImportSource | 'chat-open'; reportedType?: string }
export interface PhotoshopDetail {
  width: number; height: number;
  previewWidth?: number;
  render(rect: PhotoshopRegion, output: { width: number; height: number }, isCurrent: () => boolean): Promise<string>;
  release(path: string): Promise<void>;
}
export interface PreparedPreview { info: FileInfo; previewPath?: string; exportPath?: string; documentPath?: string; detail?: PhotoshopDetail;
  svgAnimation?: import('../core/svg-animation').SvgAnimation;
  rawJpeg?: { path: string; width: number; height: number };
  originalImage?: 'JPEG' | 'PNG';
  rawOriginalPath?: string; rawAutoPath?: string;
  setRawAuto?: (enabled: boolean) => void;
  exportSize?: { width: number; height: number };
  prepareNative?: (isCurrent: () => boolean, progress: (rows: number) => void) => Promise<string>;
  prepareExport?: (isCurrent: () => boolean) => Promise<string> }
export type PreviewStage = 'metadata' | 'preview' | 'document' | 'raw-engine' | 'raw-metadata' | 'raw-overview' | 'raw-auto' | 'raw-png';
export { startSvgPlayback } from './svg-player';
type PreviewCallback = (stage: PreviewStage, overview?: { path: string }, progress?: number) => void;

const fs = () => wx.getFileSystemManager();
const directory = () => `${wx.env.USER_DATA_PATH}/quickview-v1`;
const generatedPngs = new Set<string>();
const ownedPdfs = new Set<string>();
const ownedJpegs = new Set<string>();
const pdfReaders = new Map<string, number>();
const pendingPdfDeletes = new Set<string>();
// Official setData limit is 1024 kB; base64 expands by 4/3. Reserve room for page metadata.
const SVG_PREVIEW_BYTES = 512 * 1024;
let generation = 0;
let cleanupTask: Promise<void> = Promise.resolve();

function nativeError(error: WechatMiniprogram.GeneralCallbackResult, fallback: string): Error {
  const detail = error.errMsg || '';
  const errno = (error as WechatMiniprogram.GeneralCallbackResult & { errno?: number }).errno;
  if (errno === 112 || /privacy.*banned|appid.*privacy.*api/i.test(detail)) return new QuickViewError('PRIVACY_CONFIG', '小程序尚未完成微信隐私接口声明，当前功能不可用，请联系开发者。');
  if (errno === 103 || errno === 104 || /privacy.*(?:deny|reject|cancel)/i.test(detail)) return new QuickViewError('PRIVACY_DENIED', '你尚未同意微信的隐私授权，未读取或保存文件；可再次主动选择后授权。');
  if (/memory|alloc|out of/i.test(detail)) return new QuickViewError('DEVICE_MEMORY', '当前设备内存不足，请关闭其他小程序或选择更小的文件。');
  if (/no such|not exist|ENOENT/i.test(detail)) return new QuickViewError('FILE_EXPIRED', '本地临时文件已失效，请从聊天中重新选择。');
  if (errno === 1300202 || /space|quota|ENOSPC/i.test(detail)) return new QuickViewError('STORAGE_FULL', '微信本地存储空间不足或文件超过平台限制，请清理后重试。');
  return new QuickViewError('PLATFORM_ERROR', fallback);
}

async function statSize(path: string): Promise<number> {
  return new Promise((resolve, reject) => fs().stat({ path, recursive: false,
    success: result => {
      if (Array.isArray(result.stats) || !result.stats.isFile()) return reject(new QuickViewError('NOT_FILE', '所选路径不是文件。'));
      resolve(result.stats.size);
    }, fail: error => reject(nativeError(error, '无法读取文件信息，请重新选择。')),
  }));
}

async function readRange(path: string, length: number, position = 0): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 1
    || !Number.isSafeInteger(position + length)) throw new QuickViewError('INVALID_READ_RANGE', '文件读取范围无效。');
  return new Promise((resolve, reject) => fs().readFile({ filePath: path, position, length,
    success: result => {
      // Native bridges can return an ArrayBuffer from a different JavaScript realm.
      if (typeof result.data === 'string' || result.data.byteLength !== length) return reject(new QuickViewError('TRUNCATED', '文件读取不完整，请重新选择。'));
      resolve(result.data);
    }, fail: error => reject(nativeError(error, '无法读取本地文件。')),
  }));
}

async function ensureDirectory(): Promise<void> {
  try { fs().accessSync(directory()); }
  catch { await new Promise<void>((resolve, reject) => fs().mkdir({ dirPath: directory(), recursive: true, success: () => resolve(), fail: error => reject(nativeError(error, '无法创建本地临时目录。')) })); }
}

async function writeOwned(data: string | ArrayBuffer, suffix: 'svg' | 'pdf' | 'jpg'): Promise<string> {
  await ensureDirectory();
  const path = `${directory()}/qv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${suffix}`;
  await new Promise<void>((resolve, reject) => fs().writeFile({ filePath: path, data, encoding: 'utf8', success: () => resolve(), fail: error => reject(nativeError(error, '无法写入本地预览副本。')) }));
  if (suffix === 'jpg') ownedJpegs.add(path);
  return path;
}

async function copyOwnedPdf(source: string, size: number, token: number, ownedPaths: string[]): Promise<string> {
  const manager = fs();
  if (typeof manager.copyFile !== 'function') throw new QuickViewError('API_UNAVAILABLE', '当前微信不支持本地文件复制，请升级微信后重试。');
  await ensureDirectory();
  assertCurrent(token);
  const path = `${directory()}/qv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.pdf`;
  ownedPaths.push(path); // Register before I/O; a cancelled native copy may finish late.
  const release = holdPdf(path);
  try {
    await new Promise<void>((resolve, reject) => manager.copyFile({ srcPath: source, destPath: path,
      success: () => resolve(), fail: error => reject(nativeError(error, '无法创建本地 PDF 副本。')) }));
    assertCurrent(token);
    if (await statSize(path) !== size) throw new QuickViewError('TRUNCATED', 'PDF 副本长度不符，请重新选择文件。');
    assertCurrent(token);
    ownedPdfs.add(path);
    return path;
  } finally { await release(); }
}

function removeFile(path: string): Promise<void> {
  if (pdfReaders.has(path)) { pendingPdfDeletes.add(path); return Promise.resolve(); }
  ownedPdfs.delete(path);
  ownedJpegs.delete(path);
  return new Promise(resolve => fs().unlink({ filePath: path, complete: () => resolve() }));
}

function holdPdf(path: string): () => Promise<void> {
  pdfReaders.set(path, (pdfReaders.get(path) || 0) + 1);
  return async () => {
    const remaining = pdfReaders.get(path)! - 1;
    if (remaining) pdfReaders.set(path, remaining);
    else {
      pdfReaders.delete(path);
      if (pendingPdfDeletes.delete(path)) await removeFile(path);
    }
  };
}

// Deletes our own named derivatives only. Chosen source paths are never recorded here.
export function cleanupPreview(): Promise<void> {
  generation++;
  const pngs = [...generatedPngs];
  generatedPngs.clear();
  cleanupTask = cleanupTask.then(async () => {
    await Promise.all(pngs.map(removeFile));
    const files = await new Promise<string[]>(resolve => fs().readdir({ dirPath: directory(), success: result => resolve(result.files), fail: () => resolve([]) }));
    await Promise.all(files.filter(name => /^qv_[a-zA-Z0-9_]+\.(?:pdf|svg|jpg|png)$/.test(name)).map(name => removeFile(`${directory()}/${name}`)));
  });
  return cleanupTask;
}

export async function discardGeneratedPng(path: string): Promise<void> {
  if (generatedPngs.delete(path)) await removeFile(path);
}

const importLabels = { 'chat-file': '从微信聊天选择文件', 'chat-image': '从微信聊天选择图片',
  'chat-all': '从微信聊天选择文件', 'chat-open': '从聊天直接打开', album: '相册原图（实际格式以返回为准）' };
function pickerFailure(error: WechatMiniprogram.GeneralCallbackResult, fallback: string): Error {
  const failure = nativeError(error, fallback);
  return failure instanceof QuickViewError && failure.code.startsWith('PRIVACY_') ? failure
    : /cancel/i.test(error.errMsg) ? new Error('已取消选择') : failure;
}

function pickerResultError(source: ImportSource, files: unknown, file: unknown, code: 'NO_FILE_EMPTY_LIST' | 'NO_FILE_PATH_MISSING') {
  const field = (value: unknown): string => value === undefined ? 'missing' : typeof value === 'string' ? value ? 'string' : 'empty' : 'other';
  // Structure only: never include returned names, paths, metadata or native error text.
  // Array shape is diagnostic information, not an admission check for a valid path.
  const array = Array.isArray(files), list = array ? 'array' : files === undefined ? 'missing' : 'other';
  const count = array ? files.length === 0 ? '0' : files.length === 1 ? '1' : 'many' : 'unknown';
  const entry = file as { path?: unknown; tempFilePath?: unknown } | undefined;
  const pickerDiagnostic = `source=${source};list=${list};count=${count};path=${field(entry?.path)};tempFilePath=${field(entry?.tempFilePath)}`;
  const message = code === 'NO_FILE_EMPTY_LIST' ? '微信选择器返回的文件条目为空，请重新选择。' : '微信选择器未提供有效的本地文件路径，请重新选择。';
  return Object.assign(new QuickViewError(code, message), { pickerDiagnostic });
}

export function chooseDesignFile(source: ImportSource = 'chat-file'): Promise<ChosenFile> {
  const base = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
  const sdk = (base.SDKVersion || '').split('.').map(Number);
  if (!sdk.length || !Number.isFinite(sdk[0])
    || sdk[0] < 2 || (sdk[0] === 2 && (sdk[1] || 0) < 11)) {
    return Promise.reject(new QuickViewError('SDK_TOO_OLD', '需要微信基础库 2.11.0 或以上，请升级微信后重试。'));
  }
  const nameOnly = (name: string) => name.split(/[\\/]/).pop()!.slice(0, 200);
  if (source === 'album') {
    if (typeof wx.chooseMedia !== 'function' || !wx.canIUse('chooseMedia')) return Promise.reject(new QuickViewError('API_UNAVAILABLE', '当前微信无法选择相册原图。请从聊天以文件形式导入 RAW 原稿。'));
    return new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original'],
      success: result => {
        const file = result?.tempFiles?.[0];
        if (!file) return reject(pickerResultError(source, result?.tempFiles, file, 'NO_FILE_EMPTY_LIST'));
        if (typeof file.tempFilePath !== 'string' || !file.tempFilePath) return reject(pickerResultError(source, result?.tempFiles, file, 'NO_FILE_PATH_MISSING'));
        resolve({ path: file.tempFilePath, name: '相册图片', size: file.size, source, reportedType: result.type });
      }, fail: error => reject(pickerFailure(error, '无法从相册选择图片，请从聊天以文件形式导入原始 RAW。')),
    }));
  }
  if (!['chat-file', 'chat-image', 'chat-all'].includes(source) || typeof wx.chooseMessageFile !== 'function' || !wx.canIUse('chooseMessageFile')) {
    return Promise.reject(new QuickViewError('API_UNAVAILABLE', '当前微信无法从聊天选择，请升级微信后重试。'));
  }
  return new Promise((resolve, reject) => wx.chooseMessageFile({ count: 1, type: source === 'chat-file' ? 'file' : source === 'chat-image' ? 'image' : 'all',
    ...(source === 'chat-file' ? { extension: [...RAW_EXTENSIONS, 'psd', 'psb', 'tif', 'tiff', 'ai', 'svg', 'jpg', 'jpeg', 'png'] } : {}),
    success: result => {
      const file = result?.tempFiles?.[0];
      if (!file) return reject(pickerResultError(source, result?.tempFiles, file, 'NO_FILE_EMPTY_LIST'));
      if (typeof file.path !== 'string' || !file.path) return reject(pickerResultError(source, result?.tempFiles, file, 'NO_FILE_PATH_MISSING'));
      resolve({ path: file.path, name: nameOnly(typeof file.name === 'string' && file.name ? file.name : file.path), size: file.size,
        ...(source !== 'chat-file' ? { source, reportedType: file.type } : {}) });
    },
    fail: error => {
      reject(pickerFailure(error, '无法从微信聊天选择文件或图片。'));
    },
  }));
}

function importNote(file: ChosenFile, format: string, size: number): string {
  const extension = (file.source === 'album' ? file.path : file.name).match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() || '无';
  return `来源：${importLabels[file.source || 'chat-file']}；${file.source === 'album' ? '接口未提供原文件名；' : ''}返回后缀：${extension}；实际格式：${format}；实际大小：${size} 字节。`;
}

async function originalImagePreview(file: ChosenFile, size: number, format: 'JPEG' | 'PNG', token: number): Promise<PreparedPreview> {
  checkFileSize(format, size);
  if (typeof wx.getImageInfo !== 'function') throw new QuickViewError('API_UNAVAILABLE', `取得的是 ${format} 图像，原始 RAW 不可用；当前微信无法读取图像信息，请升级后重试。`);
  const image = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) => wx.getImageInfo({ src: file.path,
    success: resolve, fail: error => reject(nativeError(error, `实际取得的是 ${format} 图像，原始 RAW 不可用；微信无法解码该图片。`)),
  }));
  assertCurrent(token);
  if (typeof image.type !== 'string' || !(format === 'JPEG' ? ['jpg', 'jpeg'] : ['png']).includes(image.type.toLowerCase())) {
    throw new QuickViewError('INVALID_IMAGE', '图片文件头与原生解码结果不一致，已停止预览。');
  }
  try { checkImageBudget(image.width, image.height, size); }
  catch (error) { throw new QuickViewError('IMAGE_BUDGET', `取得的是 ${format} 图像，原始 RAW 不可用。${error instanceof Error ? error.message : '图片超出安全预算。'}`); }
  if (await statSize(file.path) !== size) throw new QuickViewError('FILE_CHANGED', '返回的图片已变化，请重新选择。');
  assertCurrent(token);
  const rotated = ['left', 'right', 'left-mirrored', 'right-mirrored'].includes(image.orientation);
  const width = rotated ? image.height : image.width, height = rotated ? image.width : image.height;
  return { info: { format, filename: file.name, filesize: size, width, height, previewAvailable: true,
    exportSupported: typeof wx.saveImageToPhotosAlbum === 'function' && wx.canIUse('saveImageToPhotosAlbum'), warnings: [
      importNote(file, format, size), `实际可用图像：${width} × ${height} px。取得的是普通 ${format} 图像，原始 RAW 不可用，不启用传感器显影或 RAW 高清。`,
      '相册“原图”或聊天图片可能仍是转换图/预览副本；如需 RAW，请将相机原稿以文件形式发送后从聊天文件导入。',
      '应用直接使用并保存微信返回的图片路径，不压缩、不改写像素、不转换为 PNG；相册最终保存行为以微信实际结果为准。',
    ] }, originalImage: format, previewPath: file.path, exportPath: file.path, exportSize: { width, height } };
}

function assertCurrent(token: number): void {
  if (token !== generation) throw new QuickViewError('CANCELLED', '已关闭此次预览。');
}

/** Capability is checked per operation; older clients retain preview PNG saving. */
function nativePngAvailable(): boolean {
  const manager = fs();
  return ['open', 'write', 'close'].every(name => typeof (manager as unknown as Record<string, unknown>)[name] === 'function');
}

function nativeExporter(file: ChosenFile, size: number, header: PhotoshopHeader, token: number,
  session?: CompositeSession): PreparedPreview['prepareNative'] {
  if (!nativePngAvailable() || header.colorModeId !== 3
    || !(header.bitDepth === 8 && header.channels === 3 || header.bitDepth === 16 && header.version === 1)) return;
  return nativePngExporter(file, size, token, read => session || openPhotoshopComposite(read, size, header,
    { rgb16Raw: header.bitDepth === 16, rgb16RawBatchRows: 16 }));
}

function nativePngExporter(file: ChosenFile, size: number, token: number,
  openSource: (read: (offset: number, length: number) => Promise<Uint8Array>) => PngRowSource | Promise<PngRowSource>): PreparedPreview['prepareNative'] {
  if (!nativePngAvailable()) return;
  let active = false;
  return async (isCurrent, progress) => {
    const current = () => { assertCurrent(token); if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消原尺寸 PNG 导出。'); return true; };
    current();
    if (active) throw new QuickViewError('EXPORT_BUSY', '正在生成原尺寸 PNG。');
    active = true;
    let path = '', fd = '', complete = false, created = false;
    let release = async () => {};
    const manager = fs();
    try {
      if (!nativePngAvailable()) throw new QuickViewError('API_UNAVAILABLE', '当前微信不支持流式文件写入，请升级微信。');
      if (await statSize(file.path) !== size) throw new QuickViewError('FILE_CHANGED', '原稿大小已变化，请重新选择。');
      current();
      const read = async (offset: number, length: number) => {
        current(); const bytes = new Uint8Array(await readRange(file.path, length, offset)); current(); return bytes;
      };
      const composite = await openSource(read);
      current(); await ensureDirectory(); current();
      path = `${directory()}/qv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.png`;
      release = holdPdf(path); // The same file lease protects writes and album saves.
      fd = await new Promise<string>((resolve, reject) => manager.open({ filePath: path, flag: 'wx',
        success: result => resolve(result.fd), fail: error => reject(nativeError(error, '无法创建原尺寸 PNG 文件。')) }));
      created = true;
      let position = 0;
      const write = async (chunk: Uint8Array) => {
        for (let offset = 0; offset < chunk.length;) {
          current();
          // Native ArrayBuffer does not carry a view's byteOffset; copy only this bounded fragment.
          const data = chunk.slice(offset, offset + 64 * 1024).buffer as ArrayBuffer;
          const count = await new Promise<number>((resolve, reject) => manager.write({ fd, data, position,
            success: result => resolve(result.bytesWritten), fail: error => reject(nativeError(error, '原尺寸 PNG 写入失败。')) }));
          if (!Number.isSafeInteger(count) || count < 1 || count > data.byteLength) throw new QuickViewError('SHORT_WRITE', 'PNG 写入未取得有效进展。');
          offset += count; position += count;
          current();
        }
      };
      await writePngRows(composite.width, composite.height, composite.nativeChannels,
        consume => composite.readRows(consume, { isCurrent: current }), write,
        { isCurrent: current, srgb: composite.nativeSrgb, onProgress: progress });
      await new Promise<void>((resolve, reject) => manager.close({ fd,
        success: () => resolve(), fail: error => reject(nativeError(error, '无法完成 PNG 文件关闭。')) }));
      fd = '';
      current();
      if (await statSize(path) !== position || position < 57) throw new QuickViewError('INVALID_PNG', 'PNG 文件长度校验失败。');
      const head = new Uint8Array(await readRange(path, 29));
      const tail = new Uint8Array(await readRange(path, 12, position - 12));
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      if (!head.subarray(0, 8).every((b, i) => b === [137,80,78,71,13,10,26,10][i])
        || view.getUint32(8) !== 13 || String.fromCharCode(...head.subarray(12, 16)) !== 'IHDR'
        || view.getUint32(16) !== composite.width || view.getUint32(20) !== composite.height || head[24] !== 8 || head[25] !== (composite.nativeChannels === 4 ? 6 : 2)
        || !tail.every((b, i) => b === [0,0,0,0,73,69,78,68,174,66,96,130][i])) {
        throw new QuickViewError('INVALID_PNG', 'PNG 头部、尺寸或结尾校验失败。');
      }
      current(); complete = true; generatedPngs.add(path);
      return path;
    } finally {
      if (fd) await new Promise<void>(resolve => manager.close({ fd, complete: () => resolve() }));
      if (created && !complete) await removeFile(path);
      await release();
      active = false;
    }
  };
}

async function canvasPng(canvas: WechatMiniprogram.Canvas): Promise<string> {
  const path = await new Promise<string>((resolve, reject) => wx.canvasToTempFilePath({ canvas, fileType: 'png',
    destWidth: canvas.width, destHeight: canvas.height,
    success: result => resolve(result.tempFilePath), fail: error => reject(nativeError(error, '当前设备无法导出此图像为 PNG。')),
  }));
  generatedPngs.add(path);
  return path;
}

async function rasterPng(canvas: WechatMiniprogram.Canvas, image: { width: number; height: number; pixels: Uint8ClampedArray }): Promise<string> {
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d');
  const data = context.createImageData(image.width, image.height);
  data.data.set(image.pixels);
  context.putImageData(data, 0, 0);
  return canvasPng(canvas);
}

async function rawJpegPixels(canvas: WechatMiniprogram.Canvas, jpeg: Uint8Array,
  width: number, height: number, orientation: number, token: number, ownedPaths: string[], side: number = LIMITS.canvasSide) {
  const context = canvas.getContext('2d');
  if (typeof context.getImageData !== 'function' || typeof context.setTransform !== 'function') {
    throw new QuickViewError('RAW_AUTO_UNAVAILABLE', '当前 Canvas 不支持自动优化。');
  }
  // Disable EXIF auto-rotation for Canvas; apply the container direction exactly once.
  const source = await writeOwned(rawPreviewJpeg(jpeg, 1).buffer as ArrayBuffer, 'jpg');
  ownedPaths.push(source);
  try {
    assertCurrent(token);
    const image = canvas.createImage();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timeout); image.onload = () => {}; image.onerror = () => {}; error ? reject(error) : resolve(); };
      const timeout = setTimeout(() => finish(new QuickViewError('RAW_AUTO_UNAVAILABLE', '自动预览图片加载超时。')), 8000);
      image.onload = () => finish();
      image.onerror = () => finish(new QuickViewError('RAW_AUTO_UNAVAILABLE', '当前设备无法处理此自动预览。'));
      image.src = source;
    });
    assertCurrent(token);
    const scale = Math.min(1, side / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    canvas.width = orientation >= 5 ? h : w; canvas.height = orientation >= 5 ? w : h;
    const transforms = [[1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, w, 0], [-1, 0, 0, -1, w, h],
      [1, 0, 0, -1, 0, h], [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, h, 0],
      [0, -1, -1, 0, h, w], [0, -1, 1, 0, 0, w]][orientation - 1];
    context.setTransform(transforms[0], transforms[1], transforms[2], transforms[3], transforms[4], transforms[5]);
    context.drawImage(image, 0, 0, w, h);
    context.setTransform(1, 0, 0, 1, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    context.setTransform(1, 0, 0, 1, 0, 0);
    await removeFile(source);
  }
}

async function rawAutoPreview(canvas: WechatMiniprogram.Canvas, jpeg: Uint8Array,
  width: number, height: number, orientation: number, token: number, ownedPaths: string[]) {
  const context = canvas.getContext('2d');
  try {
    const pixels = await rawJpegPixels(canvas, jpeg, width, height, orientation, token, ownedPaths);
    assertCurrent(token);
    context.putImageData(pixels, 0, 0);
    const originalPath = await canvasPng(canvas); ownedPaths.push(originalPath); assertCurrent(token);
    const result = autoRawTone(pixels.data);
    assertCurrent(token);
    if (!result.changed) return { path: originalPath, originalPath, width: canvas.width, height: canvas.height, changed: false, reason: result.reason };
    context.putImageData(pixels, 0, 0);
    const path = await canvasPng(canvas);
    ownedPaths.push(path);
    assertCurrent(token);
    return { path, originalPath, width: canvas.width, height: canvas.height, changed: true };
  } finally {
    canvas.width = 1; canvas.height = 1;
  }
}

async function sensorRawPreview(file: ChosenFile, size: number, image: Awaited<ReturnType<typeof readCameraRawPreview>>,
  canvas: WechatMiniprogram.Canvas, token: number, ownedPaths: string[], onStage?: PreviewCallback): Promise<PreparedPreview> {
  const read = async (offset: number, length: number) => {
    assertCurrent(token); const bytes = new Uint8Array(await readRange(file.path, length, offset)); assertCurrent(token); return bytes;
  };
  onStage?.('raw-engine');
  const engine = await rawEngine(); assertCurrent(token);
  onStage?.('raw-metadata');
  const session = await openRawSensor(read, size, image.directories, engine, () => token === generation);
  const scale = Math.min(1, LIMITS.canvasSide / Math.max(session.width, session.height));
  const dimensions = { width: Math.max(1, Math.round(session.width * scale)), height: Math.max(1, Math.round(session.height * scale)) };
  const region = { x: 0, y: 0, width: session.width, height: session.height };
  let raster = await session.render(region, dimensions, () => token === generation,
    undefined, (completed, total) => onStage?.('raw-overview', undefined, Math.floor(completed / total * 100)));
  onStage?.('raw-png');
  const original = await rasterPng(canvas, raster); ownedPaths.push(original); assertCurrent(token);
  let exposure = 0, exposureWarning = '';
  onStage?.('raw-auto', undefined, 0);
  try {
    const reference = await rawJpegPixels(canvas, image.jpeg, image.width, image.height, image.orientation, token, ownedPaths, 96);
    assertCurrent(token);
    exposure = rawExposure(raster.pixels, reference.data);
  } catch (error) {
    assertCurrent(token);
    exposureWarning = '相机亮度参考不可用，未自动提高 RAW 曝光；可查看相机 JPEG。';
  } finally { canvas.width = 1; canvas.height = 1; }
  if (exposure) {
    session.setExposure(exposure);
    raster = await session.render(region, dimensions, () => token === generation, undefined,
      (completed, total) => onStage?.('raw-auto', undefined, Math.floor(completed / total * 100)));
  }
  const adjustment = autoRawTone(raster.pixels, undefined, exposure > 0);
  let optimized = '';
  if (exposure || adjustment.changed) {
    onStage?.('raw-png');
    optimized = await rasterPng(canvas, raster); ownedPaths.push(optimized); assertCurrent(token);
  }
  let enabled = !!optimized;
  session.setTone(enabled ? adjustment.tone : undefined);
  let rendering = false;
  const paths = new Set<string>();
  const detail: PhotoshopDetail = { width: session.width, height: session.height, previewWidth: dimensions.width,
    async release(path) { if (paths.delete(path)) await discardGeneratedPng(path); },
    async render(rect, output, isCurrent) {
      const current = () => { assertCurrent(token); return isCurrent(); };
      if (rendering) throw new QuickViewError('PREVIEW_BUSY', '正在读取上一处 RAW 高清局部。');
      if (output.width > LIMITS.canvasSide || output.height > LIMITS.canvasSide) throw new QuickViewError('INVALID_REGION', 'RAW 高清画布尺寸超出预算。');
      rendering = true; let path = '';
      try {
        const raster = await session.render(rect, output, current);
        if (!current()) throw new QuickViewError('CANCELLED', 'RAW 视口已变化。');
        path = await rasterPng(canvas, raster); paths.add(path);
        if (!current()) throw new QuickViewError('CANCELLED', 'RAW 视口已变化。');
        return path;
      } catch (error) { if (path) await detail.release(path); throw error; }
      finally { canvas.width = 1; canvas.height = 1; rendering = false; }
    },
  };
  canvas.width = 1; canvas.height = 1;
  return { info: { format: 'RAW', filename: file.name, filesize: size, width: session.width, height: session.height,
    colorMode: 'RGB 显影', bitDepth: 14, previewAvailable: true, exportSupported: true, warnings: [
      `传感器显影概览：${dimensions.width} × ${dimensions.height} px；放大后读取实际 Bayer 像素与相邻像素，不放大相机 JPEG 冒充高清。`,
      exposureWarning || (exposure ? `自动显影：参考相机 JPEG 全局亮度，在线性阶段补偿 +${exposure.toFixed(2)} EV，并保护采样高光；概览、局部与原尺寸 PNG 共用参数。`
        : '未自动提高线性曝光；保留基础显影，避免将夜景强制提亮。'),
      'FlashRaw 相机白平衡、双线性去马赛克与 sRGB 转换；全局曝光和受限明暗优化不是 Adobe Camera Raw 算法，不提供降噪或高光重建。',
      `原尺寸 PNG 为有效画面 ${session.width} × ${session.height} px、8 位 RGB，按当前自动优化状态导出；不保留14位传感器编辑数据。竖图全尺寸导出读取较多，可能较慢，可取消。`,
    ] }, previewPath: optimized || original, exportPath: optimized || original, exportSize: dimensions, detail,
    rawOriginalPath: optimized ? original : undefined, rawAutoPath: optimized || undefined,
    setRawAuto(value) { enabled = value && !!optimized; session.setTone(enabled ? adjustment.tone : undefined); session.setExposure(enabled ? exposure : 0); },
    prepareExport: async current => { assertCurrent(token); if (!current()) throw new QuickViewError('CANCELLED', '已取消 RAW 预览保存。'); return enabled ? optimized : original; },
    prepareNative: nativePngExporter(file, size, token, async () => session),
  };
}

async function largePhotoshopPreview(file: ChosenFile, size: number, header: PhotoshopHeader,
  canvas: WechatMiniprogram.Canvas, token: number, ownedPaths: string[]): Promise<PreparedPreview> {
  const direct = async (offset: number, length: number) => {
    assertCurrent(token);
    const bytes = new Uint8Array(await readRange(file.path, length, offset));
    assertCurrent(token);
    return bytes;
  };
  const ahead = previewReader(direct, size, () => token === generation);
  let overview = false;
  const read = (offset: number, length: number) => overview && size > LIMITS.photoshopBytes
    ? ahead.read(offset, length) : direct(offset, length);
  const info: FileInfo = { format: header.format, filename: file.name, filesize: size,
    width: header.width, height: header.height, colorMode: header.colorMode, bitDepth: header.bitDepth,
    previewAvailable: true, exportSupported: false, warnings: [] };
  let thumbnail: Awaited<ReturnType<typeof readPhotoshopThumbnail>> | undefined;
  let thumbnailError: unknown;
  try { thumbnail = await readPhotoshopThumbnail(read, size, header); }
  catch (error) { assertCurrent(token); thumbnailError = error; }
  try {
    const rgb16Raw = header.version === 1 && header.colorModeId === 3 && header.bitDepth === 16;
    const composite = await openPhotoshopComposite(read, size, header, { rgb16Raw, rgb16RawBatchRows: 16 });
    const scale = Math.min(1, LIMITS.canvasSide / Math.max(header.width, header.height));
    let image: Awaited<ReturnType<typeof composite.decodeRegion>>;
    try {
      overview = true;
      image = await composite.decodeRegion({ x: 0, y: 0, width: header.width, height: header.height },
        { width: Math.max(1, Math.round(header.width * scale)), height: Math.max(1, Math.round(header.height * scale)) }, { overview: true });
    } finally { overview = false; ahead.clear(); }
    assertCurrent(token);
    const previewPath = await rasterPng(canvas, image);
    const previewWidth = image.width, previewHeight = image.height;
    ownedPaths.push(previewPath);
    assertCurrent(token);
    info.exportSupported = true;
    const overviewSize = `${image.width} × ${image.height} px`;
    const overviewLabel = image.width === header.width && image.height === header.height ? '合成图概览' : '降采样概览（非原尺寸）';
    info.warnings = [`${overviewLabel}：${overviewSize}。放大后按可见区域读取原图像素。`, ...image.warnings];
    const detailPaths = new Set<string>();
    let rendering = false;
    const release = async (path: string) => {
      if (!detailPaths.delete(path)) return;
      generatedPngs.delete(path);
      await removeFile(path);
    };
    const detail: PhotoshopDetail = { width: header.width, height: header.height, release,
      ...(rgb16Raw ? { previewWidth: image.width } : {}),
      async render(rect, output, isCurrent) {
        const current = () => {
          assertCurrent(token);
          if (!isCurrent()) throw new QuickViewError('CANCELLED', '视口已变化。');
        };
        current();
        if (rgb16Raw && (![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
          || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
          || rect.x + rect.width > header.width || rect.y + rect.height > header.height
          || ![output.width, output.height].every(Number.isSafeInteger)
          || output.width < 1 || output.height < 1 || output.width > LIMITS.canvasSide || output.height > LIMITS.canvasSide
          || output.width > rect.width || output.height > rect.height)) {
          throw new QuickViewError('INVALID_REGION', 'RGB16 高清区域须位于原图内，输出不放大源像素且单边不超过 1365 像素。');
        }
        if (rendering) throw new QuickViewError('PREVIEW_BUSY', '正在读取上一处高清局部。');
        rendering = true;
        let path = '';
        try {
          const raster = await composite.decodeRegion(rect, output, { isCurrent });
          current();
          path = await rasterPng(canvas, raster);
          detailPaths.add(path);
          current();
          return path;
        } catch (error) {
          if (path) await release(path);
          throw error;
        } finally {
          canvas.width = 1; canvas.height = 1;
          rendering = false;
        }
      },
    };
    let qualityPath = '';
    const prepareExport = async (isCurrent: () => boolean) => {
      const current = () => { assertCurrent(token); if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消 PNG 生成。'); };
      current();
      if (qualityPath) return qualityPath;
      if (rendering) throw new QuickViewError('PREVIEW_BUSY', '正在读取高清局部，请稍后保存。');
      rendering = true;
      let path = '';
      try {
        const raster = await composite.decodeRegion({ x: 0, y: 0, width: header.width, height: header.height },
          { width: previewWidth, height: previewHeight }, { overview: true, quality: 'area', isCurrent });
        current(); path = await rasterPng(canvas, raster); current();
        qualityPath = path;
        return path;
      } catch (error) {
        if (path) { generatedPngs.delete(path); await removeFile(path); }
        throw error;
      } finally { canvas.width = 1; canvas.height = 1; rendering = false; }
    };
    return { info, previewPath, exportPath: previewPath, exportSize: { width: previewWidth, height: previewHeight }, detail, prepareExport,
      prepareNative: nativeExporter(file, size, header, token, composite) };
  } catch (error) {
    assertCurrent(token);
    if (!thumbnail) {
      const detail = error instanceof Error ? error.message : '无法生成降采样合成图。';
      const fallback = thumbnailError instanceof Error ? thumbnailError.message : '没有可用的内嵌缩略图。';
      throw new QuickViewError('PHOTOSHOP_PREVIEW_UNAVAILABLE', `${detail} ${fallback}`);
    }
    const previewPath = await writeOwned(thumbnail.jpeg.slice().buffer as ArrayBuffer, 'jpg');
    ownedPaths.push(previewPath);
    assertCurrent(token);
    info.warnings = [`低分辨率预览：文件内嵌 JPEG 缩略图 ${thumbnail.width} × ${thumbnail.height} px，不代表完整合成图；原尺寸 PNG 导出不可用。`,
      error instanceof Error ? error.message : '当前文件无法生成更清晰的降采样合成图。'];
    return { info, previewPath };
  }
}

async function svgToCanvas(canvas: WechatMiniprogram.Canvas, source: string): Promise<void> {
  const image = canvas.createImage();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new QuickViewError('SVG_CANVAS_UNSUPPORTED', '当前设备无法将 SVG 加载到 Canvas，PNG 导出不可用。')), 8000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      image.onload = () => {};
      image.onerror = () => {};
      error ? reject(error) : resolve();
    };
    image.onload = () => finish();
    image.onerror = () => finish(new QuickViewError('SVG_CANVAS_UNSUPPORTED', '当前设备的 Canvas 不支持此 SVG，PNG 导出不可用。'));
    image.src = source;
  });
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
}

export async function preparePreview(file: ChosenFile, canvas: WechatMiniprogram.Canvas,
  onStage?: PreviewCallback): Promise<PreparedPreview> {
  const startingCleanup = cleanupPreview();
  const token = generation;
  const ownedPaths: string[] = [];
  try {
    await startingCleanup;
    assertCurrent(token);
    onStage?.('metadata');
    const size = await statSize(file.path); // Trust actual filesystem size, not picker metadata.
    if (!Number.isSafeInteger(size) || size <= 0) throw new QuickViewError('EMPTY_FILE', '文件为空或大小无效。');
    let head = new Uint8Array(await readRange(file.path, Math.min(size, size > LIMITS.photoshopBytes ? 26 : 4096)));
    if (head.length >= 16 && String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') {
      const length = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
      if (length >= 16 && length <= Math.min(4096, size) && length > head.length) head = new Uint8Array(await readRange(file.path, length));
    }
    if (size > LIMITS.photoshopBytes && String.fromCharCode(...head.subarray(0, 4)) !== '8BPS' && !isTiffHeader(head)) {
      // Still identify converted images or unsupported camera containers before rejecting their size.
      let imageType = '';
      try { imageType = detectFormat(head, file.name); }
      catch (error) { if (error instanceof QuickViewError && ['UNSUPPORTED_RAW', 'UNSUPPORTED_IMAGE'].includes(error.code)) throw error; }
      if (imageType !== 'RAW') throw new QuickViewError('FILE_TOO_LARGE', `${imageType === 'JPEG' || imageType === 'PNG' ? `取得的是 ${imageType} 普通图像，原始 RAW 不可用；` : ''}文件超过 32 MiB 限制，已停止读取。`);
    }
    let format = detectFormat(head, file.name);
    if (file.source === 'chat-open' && format !== 'PSD') {
      throw new QuickViewError('INVALID_PHOTOSHOP', '聊天直接打开需要有效的 PSD 文件。');
    }
    const read = async (offset: number, length: number) => {
      assertCurrent(token); const bytes = new Uint8Array(await readRange(file.path, length, offset)); assertCurrent(token); return bytes;
    };
    let rawDirectory: Awaited<ReturnType<typeof readCameraRawDirectory>> | undefined;
    if (format === 'RAW' || format === 'TIFF' && (head[2] === 42 || head[3] === 42)
      && (file.source === 'chat-image' || file.source === 'album' || !/\.tiff?$/i.test(file.name))) {
      try {
        rawDirectory = await readCameraRawDirectory(read, size, () => token === generation);
        format = rawDirectory.isRaw ? 'RAW' : 'TIFF';
      } catch (error) {
        if (format === 'RAW' || error instanceof QuickViewError && error.code === 'CANCELLED') throw error;
        // A normal multi-strip/multi-page TIFF need not satisfy the RAW JPEG directory rules.
        // Its existing first-page parser still performs its own independent bounds checks.
      }
    }
    onStage?.(format === 'AI' ? 'document' : 'preview');
    if (format === 'JPEG' || format === 'PNG') return await originalImagePreview(file, size, format, token);
    if (format === 'RAW') {
      const image = await readCameraRawPreview(read, size, () => token === generation, rawDirectory);
      if (await statSize(file.path) !== size) throw new QuickViewError('FILE_CHANGED', 'RAW 原稿大小已变化，请重新选择。');
      assertCurrent(token);
      const previewPath = await writeOwned(rawPreviewJpeg(image.jpeg, image.orientation).buffer as ArrayBuffer, 'jpg');
      ownedPaths.push(previewPath);
      assertCurrent(token);
      const best = image.highest, swappedBest = best.orientation >= 5;
      const jpegPath = best.jpeg === image.jpeg ? previewPath
        : await writeOwned(rawPreviewJpeg(best.jpeg, best.orientation).buffer as ArrayBuffer, 'jpg');
      if (jpegPath !== previewPath) ownedPaths.push(jpegPath);
      const rawJpeg = { path: jpegPath, width: swappedBest ? best.height : best.width, height: swappedBest ? best.width : best.height };
      const jpegWarning = `预算内最高有效 JPEG：${rawJpeg.width} × ${rawJpeg.height} px；可全屏查看或按原压缩扫描数据保存，并非传感器 RAW 原尺寸，不随自动优化开关改变。单份 JPEG 上限 8 MiB，超出范围不作完整提取承诺。`;
      if (image.overviewSafe) onStage?.('preview', { path: previewPath });
      let sensorWarning = '';
      if (image.directories.length && (rawDirectory?.sony || /\.arw$/i.test(file.name))) {
        try {
          const result = await sensorRawPreview(file, size, image, canvas, token, ownedPaths, onStage);
          result.rawJpeg = rawJpeg;
          result.info.warnings.unshift(importNote(file, rawDirectory?.kind || 'RAW', size), jpegWarning);
          return result;
        }
        catch (error) { assertCurrent(token); sensorWarning = `全分辨率显影暂不可用：${rawFailureMessage(error)}；保留相机内嵌预览。`; }
      }
      let automatic: Awaited<ReturnType<typeof rawAutoPreview>> | undefined;
      let autoWarning = '自动优化：当前预览无需明显调整，保留相机原预览。';
      try {
        if (!image.overviewSafe) throw new QuickViewError('RAW_AUTO_BUDGET', '仅有超出整图处理预算的高清 JPEG，保留原样保存和微信全屏查看，不进行 Canvas 解码。');
        automatic = await rawAutoPreview(canvas, image.jpeg, image.width, image.height, image.orientation, token, ownedPaths);
        if (automatic?.changed) autoWarning = `轻量自动优化已就绪（${automatic.width} × ${automatic.height} px），可切换查看优化概览；相机高清 JPEG 保持原样，不等同于 Photoshop Auto。`;
        else if (automatic?.reason === 'dark') autoWarning = '相机 JPEG 为极暗分布，保留原预览，不自动猜测夜景或欠曝。';
      } catch {
        assertCurrent(token);
        autoWarning = '当前设备自动优化不可用，已保留相机原预览。';
      }
      assertCurrent(token);
      const basePng = automatic ? { path: automatic.originalPath, width: automatic.width, height: automatic.height } : undefined;
      let enabled = !!automatic?.changed;
      return { info: { format, filename: file.name, filesize: size,
        width: rawJpeg.width, height: rawJpeg.height,
        previewAvailable: image.overviewSafe, exportSupported: !!basePng, warnings: [importNote(file, rawDirectory?.kind || 'RAW', size),
          sensorWarning || '当前只使用内嵌预览，未进行传感器显影；没有传感器全分辨率 PNG 导出。', jpegWarning,
          `相机原预览：${image.width} × ${image.height} px，来自内嵌 JPEG，并非传感器原始分辨率。`, autoWarning,
        ] }, rawJpeg, previewPath: image.overviewSafe ? automatic?.path || previewPath : undefined,
        exportPath: basePng ? automatic?.path || basePng.path : undefined,
        exportSize: basePng ? { width: basePng.width, height: basePng.height } : undefined,
        rawOriginalPath: automatic?.changed ? previewPath : undefined, rawAutoPath: automatic?.changed ? automatic.path : undefined,
        setRawAuto(value) { enabled = value && !!automatic?.changed; },
        prepareExport: basePng ? async current => { assertCurrent(token); if (!current()) throw new QuickViewError('CANCELLED', '已取消 RAW 预览保存。'); return enabled ? automatic!.path : basePng!.path; } : undefined };
    }
    if (format === 'TIFF') {
      const read = async (offset: number, length: number) => {
        assertCurrent(token);
        const bytes = new Uint8Array(await readRange(file.path, length, offset));
        assertCurrent(token);
        return bytes;
      };
      const metadata = await inspectTiffFile(read, size);
      if (metadata.ifd.compression === 1) {
        const ahead = previewReader(read, size, () => token === generation, { adaptive: true });
        let image: Awaited<ReturnType<typeof previewRawTiff>>;
        try {
          image = await previewRawTiff(size > LIMITS.photoshopBytes ? ahead.read : read, size, metadata, () => token === generation);
        } finally { ahead.clear(); }
        const previewPath = await rasterPng(canvas, image);
        ownedPaths.push(previewPath);
        assertCurrent(token);
        const detailPaths = new Set<string>();
        let rendering = false;
        const release = async (path: string) => {
          if (!detailPaths.delete(path)) return;
          generatedPngs.delete(path);
          await removeFile(path);
        };
        const detail: PhotoshopDetail = {
          width: metadata.ifd.width, height: metadata.ifd.height, previewWidth: image.width, release,
          async render(region, output, isCurrent) {
            const current = () => {
              assertCurrent(token);
              if (!isCurrent()) throw new QuickViewError('CANCELLED', 'TIFF 视口已变化。');
              return true;
            };
            current();
            if (rendering) throw new QuickViewError('PREVIEW_BUSY', '正在读取上一处 TIFF 高清局部。');
            rendering = true;
            let path = '';
            try {
              if (await statSize(file.path) !== size) throw new QuickViewError('FILE_CHANGED', 'TIFF 原稿已变化，请重新选择。');
              current();
              const raster = await previewRawTiff(read, size, metadata, current, { region, output });
              current();
              path = await rasterPng(canvas, raster);
              detailPaths.add(path);
              current();
              return path;
            } catch (error) {
              if (path) await release(path);
              throw error;
            } finally {
              canvas.width = 1; canvas.height = 1;
              rendering = false;
            }
          },
        };
        return { info: { format, filename: file.name, filesize: size,
          width: metadata.ifd.width, height: metadata.ifd.height, bitDepth: metadata.ifd.bitsPerSample,
          colorMode: metadata.ifd.type === 2 ? 'RGB' : '灰度', previewAvailable: true, exportSupported: true, warnings: image.warnings },
          previewPath, exportPath: previewPath, exportSize: { width: image.width, height: image.height },
          detail: image.width < metadata.ifd.width || image.height < metadata.ifd.height ? detail : undefined,
          prepareNative: nativePngExporter(file, size, token, async read => rawTiffRows(read, size, await inspectTiffFile(read, size))) };
      }
    }
    if (format === 'PSD' || format === 'PSB') {
      const header = readPhotoshopHeader(head);
      if (header.version === 1 && header.colorModeId === 3 && header.bitDepth === 16) {
        return await largePhotoshopPreview(file, size, header, canvas, token, ownedPaths);
      }
      try {
        checkFileSize(format, size);
        if (header.width > LIMITS.canvasSide || header.height > LIMITS.canvasSide) {
          throw new QuickViewError('IMAGE_TOO_LARGE', '当前微信 Canvas 安全预览上限为单边 1365 像素。');
        }
        checkImageBudget(header.width, header.height, size, header.channels);
      } catch (error) {
        if (!(error instanceof QuickViewError) || !['FILE_TOO_LARGE', 'IMAGE_TOO_LARGE', 'MEMORY_BUDGET'].includes(error.code)) throw error;
        return await largePhotoshopPreview(file, size, header, canvas, token, ownedPaths);
      }
    } else checkFileSize(format, size);
    assertCurrent(token);
    const info: FileInfo = { format, filename: file.name, filesize: size, previewAvailable: true, exportSupported: false, warnings: [] };
    if (format === 'AI') {
      info.warnings = (await inspectAiFile(async (offset, length) => new Uint8Array(await readRange(file.path, length, offset)),
        size, () => token === generation)).warnings;
      info.warnings.push('PDF 副本保留兼容内容的原始字节，可能包含 Illustrator 编辑数据及元数据；未清除隐藏信息。',
        '保留原始 PDF 内容，预览清晰度受微信内置查看器影响；可转发 PDF 后使用其他阅读器查看。',
        'AI 中的 PDF 转发仅由你主动发起；当前不提供 AI 转 PNG。');
      const documentPath = await copyOwnedPdf(file.path, size, token, ownedPaths);
      assertCurrent(token);
      return { info, documentPath };
    }
    const buffer = await readRange(file.path, size);
    assertCurrent(token);
    if (format === 'TIFF') {
      if (buffer.byteLength !== size) throw new QuickViewError('TRUNCATED', 'TIFF 文件读取不完整。');
      const image = decodeTiff(new Uint8Array(buffer));
      info.width = image.width; info.height = image.height; info.bitDepth = image.bitDepth;
      info.colorMode = image.colorMode; info.warnings = image.warnings;
      const previewPath = await rasterPng(canvas, { width: image.previewWidth, height: image.previewHeight, pixels: image.pixels });
      ownedPaths.push(previewPath);
      assertCurrent(token);
      info.exportSupported = true;
      return { info, previewPath, exportPath: previewPath, exportSize: { width: image.previewWidth, height: image.previewHeight },
        prepareNative: nativePngExporter(file, size, token, async read => {
          const bytes = await read(0, size);
          if (bytes.length !== size) throw new QuickViewError('TRUNCATED', 'TIFF 文件读取不完整。');
          return decodeTiff(bytes).native;
        }) };
    }
    if (format === 'SVG') {
      // Native UTF-8 decoding is bounded by the checked stat and explicit read length.
      const text = await new Promise<string>((resolve, reject) => fs().readFile({ filePath: file.path, position: 0, length: size, encoding: 'utf8',
        success: result => typeof result.data === 'string' ? resolve(result.data) : reject(new QuickViewError('INVALID_XML', '无法读取 SVG 文本。')),
        fail: error => reject(nativeError(error, '无法读取 SVG 文本。')),
      }));
      assertCurrent(token);
      const result = parseSvg(text);
      info.width = result.width; info.height = result.height; info.warnings = result.warnings.slice();
      const sanitizedBytes = utf8ByteLength(result.svg);
      if (result.animation) info.warnings.push('动态 SVG 的 PNG 保存为第一帧。');
      if (result.animation && sanitizedBytes > 64 * 1024) info.warnings.push('SVG 动态画面超过播放预算，仅显示第一帧。');
      if (sanitizedBytes > SVG_PREVIEW_BYTES) throw new QuickViewError('SVG_TOO_COMPLEX', 'SVG 安全预览内容超过 512 KiB，请精简图形后再打开。');
      const safePath = await writeOwned(result.svg, 'svg');
      ownedPaths.push(safePath);
      const safeBytes = await readRange(safePath, sanitizedBytes);
      const previewPath = `data:image/svg+xml;base64,${wx.arrayBufferToBase64(safeBytes)}`;
      assertCurrent(token);
      if (result.width > LIMITS.canvasSide || result.height > LIMITS.canvasSide) {
        info.warnings.push('此 SVG 可以尝试原生预览；因微信 Canvas 单边安全上限为 1365 像素，PNG 导出不可用。');
        return { info, previewPath };
      }
      canvas.width = result.width; canvas.height = result.height;
      try {
        await svgToCanvas(canvas, previewPath);
        assertCurrent(token);
        const exportPath = await canvasPng(canvas);
        ownedPaths.push(exportPath);
        assertCurrent(token);
        info.exportSupported = true;
        return { info, previewPath, exportPath, exportSize: { width: result.width, height: result.height },
          ...(result.animation && sanitizedBytes <= 64 * 1024 ? { svgAnimation: result.animation } : {}) };
      } catch (error) {
        assertCurrent(token);
        info.warnings.push(error instanceof Error ? error.message : '当前设备无法将此 SVG 导出为 PNG。');
        return { info, previewPath };
      }
    }
    const image = decodePhotoshop(buffer);
    info.width = image.width; info.height = image.height; info.colorMode = image.colorMode; info.bitDepth = image.bitDepth; info.warnings = image.warnings;
    const previewPath = await rasterPng(canvas, image);
    ownedPaths.push(previewPath);
    assertCurrent(token);
    info.exportSupported = true;
    return { info, previewPath, exportPath: previewPath, exportSize: { width: image.width, height: image.height },
      prepareNative: nativeExporter(file, size, readPhotoshopHeader(head), token) };
  } catch (error) {
    if (token === generation) await cleanupPreview();
    else await Promise.all(ownedPaths.map(path => { generatedPngs.delete(path); return removeFile(path); }));
    throw error;
  } finally {
    // Native images are displayed from a URI/file after rendering; free the large Canvas surface.
    canvas.width = 1; canvas.height = 1;
  }
}

export async function openAiDocument(path: string): Promise<void> {
  if (typeof wx.openDocument !== 'function' || !wx.canIUse('openDocument')) return Promise.reject(new QuickViewError('API_UNAVAILABLE', '当前微信环境不支持本地文档预览，请升级微信或在手机端打开。'));
  const release = holdPdf(path);
  try { await new Promise<void>((resolve, reject) => wx.openDocument({ filePath: path, fileType: 'pdf', showMenu: false,
    success: () => resolve(), fail: error => reject(nativeError(error, '微信无法打开该 PDF；可能是结构不完整或当前平台不支持。')),
  })); } finally { await release(); }
}

/** Invoke directly from the tap handler: asynchronous file work would lose the native user gesture. */
export function sharePdfDocument(path: string, filename: string, isCurrent: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!path.startsWith(`${directory()}/`) || !/^qv_[a-zA-Z0-9_]+\.pdf$/.test(path.slice(directory().length + 1))) {
      reject(new QuickViewError('INVALID_PDF_PATH', 'PDF 副本路径无效，请重新选择文件。')); return;
    }
    if (!isCurrent()) { reject(new QuickViewError('CANCELLED', '已离开此次预览。')); return; }
    if (!ownedPdfs.has(path)) { reject(new QuickViewError('FILE_EXPIRED', 'PDF 副本已失效，请重新选择文件。')); return; }
    if (typeof wx.shareFileMessage !== 'function' || !wx.canIUse('shareFileMessage')) {
      reject(new QuickViewError('API_UNAVAILABLE', '当前微信环境不支持分享文件，请升级微信或在支持的手机端打开。')); return;
    }
    const stem = filename.replace(/\.(?:ai|pdf)$/i, '').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').trim().slice(0, 64) || '鉴中观象';
    const release = holdPdf(path);
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      void release().then(() => error ? reject(error) : resolve(), reject);
    };
    const failure = (error: WechatMiniprogram.GeneralCallbackResult) => {
      const detail = error.errMsg || '';
      const mapped = nativeError(error, `PDF 分享失败：${detail || '请重试。'}`);
      finish(mapped instanceof QuickViewError && mapped.code.startsWith('PRIVACY_') ? mapped
        : /cancel/i.test(detail) ? new QuickViewError('SHARE_CANCELLED', '已取消分享。') : mapped);
    };
    try { wx.shareFileMessage({ filePath: path, fileName: `${stem}.pdf`, success: () => finish(), fail: failure }); }
    catch (error) { failure({ errMsg: error instanceof Error ? error.message : String(error) }); }
  });
}

export async function savePng(path: string, label: 'PNG' | '图片' = 'PNG', quietCancel = false, isCurrent?: () => boolean): Promise<void> {
  if (!wx.canIUse('saveImageToPhotosAlbum')) throw new QuickViewError('API_UNAVAILABLE', '当前微信环境不支持保存到相册，请在支持的手机端打开。');
  const release = isCurrent ? holdPdf(path) : undefined;
  try {
    if (isCurrent) {
      if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消保存');
      await statSize(path);
      if (!isCurrent()) throw new QuickViewError('CANCELLED', '已取消保存');
    }
    await new Promise<void>((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: path, success: () => resolve(),
      fail: error => {
        const failure = nativeError(error, `${label} 保存失败，请检查相册权限、图片尺寸与本地空间。`);
        reject(failure instanceof QuickViewError && failure.code.startsWith('PRIVACY_') ? failure
          : quietCancel && /cancel/i.test(error.errMsg) ? new QuickViewError('CANCELLED', '已取消保存')
          : /auth|deny|permission/i.test(error.errMsg) ? new QuickViewError('ALBUM_PERMISSION', '没有相册保存权限，请在微信小程序设置中允许后再次保存。') : failure);
      },
    }));
  } finally { if (release) await release(); }
}

async function useOwnedJpeg(path: string, isCurrent: () => boolean, operation: () => Promise<void>): Promise<void> {
  if (!ownedJpegs.has(path)) throw new QuickViewError('INVALID_JPEG_PATH', '相机 JPEG 副本已失效，请重新选择 RAW。');
  const release = holdPdf(path);
  try {
    if (!isCurrent()) throw new QuickViewError('CANCELLED', '此次相机 JPEG 操作已取消。');
    await statSize(path);
    if (!isCurrent()) throw new QuickViewError('CANCELLED', '此次相机 JPEG 操作已取消。');
    await operation();
  } finally { await release(); }
}

/** Send the actual full-resolution camera JPEG to the native viewer; no Canvas decode. */
export function previewRawJpeg(path: string, isCurrent: () => boolean): Promise<void> {
  if (typeof wx.previewImage !== 'function' || !wx.canIUse('previewImage')) return Promise.reject(new QuickViewError('API_UNAVAILABLE', '当前微信不支持全屏图片查看，可保存相机 JPEG 后查看。'));
  return useOwnedJpeg(path, isCurrent, () => new Promise((resolve, reject) => wx.previewImage({ current: path, urls: [path],
    success: () => resolve(), fail: error => reject(nativeError(error, '微信暂时无法全屏查看此 JPEG，可保存后使用系统相册查看。')),
  })));
}

export function saveRawJpeg(path: string, isCurrent: () => boolean): Promise<void> {
  return useOwnedJpeg(path, isCurrent, () => savePng(path, '图片', true));
}

/** Keep a completed owned PNG alive until the native album callback settles. */
export async function saveNativePng(path: string, isCurrent: () => boolean, quietCancel = false): Promise<void> {
  if (!path.startsWith(`${directory()}/`) || !/^qv_[a-zA-Z0-9_]+\.png$/.test(path.slice(directory().length + 1))) {
    throw new QuickViewError('INVALID_PNG_PATH', '原尺寸 PNG 路径无效，请重新导出。');
  }
  const release = holdPdf(path);
  try {
    const current = () => { if (!isCurrent()) throw new QuickViewError('CANCELLED', '已离开此次导出。'); };
    current(); await statSize(path); current();
    await savePng(path, 'PNG', quietCancel);
  } finally { await release(); }
}
