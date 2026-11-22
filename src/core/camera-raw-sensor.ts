import type { Rect, SensorMetadata } from '../vendor/flashraw';
import type { PngRowSource } from './png-stream';
import { LIMITS, QuickViewError } from './shared';
import { autoRawTone } from './raw-auto';

type Read = (offset: number, length: number) => Promise<Uint8Array>;
export interface RawDecoder {
  inspect(bytes: Uint8Array): SensorMetadata;
  decode(bytes: Uint8Array, rect: Rect, exposure?: number): { width: number; height: number; pixels: Uint8ClampedArray };
  memoryBytes(): number;
}
type Directory = { offset: number; bytes: Uint8Array };
const invalid = () => new QuickViewError('INVALID_RAW_SENSOR', 'RAW 传感器区段、参数或像素无效。');
const unsupported = () => new QuickViewError('UNSUPPORTED_RAW_SENSOR', '全分辨率显影目前仅启用已验证的 Sony ILCE-7RM3 未压缩 ARW（单条带、14位RGGB）；保留内嵌预览。');
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Bounded TIFF envelope around actual Bayer rows, decoded by FlashRaw rather than a new demosaicer.
 * An even-aligned four-pixel halo preserves RGGB phase and bilinear neighbours. No full sensor buffer.
 * Only the verified little-endian uncompressed Sony layout is enabled; no compressed proxy rewriting.
 */
