import { thumbnailJpeg } from './photoshop-thumbnail';

/** Self-generated TIFF-family RAW container; JPEG is the existing project-made solid image. */
export function cameraRaw(little = true, orientation = 1): Buffer {
  const bytes = Buffer.alloc(256 + thumbnailJpeg.length);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.write(little ? 'II' : 'MM'); data.setUint16(2, 42, little); data.setUint32(4, 8, little);
  data.setUint16(8, 3, little);
  for (const [i, tag, value] of [[0, 274, orientation], [1, 513, 256], [2, 514, thumbnailJpeg.length]]) {
    const at = 10 + i * 12;
    data.setUint16(at, tag, little); data.setUint16(at + 2, 4, little);
    data.setUint32(at + 4, 1, little); data.setUint32(at + 8, value, little);
  }
  // A separate CFA directory identifies actual RAW structure independently of the filename.
  data.setUint32(46, 64, little); data.setUint16(64, 1, little);
  data.setUint16(66, 262, little); data.setUint16(68, 3, little);
  data.setUint32(70, 1, little); data.setUint16(74, 32803, little);
  bytes.set(thumbnailJpeg, 256);
  return bytes;
}
