// Deterministic tiny binary fixtures. These are generated documents, not Photoshop exports.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeCanvas, writePsd } from 'ag-psd';

const target = join(process.cwd(), 'tests/fixtures/photoshop');
mkdirSync(target, { recursive: true });
initializeCanvas(() => { throw new Error('Fixture generation requires no Canvas'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData);

// Opaque colors + repeated scanline values exercise both PackBits packet types.
const opaque = new Uint8ClampedArray([
  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  21, 21, 21, 255, 21, 21, 21, 255, 21, 21, 21, 255,
]);
// Six pixels avoid ag-psd 31.0.3's undersized temporary writer buffer on tiny RGBA PSB.
const transparent = new Uint8ClampedArray([
  255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
  255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
]);
for (const psb of [false, true]) {
  const extension = psb ? 'psb' : 'psd';
  writeFileSync(join(target, `generated-rle.${extension}`), new Uint8Array(writePsd({
    width: 3, height: 2, imageData: { width: 3, height: 2, data: opaque },
  }, { psb })));
  writeFileSync(join(target, `generated-alpha.${extension}`), new Uint8Array(writePsd({
    width: 6, height: 1, imageData: { width: 6, height: 1, data: transparent },
    children: [{ name: 'Colors', imageData: { width: 6, height: 1, data: transparent } }],
  }, { psb })));

  // Minimal complete Raw file according to the Adobe PSD/PSB file structure.
  // This is only a fixture writer. Production pixel decoding remains ag-psd.
  const prefix = psb ? 42 : 38;
  const raw = new Uint8Array(prefix + 2 + 18);
  const view = new DataView(raw.buffer);
  raw.set([0x38, 0x42, 0x50, 0x53]);
  view.setUint16(4, psb ? 2 : 1);
  view.setUint16(12, 3);
  view.setUint32(14, 2);
  view.setUint32(18, 3);
  view.setUint16(22, 8);
  view.setUint16(24, 3);
  for (let channel = 0; channel < 3; channel++) {
    for (let pixel = 0; pixel < 6; pixel++) raw[prefix + 2 + channel * 6 + pixel] = opaque[pixel * 4 + channel];
  }
  writeFileSync(join(target, `generated-raw.${extension}`), raw);
}
