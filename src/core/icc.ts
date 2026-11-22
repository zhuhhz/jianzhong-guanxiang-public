import type { PhotoshopHeader } from './photoshop';
import { readPhotoshopResources } from './photoshop-thumbnail';
import { QuickViewError } from './shared';

// Bounded matrix/TRC RGB profiles only. No LUT, network, WASM or profile-name guessing.
// ICC.1:2022, matrix/TRC RGB -> D50 PCS; the PCS matrix already includes adaptation.
export const ICC_MAX_BYTES = 1024 * 1024;
type Curve = (value: number) => number;
export interface IccColor {
  readonly kind: 'srgb' | 'matrix' | 'unmanaged';
  readonly warning: string;
  /** Encoded source RGB [0,1] -> encoded sRGB [0,1], before 8-bit quantization. */
  convert?: (r: number, g: number, b: number) => [number, number, number];
}
const unmanaged = (reason: string): IccColor => ({ kind: 'unmanaged', warning: `${reason}；未应用 ICC 色彩管理，颜色可能与 Photoshop 不同。` });
const fail = (message: string): never => { throw new QuickViewError('INVALID_ICC', `ICC 配置无效：${message}`); };
const signature = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));
const clip = (v: number) => Math.min(1, Math.max(0, v));
const srgbLinear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const srgbEncode = (v: number) => { v = clip(v); return v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055; };

