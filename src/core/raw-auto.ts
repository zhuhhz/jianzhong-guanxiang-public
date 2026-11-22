import { LIMITS, QuickViewError } from './shared';

/** Display-only luminance correction, not Adobe Auto or sensor development.
 * RGB shares one bounded gain to preserve channel ratios and highlight detail.
 * Only the bounded Canvas copy is modified; source JPEG/RAW bytes stay untouched.
 */
export function autoRawTone(pixels: Uint8ClampedArray, supplied?: Float64Array, sensorExposure = false): { changed: boolean; gamma: number; tone?: Float64Array; reason?: 'dark' } {
  if (!pixels.length || pixels.length % 4 || pixels.length / 4 > LIMITS.canvasSide ** 2) {
    throw new QuickViewError('RAW_AUTO_BUDGET', 'RAW 自动预览像素超出安全预算。');
  }
  let gamma = 1, gain = supplied;
  const luminance = (i: number) => (54 * pixels[i] + 183 * pixels[i + 1] + 19 * pixels[i + 2] + 128) >> 8;
  if (!gain) {
  const histogram = new Uint32Array(256), step = Math.max(1, Math.ceil(pixels.length / 4 / 65536));
  let samples = 0;
  for (let i = 0; i < pixels.length; i += 4 * step) {
    if (pixels[i + 3] < 250) continue;
    histogram[luminance(i)]++; samples++;
  }
  const percentile = (p: number) => {
    let n = 0;
    for (let i = 0; i < 256; i++) { n += histogram[i]; if (n >= Math.max(1, Math.ceil(samples * p))) return i; }
    return 255;
  };
  const low = percentile(0.005), median = percentile(0.5), high = percentile(0.995);
  if (samples < 32 || high - low < 12 || high < 12) return { changed: false, gamma: 1 };
  // A histogram cannot distinguish a deliberate night exposure from underexposure.
  // Do not stretch near-black quantized pixels into banding or pretend to recover RAW detail.
  // A sensor already metered against its camera JPEG has received its gain before
  // quantization. Permit the same bounded shadow curve there; JPEG-only and 0EV
  // near-black paths retain the conservative guard.
  if (median < 24 && high < 96 && !sensorExposure) return { changed: false, gamma: 1, reason: 'dark' };
  if (low <= 8 && high >= 245 && median >= 100) return { changed: false, gamma: 1 };
  const black = Math.min(8, low * 0.35), white = Math.max(220, high);
  const normalizedMedian = Math.max(1, (median - black) * 255 / (white - black));
  gamma = normalizedMedian < 100 ? Math.max(0.72, Math.log(100 / 255) / Math.log(normalizedMedian / 255)) : 1;
  gain = new Float64Array(256);
  for (let i = 1; i < 256; i++) {
    const normalized = Math.max(0, Math.min(1, (i - black) / (white - black)));
    gain[i] = Math.max(0.8, Math.min(1.8, 255 * normalized ** gamma / i));
  }
  gain[0] = 1;
  }
  if (gain.length !== 256) throw new QuickViewError('INVALID_RAW_TONE', 'RAW 自动预览曲线无效。');
  let difference = 0, count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const maximum = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    const scale = Math.min(gain[luminance(i)], maximum ? 255 / maximum : 1);
    for (let c = 0; c < 3; c++) {
      const before = pixels[i + c];
      pixels[i + c] = Math.round(before * scale);
      difference += Math.abs(pixels[i + c] - before); count++;
    }
  }
  return { changed: count > 0 && difference > 0, gamma, tone: gain };
}
