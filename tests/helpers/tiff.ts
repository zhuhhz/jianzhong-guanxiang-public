import { deflateSync } from 'node:zlib';

export function tiffImage(options: {
  width?: number; height?: number; components?: number; bits?: number; little?: boolean;
  compression?: number; photometric?: number; extras?: number[]; pixels?: Uint8Array;
  orientation?: number; morePages?: boolean;
  icc?: Uint8Array;
} = {}): Uint8Array {
  const { width = 2, height = 1, components = 3, bits = 8, little = true, compression = 1,
    photometric = 2, extras = [], orientation = 1, morePages = false } = options;
  const raw = options.pixels ?? Uint8Array.from([255, 0, 0, 0, 255, 0]);
  // Literal LZW groups with clear codes keep this independent fixture encoder small.
  let payload = raw;
  if (compression === 8 || compression === 32946) payload = deflateSync(raw);
  if (compression === 5) {
    const codes: number[] = [];
    for (let offset = 0; offset < raw.length; offset += 128) codes.push(256, ...raw.subarray(offset, offset + 128));
    codes.push(257);
    payload = new Uint8Array(Math.ceil(codes.length * 9 / 8));
    let bit = 0;
    for (const code of codes) for (let shift = 8; shift >= 0; shift--, bit++) payload[bit >>> 3] |= ((code >>> shift) & 1) << (7 - (bit & 7));
  }
  const tags: [number, number, number[]][] = [
    [256, 4, [width]], [257, 4, [height]], [258, 3, Array(components).fill(bits)],
    [259, 3, [compression]], [262, 3, [photometric]], [273, 4, [0]], [274, 3, [orientation]],
    [277, 3, [components]], [278, 4, [height]], [279, 4, [payload.length]], [284, 3, [1]],
  ];
  if (extras.length) tags.push([338, 3, extras]);
  if (options.icc) tags.push([34675, 7, Array.from(options.icc)]);
  const typeSize = (type: number) => type === 3 ? 2 : type === 4 ? 4 : 1;
  const directoryEnd = 8 + 2 + tags.length * 12 + 4;
  const extraSize = tags.reduce((sum, [, type, values]) => sum + (values.length * typeSize(type) > 4 ? values.length * typeSize(type) : 0), 0);
  const pixelsAt = directoryEnd + extraSize;
  tags.find(([tag]) => tag === 273)![2][0] = pixelsAt;
  const result = new Uint8Array(pixelsAt + payload.length), view = new DataView(result.buffer);
  result.set(little ? [73, 73] : [77, 77]);
  view.setUint16(2, 42, little); view.setUint32(4, 8, little); view.setUint16(8, tags.length, little);
  let extraAt = directoryEnd;
  tags.forEach(([tag, type, values], i) => {
    const pos = 10 + i * 12, size = values.length * typeSize(type);
    view.setUint16(pos, tag, little); view.setUint16(pos + 2, type, little); view.setUint32(pos + 4, values.length, little);
    const target = size > 4 ? extraAt : pos + 8;
    if (size > 4) { view.setUint32(pos + 8, extraAt, little); extraAt += size; }
    values.forEach((value, j) => {
      if (type === 3) view.setUint16(target + j * 2, value, little);
      else if (type === 4) view.setUint32(target + j * 4, value, little);
      else view.setUint8(target + j, value);
    });
  });
  view.setUint32(8 + 2 + tags.length * 12, morePages ? 8 : 0, little);
  result.set(payload, pixelsAt);
  return result;
}
