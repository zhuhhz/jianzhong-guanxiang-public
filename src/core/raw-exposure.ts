import { LIMITS, QuickViewError } from './shared';

/** Global metering only. Exposure itself is applied by FlashRaw before sRGB/RGBA8.
 * The camera JPEG is a brightness reference, not the source of the rendered details.
 */
export function rawExposure(sensor: Uint8ClampedArray, camera: Uint8ClampedArray): number {
  function meter(pixels: Uint8ClampedArray) {
    if (!pixels.length || pixels.length % 4 || pixels.length / 4 > LIMITS.canvasSide ** 2) {
      throw new QuickViewError('RAW_AUTO_BUDGET', 'RAW 自动曝光采样超出预算。');
    }
    const luma = new Uint32Array(256), peak = new Uint32Array(256);
    let count = 0;
    const step = Math.max(1, Math.ceil(pixels.length / 4 / 65536));
    for (let i = 0; i < pixels.length; i += step * 4) {
      if (pixels[i + 3] < 250) continue;
      luma[(54 * pixels[i] + 183 * pixels[i + 1] + 19 * pixels[i + 2] + 128) >> 8]++;
      peak[Math.max(pixels[i], pixels[i + 1], pixels[i + 2])]++; count++;
    }
    const at = (p: number, histogram = luma) => {
      let n = 0;
      for (let i = 0; i < 256; i++) { n += histogram[i]; if (n >= Math.max(1, Math.ceil(count * p))) return i; }
      return 0;
    };
    return { count, median: at(.5), upper: at(.9), high: at(.995), peak: at(.999, peak) };
  }
  const a = meter(sensor), b = meter(camera);
  if (Math.min(a.count, b.count) < 32 || a.upper < 2 || b.upper < 2 || b.high - b.median < 4) return 0;
  const linear = (v: number) => v <= 10.31475 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4;
  // Match a robust upper midtone, rather than an unstable near-zero median.
  // Deliberate dark scenes stay near the camera rendering; normal scenes also
  // receive the existing bounded shadow/contrast curve after development.
  const desired = Math.log2(linear(b.upper) / linear(a.upper));
  // Protect all but at most the top 0.1% of sampled channel peaks; never reduce exposure.
  const headroom = a.peak ? Math.log2(linear(250) / linear(a.peak)) : 0;
  const ev = Math.min(4, desired, headroom);
  return ev > .15 ? Math.floor(ev * 20) / 20 : 0;
}
