import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rawExposure } from '../src/core/raw-exposure';
import { autoRawTone } from '../src/core/raw-auto';

const linear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const srgb = (v: number) => Math.round(255 * (v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055));
function ramp(scale = 1, last = 55) {
  return Uint8ClampedArray.from(Array.from({ length: 256 }, (_, i) => {
    const value = srgb(Math.min(1, linear((5 + i / 255 * last) / 255) * scale));
    return [value, value, value, 255];
  }).flat());
}

test('sensor exposure uses a global camera reference in linear light, including dark scenes', () => {
  for (const stops of [0, 1, 2, 3]) {
    const ev = rawExposure(ramp(), ramp(2 ** stops));
    assert.ok(Math.abs(ev - stops) <= .1, `EV ${ev} expected ${stops}`);
  }
  assert.equal(rawExposure(ramp(), ramp(.5)), 0);
  assert.equal(rawExposure(ramp(), ramp()), 0);
});

test('sensor exposure is bounded, protects highlights, rejects invalid samples and preserves input bytes', () => {
  const source = ramp(), reference = ramp(32), before = source.slice();
  assert.ok(rawExposure(source, reference) <= 4);
  const bright = ramp(1, 245), target = ramp(8, 245);
  assert.equal(rawExposure(bright, target), 0);
  assert.equal(rawExposure(new Uint8ClampedArray(256), reference), 0);
  assert.deepEqual(source, before);
  assert.throws(() => rawExposure(new Uint8ClampedArray(3), reference), { code: 'RAW_AUTO_BUDGET' });
});

test('metered high-precision sensor development can lift shadows while JPEG near-black guard remains', () => {
  const base = ramp(.4), automatic = base.slice();
  assert.equal(autoRawTone(base).reason, 'dark');
  const result = autoRawTone(automatic, undefined, true);
  assert.equal(result.changed, true); assert.ok(result.tone);
  const detail = base.slice(); autoRawTone(detail, result.tone);
  assert.deepEqual(detail, automatic);
  for (let i = 0; i < automatic.length; i += 4) {
    assert.ok(automatic[i] <= Math.round(base[i] * 1.8)); assert.equal(automatic[i+3], 255);
  }
});