export async function openRawSensor(read: Read, size: number, directories: Directory[], decoder: RawDecoder,
  isCurrent: () => boolean = () => true) {
  const current = (check = isCurrent) => { if (!check()) throw new QuickViewError('CANCELLED', '已取消 RAW 传感器读取。'); };
  const range = async (offset: number, length: number, check = isCurrent) => {
    current(check);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
      || length > size - offset || length > 4 * 1024 * 1024) throw invalid();
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 64 * 1024) {
      current(check); const n = Math.min(64 * 1024, length - i), part = await read(offset + i, n); current(check);
      if (part.byteLength !== n) throw invalid(); bytes.set(part, i);
    }
    return bytes;
  };
  const header = await range(0, 8);
  if (header[0] !== 73 || header[1] !== 73 || dv(header).getUint16(2, true) !== 42) throw unsupported();
  function tags(directory: Directory) {
    const data = dv(directory.bytes), result = new Map<number, { value: number; at: number; type: number }>();
    const count = (directory.bytes.length - 4) / 12;
    for (let i = 0; i < count; i++) {
      const at = i * 12, tag = data.getUint16(at, true), type = data.getUint16(at + 2, true);
      if (![256, 257, 258, 259, 262, 273, 277, 278, 279].includes(tag)) continue;
      if (result.has(tag) || data.getUint32(at + 4, true) !== 1 || ![3, 4].includes(type)) throw unsupported();
      result.set(tag, { value: type === 3 ? data.getUint16(at + 8, true) : data.getUint32(at + 8, true), at: directory.offset + 2 + at + 8, type });
    }
    return result;
  }
  let sensor: ReturnType<typeof tags> | undefined;
  for (const directory of directories) {
    const t = tags(directory);
    if (t.get(262)?.value === 32803 && t.get(259)?.value === 1) { if (sensor) throw unsupported(); sensor = t; }
  }
  if (!sensor) throw unsupported();
  const get = (tag: number) => { const field = sensor!.get(tag); if (!field) throw unsupported(); return field.value; };
  const sw = get(256), sh = get(257), offset = get(273), stride = sw * 2;
  if (get(258) !== 14 || get(277) !== 1 || get(278) < sh || sw !== 8000 || sh !== 5320
    || get(279) !== stride * sh || offset > 2 * 1024 * 1024 || offset < 8 || stride * sh > size - offset
    || directories.some(d => d.offset + 2 + d.bytes.length > offset)) throw unsupported();
  const prefix = await range(0, offset), metadata = decoder.inspect(prefix);
  const { frame } = metadata, crop = frame.crop;
  if (metadata.metadata.camera.model !== 'ILCE-7RM3' || frame.width !== sw || frame.height !== sh
    || frame.bitsPerSample !== 14 || frame.layout !== 'bayer' || frame.compression !== 'uncompressed'
    || ![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0
    || crop.width < 1 || crop.height < 1 || crop.x + crop.width > sw || crop.y + crop.height > sh
    || frame.orientation < 1 || frame.orientation > 8 || !frame.whiteBalance?.every(x => Number.isFinite(x) && x > 0)) throw unsupported();
  const orientation = frame.orientation, width = orientation >= 5 ? crop.height : crop.width, height = orientation >= 5 ? crop.width : crop.height;
  let tone: Float64Array | undefined;
  let exposure = 0;
  function point(x: number, y: number) {
    const w = crop.width, h = crop.height;
    const p = [[x, y], [w - 1 - x, y], [w - 1 - x, h - 1 - y], [x, h - 1 - y],
      [y, x], [y, h - 1 - x], [w - 1 - y, h - 1 - x], [w - 1 - y, x]][orientation - 1];
    return { x: p[0] + crop.x, y: p[1] + crop.y };
  }
  async function proxy(rect: Rect, check: () => boolean, selectedExposure: number) {
    const x = Math.max(0, Math.floor((rect.x - 4) / 2) * 2), y = Math.max(0, Math.floor((rect.y - 4) / 2) * 2);
    const right = Math.min(sw, Math.ceil((rect.x + rect.width + 4) / 2) * 2);
    const bottom = Math.min(sh, Math.ceil((rect.y + rect.height + 4) / 2) * 2);
    const w = right - x, h = bottom - y;
    if (w * h > 2_100_000) throw new QuickViewError('RAW_SENSOR_BUDGET', 'RAW 高清块超过安全预算。');
    const bytes = new Uint8Array(prefix.length + w * h * 2); bytes.set(prefix);
    const data = dv(bytes);
    // The caller maps sensor coordinates to display coordinates. Keep the decoder's local
    // TIFF envelope unrotated so rgba8 is not rotated a second time by FlashRaw.
    for (const directory of directories) {
      const count = (directory.bytes.length - 4) / 12, tags = dv(directory.bytes);
      for (let i = 0; i < count; i++) if (tags.getUint16(i * 12, true) === 274) {
        if (tags.getUint32(i * 12 + 4, true) !== 1 || ![3, 4].includes(tags.getUint16(i * 12 + 2, true))) throw unsupported();
        const at = directory.offset + 2 + i * 12 + 8;
        if (tags.getUint16(i * 12 + 2, true) === 3) data.setUint16(at, 1, true); else data.setUint32(at, 1, true);
      }
    }
    for (const [tag, value] of [[256, w], [257, h], [273, offset], [278, h], [279, w * h * 2]]) {
      const field = sensor!.get(tag)!;
      if (field.type === 3) { if (value > 65535) throw invalid(); data.setUint16(field.at, value, true); }
      else data.setUint32(field.at, value, true);
    }
    for (let row = 0; row < h; row += 16) {
      const n = Math.min(16, h - row), length = (n - 1) * stride + w * 2;
      const block = await range(offset + (y + row) * stride + x * 2, length, check);
      for (let r = 0; r < n; r++) bytes.set(block.subarray(r * stride, r * stride + w * 2), offset + (row + r) * w * 2);
    }
    current(check);
    // FlashRaw interpolates at the decoded region's edges. Decode the halo too and
    // sample only its interior; requesting just the crop would discard those neighbours.
    const raster = decoder.decode(bytes, { x: 0, y: 0, width: w, height: h }, selectedExposure);
    if (raster.width !== w || raster.height !== h || raster.pixels.length !== w * h * 4
      || decoder.memoryBytes() > 64 * 1024 * 1024) throw invalid();
    return { ...raster, stride: w, offset: ((rect.y - y) * w + rect.x - x) * 4 };
  }
  async function render(rect: Rect, output: { width: number; height: number }, check: () => boolean, selectedTone = tone,
    progress?: (completed: number, total: number) => void, selectedExposure = exposure) {
    if (![rect.x, rect.y, rect.width, rect.height, output.width, output.height].every(Number.isSafeInteger)
      || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > width || rect.y + rect.height > height
      || output.width < 1 || output.height < 1 || output.width > rect.width || output.height > rect.height
      || output.width * output.height > LIMITS.canvasSide ** 2) throw new QuickViewError('INVALID_REGION', 'RAW 高清区域或输出尺寸无效。');
    const pixels = new Uint8ClampedArray(output.width * output.height * 4);
    const sx = rect.width / output.width, sy = rect.height / output.height;
    const native = sx === 1 && sy === 1 && rect.width * rect.height <= 1_800_000;
    // Full sensor-width bands avoid repeatedly reading the skipped columns in each
    // 16-row native read. Rotation swaps the display axes; sample coordinates stay identical.
    const rotated = orientation >= 5;
    const band = Math.max(1, Math.floor((1_800_000 / ((rotated ? rect.height : rect.width) + 10) - 10) / (rotated ? sx : sy)));
    const tileWidth = native || !rotated ? output.width : band;
    const tileHeight = native || rotated ? output.height : band;
    const total = Math.ceil(output.width / tileWidth) * Math.ceil(output.height / tileHeight);
    let completed = 0; progress?.(0, total);
    for (let oy = 0; oy < output.height; oy += tileHeight) for (let ox = 0; ox < output.width; ox += tileWidth) {
      current(check);
      const tw = Math.min(tileWidth, output.width - ox), th = Math.min(tileHeight, output.height - oy);
      const a = point(rect.x + Math.floor((ox + 0.5) * sx), rect.y + Math.floor((oy + 0.5) * sy));
      const b = point(rect.x + Math.min(rect.width - 1, Math.floor((ox + tw - 0.5) * sx)), rect.y + Math.min(rect.height - 1, Math.floor((oy + th - 0.5) * sy)));
      const bounds = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x) + 1, height: Math.abs(b.y - a.y) + 1 };
      const raster = await proxy(bounds, check, selectedExposure);
      for (let dy = 0; dy < th; dy++) for (let dx = 0; dx < tw; dx++) {
        const p = point(rect.x + Math.min(rect.width - 1, Math.floor((ox + dx + 0.5) * sx)), rect.y + Math.min(rect.height - 1, Math.floor((oy + dy + 0.5) * sy)));
        const from = raster.offset + ((p.y - bounds.y) * raster.stride + p.x - bounds.x) * 4;
        pixels.set(raster.pixels.subarray(from, from + 4), ((oy + dy) * output.width + ox + dx) * 4);
      }
      progress?.(++completed, total);
    }
    if (selectedTone) autoRawTone(pixels, selectedTone);
    current(check);
    return { width: output.width, height: output.height, pixels };
  }
  const source: PngRowSource = { width, height, nativeChannels: 3, nativeSrgb: true,
    async readRows(consume, options = {}) {
      const check = options.isCurrent || isCurrent, selectedTone = tone, selectedExposure = exposure;
      const row = new Uint8Array(width * 3);
      for (let y = 0; y < height; y += 192) {
        const h = Math.min(192, height - y);
        // Full-width bounded bands, no giant Canvas or full RGB image.
        const raster = await render({ x: 0, y, width, height: h }, { width, height: h }, check, selectedTone, undefined, selectedExposure);
        for (let yy = 0; yy < h; yy++) {
          current(check);
          for (let x = 0; x < width; x++) row.set(raster.pixels.subarray((yy * width + x) * 4, (yy * width + x) * 4 + 3), x * 3);
          await consume({ y: y + yy, data: row });
        }
      }
    },
  };
  return { ...source, metadata, render, setTone: (value?: Float64Array) => { tone = value; },
    setExposure(value: number) {
      if (!Number.isFinite(value) || value < 0 || value > 4) throw new QuickViewError('INVALID_RAW_EXPOSURE', 'RAW 曝光参数无效。');
      exposure = value;
    } };
}
