import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoRawTone } from '../src/core/raw-auto';

function ramp(start: number, end: number) {
  const data = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) { const v = Math.round(start + (end - start) * i / 255); data.set([v, v, v, 255], i * 4); }
  return data;
}
test('RAW Auto lifts underexposed midtones with bounded gain and intact alpha/black', () => {
  const data = ramp(0, 110), before = data.slice(), result = autoRawTone(data);
  assert.equal(result.changed, true); assert.ok(result.gamma >= 0.72 && result.gamma < 1);
  assert.ok(data[128 * 4] > before[128 * 4]); assert.equal(data[0], 0);
  for (let i = 0; i < data.length; i += 4) {
    assert.ok(data[i] <= Math.round(before[i] * 1.8));
    assert.equal(data[i], data[i + 1]); assert.equal(data[i], data[i + 2]); assert.equal(data[i + 3], before[i + 3]);
  }
});
test('RAW Auto leaves a normal full-range ramp and constant/black/transparent images alone', () => {
  for (const data of [ramp(0, 255), ramp(100, 100), ramp(0, 0), new Uint8ClampedArray(1024)]) {
    const before = data.slice(); assert.equal(autoRawTone(data).changed, false); assert.deepEqual(data, before);
  }
});
test('RAW Auto uses linked RGB gain, protects saturated highlights and transparent pixels', () => {
  const data = ramp(10, 90);
  data.set([255, 64, 32, 255], 0); data.set([80, 40, 20, 128], 4); data.set([8, 16, 32, 0], 8);
  assert.equal(autoRawTone(data).changed, true);
  assert.deepEqual([...data.subarray(0, 4)], [255, 64, 32, 255]);
  assert.ok(Math.abs(data[4] / data[5] - 2) < 0.05); assert.ok(Math.abs(data[5] / data[6] - 2) < 0.1);
  assert.equal(data[7], 128); assert.deepEqual([...data.subarray(8, 12)], [8, 16, 32, 0]);
});
test('RAW Auto rejects invalid layouts and above-budget buffers', () => {
  assert.throws(() => autoRawTone(new Uint8ClampedArray(3)), { code: 'RAW_AUTO_BUDGET' });
  assert.throws(() => autoRawTone(new Uint8ClampedArray((1365 ** 2 + 1) * 4)), { code: 'RAW_AUTO_BUDGET' });
});

test('very dark distributions are preserved rather than guessed to be underexposed daylight', () => {
  const data = ramp(0, 35), before = data.slice(), result = autoRawTone(data);
  assert.equal(result.changed, false); assert.equal(result.reason, 'dark'); assert.deepEqual(data, before);
});

test('overview and region/export strips reuse the identical global correction', () => {
  const source = ramp(12, 128), overview = source.slice(), adjustment = autoRawTone(overview);
  assert.ok(adjustment.changed && adjustment.tone);
  const a = source.slice(0, 400), b = source.slice(400);
  autoRawTone(a, adjustment.tone); autoRawTone(b, adjustment.tone);
  assert.deepEqual(Buffer.concat([Buffer.from(a), Buffer.from(b)]), Buffer.from(overview));
});