export function inspectIcc(bytes?: Uint8Array): IccColor {
  if (!bytes) return unmanaged('文件未嵌入 ICC 配置');
  if (bytes.length < 132 || bytes.length > ICC_MAX_BYTES) fail('配置长度超出范围');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fixed = (at: number) => v.getInt32(at) / 65536;
  if (v.getUint32(0) !== bytes.length || signature(bytes, 36) !== 'acsp') fail('头部签名或长度不符');
  const count = v.getUint32(128);
  if (count > 256 || 132 + count * 12 > bytes.length) fail('Tag 目录过长或截断');
  const tags = new Map<string, { at: number; size: number }>();
  const intervals: { at: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    const key = signature(bytes, 132 + i * 12), at = v.getUint32(136 + i * 12), size = v.getUint32(140 + i * 12);
    if (tags.has(key) || at % 4 || at < 132 + count * 12 || size < 8 || at + size > bytes.length) fail('Tag 偏移、长度或重复签名错误');
    if (v.getUint32(at + 4) !== 0) fail('Tag 保留字段非零');
    const tag = { at, size }; tags.set(key, tag); intervals.push(tag);
  }
  intervals.sort((a, b) => a.at - b.at || a.size - b.size);
  for (let i = 1; i < intervals.length; i++) {
    const a = intervals[i - 1], b = intervals[i];
    // Shared payloads (notably identical r/g/b TRCs) are expressly valid ICC.
    if (b.at < a.at + a.size && (a.at !== b.at || a.size !== b.size)) fail('Tag 数据异常重叠');
  }
  if (![2, 4].includes(bytes[8]) || !['mntr', 'scnr'].includes(signature(bytes, 12))
    || signature(bytes, 16) !== 'RGB ' || signature(bytes, 20) !== 'XYZ '
    || [...tags.keys()].some(k => /^(?:A2B|B2A|D2B|B2D)/.test(k))) return unmanaged('当前不支持此 ICC 类型（仅 RGB 矩阵/TRC）');
  if (Math.abs(fixed(68) - .9642) > .002 || Math.abs(fixed(72) - 1) > .002 || Math.abs(fixed(76) - .8249) > .002) {
    return unmanaged('ICC PCS 白点不是当前支持的 D50');
  }
  const xyz = (key: string): number[] | undefined => {
    const tag = tags.get(key); if (!tag) return;
    if (tag.size !== 20 || signature(bytes, tag.at) !== 'XYZ ') return;
    const values = [fixed(tag.at + 8), fixed(tag.at + 12), fixed(tag.at + 16)];
    if (values.some(x => Math.abs(x) > 4)) fail('色彩矩阵数值越界');
    return values;
  };
  const curve = (key: string): Curve | undefined => {
    const tag = tags.get(key); if (!tag) return;
    if (signature(bytes, tag.at) !== 'curv') return; // Parametric/LUT curves remain explicit unsupported.
    if (tag.size < 12) fail('TRC 截断');
    const n = v.getUint32(tag.at + 8);
    if (n > 4096) return;
    if (12 + n * 2 > tag.size) fail('TRC 样本长度越界');
    if (!n) return x => x;
    if (n === 1) {
      const gamma = v.getUint16(tag.at + 12) / 256;
      if (gamma <= 0 || gamma > 10) fail('TRC gamma 无效');
      return x => x ** gamma;
    }
    const points = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      points[i] = v.getUint16(tag.at + 12 + i * 2) / 65535;
      if (i && points[i] < points[i - 1]) fail('TRC 不是单调递增');
    }
    return x => { const at = x * (n - 1), i = Math.min(n - 2, Math.floor(at)); return points[i] + (points[i + 1] - points[i]) * (at - i); };
  };
  const r = xyz('rXYZ'), g = xyz('gXYZ'), b = xyz('bXYZ');
  const curves = [curve('rTRC'), curve('gTRC'), curve('bTRC')];
  if (!r || !g || !b || curves.some(c => !c)) return unmanaged('ICC 矩阵或 TRC 结构尚未支持');
  const matrix = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const determinant = r[0] * (g[1] * b[2] - b[1] * g[2]) - g[0] * (r[1] * b[2] - b[1] * r[2]) + b[0] * (r[1] * g[2] - g[1] * r[2]);
  if (Math.abs(determinant) < 1e-6) fail('色彩矩阵不可逆');
  const standard = [.4360747, .3850649, .1430804, .2225045, .7168786, .0606169, .0139322, .0971045, .7141733];
  const identity = matrix.every((x, i) => Math.abs(x - standard[i]) < .0002)
    && curves.every(c => {
      for (let i = 0; i <= 4096; i++) if (Math.abs(c!(i / 4096) - srgbLinear(i / 4096)) > .0003) return false;
      return true;
    });
  if (identity) return { kind: 'srgb', warning: '已核实 sRGB 矩阵/TRC，保留原颜色，不重复转换。' };
  // Bradford D50 PCS -> D65 plus XYZ -> linear sRGB, precombined per session.
  const destination = [3.1338561, -1.6168667, -.4906146, -.9787684, 1.9161415, .0334540, .0719453, -.2289914, 1.4052427];
  const combined = new Float64Array(9);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    for (let k = 0; k < 3; k++) combined[row * 3 + col] += destination[row * 3 + k] * matrix[k * 3 + col];
  }
  return { kind: 'matrix', warning: '已按嵌入 ICC 矩阵/TRC 转换到 sRGB（相对色度，无黑点补偿）；超色域分量裁剪。',
    convert(r, g, b) {
      const values = [curves[0]!(clip(r)), curves[1]!(clip(g)), curves[2]!(clip(b))];
      return [0, 1, 2].map(row => srgbEncode(combined[row * 3] * values[0]
        + combined[row * 3 + 1] * values[1] + combined[row * 3 + 2] * values[2])) as [number, number, number];
    } };
}

/** TIFF ICCProfile (34675) uses the same bounded RGB profile interpreter. */
export function inspectTiffIcc(bytes: Uint8Array | undefined, photometric: number): IccColor {
  const color = inspectIcc(bytes);
  return bytes && photometric !== 2 && color.kind !== 'unmanaged'
    ? unmanaged('当前不支持将 RGB ICC 配置应用于非 RGB TIFF') : color;
}

export async function readPhotoshopIcc(read: (offset: number, length: number) => Promise<Uint8Array>,
  fileSize: number, header: PhotoshopHeader): Promise<IccColor> {
  const directory = await readPhotoshopResources(read, fileSize, header, [1039]);
  const location = directory.resources.get(1039);
  if (!location) return inspectIcc();
  if (location.length < 132 || location.length > ICC_MAX_BYTES) fail('配置长度超出 132 字节至 1 MiB 范围');
  return inspectIcc(await directory.range(location.offset, location.length));
}

export function applyIcc8(pixels: Uint8ClampedArray, color: IccColor): void {
  if (!color.convert) return;
  for (let i = 0; i < pixels.length; i += 4) {
    const rgb = color.convert(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(rgb[c] * 255);
  }
}
