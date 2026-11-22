// Project-generated matrix/TRC profiles; no embedded user profile or private artwork.
export function matrixIcc(srgb = false): Buffer {
  const columns = srgb ? [[.4360747, .2225045, .0139322], [.3850649, .7168786, .0971045], [.1430804, .0606169, .7141733]]
    : [[.797668457, .288040161, 0], [.135192871, .711883545, 0], [.031341553, .000091553, .824905396]];
  const xyz = (values: number[]) => { const b = Buffer.alloc(20); b.write('XYZ '); values.forEach((v, i) => b.writeInt32BE(Math.round(v * 65536), 8 + i * 4)); return b; };
  const curve = Buffer.alloc(srgb ? 12 + 1024 * 2 : 14); curve.write('curv'); curve.writeUInt32BE(srgb ? 1024 : 1, 8);
  if (!srgb) curve.writeUInt16BE(461, 12);
  else for (let i = 0; i < 1024; i++) {
    const v = i / 1023; curve.writeUInt16BE(Math.round((v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * 65535), 12 + i * 2);
  }
  const entries = [['rXYZ', xyz(columns[0])], ['gXYZ', xyz(columns[1])], ['bXYZ', xyz(columns[2])],
    ['wtpt', xyz([.9642, 1, .8249])], ['rTRC', curve], ['gTRC', curve], ['bTRC', curve]] as const;
  const header = Buffer.alloc(132 + entries.length * 12); header[8] = 2; header.write('mntrRGB XYZ ', 12); header.write('acsp', 36);
  [.9642, 1, .8249].forEach((v, i) => header.writeInt32BE(Math.round(v * 65536), 68 + i * 4)); header.writeUInt32BE(entries.length, 128);
  const chunks: Buffer[] = [header]; const offsets = new Map<Buffer, number>(); let offset = header.length;
  entries.forEach(([name, b], i) => {
    if (!offsets.has(b)) { offsets.set(b, offset); const padding = Buffer.alloc((4 - b.length % 4) % 4); chunks.push(b, padding); offset += b.length + padding.length; }
    header.write(name, 132 + i * 12); header.writeUInt32BE(offsets.get(b)!, 136 + i * 12); header.writeUInt32BE(b.length, 140 + i * 12);
  });
  header.writeUInt32BE(offset); return Buffer.concat(chunks);
}
