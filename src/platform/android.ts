import { ascii, checkFileSize, detectFormat, inspectAiFile } from '../core/files';
import { rawPreviewJpeg, readCameraRawPreview } from '../core/camera-raw';
import { decodePhotoshop, readPhotoshopHeader, photoshopDescription } from '../core/photoshop';
import { openPhotoshopComposite, type PhotoshopRaster, type PhotoshopRegion } from '../core/photoshop-preview';
import { readPhotoshopThumbnail } from '../core/photoshop-thumbnail';
import { previewReader } from '../core/preview-reader';
import { inspectBigTiffFile } from '../core/bigtiff';
import { inspectTiffFile, previewRawTiff, rawTiffRows } from '../core/tiff-preview';
import type { PngRowSource } from '../core/png-stream';
import { decodeTiff } from '../core/tiff';
import { parseSvg } from '../core/svg';
import type { SvgAnimation } from '../core/svg-animation';
import { checkImageBudget, LIMITS, QuickViewError } from '../core/shared';

export type AndroidRead = (offset: number, length: number) => Promise<Uint8Array>;
export interface AndroidMetadata {
  kind: 'rgba' | 'jpeg' | 'svg' | 'native' | 'pdf';
  format: string;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  regionAvailable?: boolean;
  exportKind?: 'nativePng' | 'cameraJpeg' | 'bitmapPng';
  orientation?: number;
  /** Null denotes an indefinite animation; absence denotes static SVG. */
  svgDuration?: number | null;
  details: string;
  warnings: string[];
}
type RegionRenderer = (region: PhotoshopRegion, output: { width: number; height: number },
  isCurrent: () => boolean) => Promise<PhotoshopRaster>;
export interface AndroidPreview {
  metadata: AndroidMetadata;
  payload?: Uint8Array;
  region?: RegionRenderer;
  nativeRows?: (isCurrent: () => boolean) => PngRowSource | Promise<PngRowSource>;
  animation?: SvgAnimation;
}

const BRIDGE_BYTES = 1024 * 1024;

/** Android supplies random-access source bytes to the shared parsers. Payload
 * dimensions describe the bounded preview. The source dimensions and available
 * operations are reported separately. */
export async function prepareAndroidPreview(read: AndroidRead, size: number, name: string,
  isCurrent: () => boolean = () => true): Promise<AndroidPreview> {
  const current = (active = isCurrent) => {
    if (!active()) throw new QuickViewError('CANCELLED', '已取消本地文件处理。');
  };
  current();
  if (!Number.isSafeInteger(size) || size < 1) throw new QuickViewError('EMPTY_FILE', '文件为空或大小无效。');
  const exact = async (offset: number, length: number, active = isCurrent): Promise<Uint8Array> => {
    current(active);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > size - offset) {
      throw new QuickViewError('INVALID_READ_RANGE', '本地文件读取范围无效。');
    }
    // Callers retain the core's per-format allocation limits. Split bridge transfers only;
    // a 64-bit offset must never pass through a bitwise operator or a 32-bit Java int.
    if (length <= BRIDGE_BYTES) {
      const bytes = await read(offset, length);
      current(active);
      if (!bytes || bytes.byteLength !== length || bytes.length !== length) throw new QuickViewError('TRUNCATED', '本地文件读取不完整。');
      return bytes;
    }
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length; at += BRIDGE_BYTES) {
      bytes.set(await exact(offset + at, Math.min(BRIDGE_BYTES, length - at), active), at);
    }
    return bytes;
  };
  const ahead = previewReader(exact, size, isCurrent);
  const rgba = (format: string, image: PhotoshopRaster, details: string,
    sourceWidth: number, sourceHeight: number, nativeRows: AndroidPreview['nativeRows'],
    render?: RegionRenderer): AndroidPreview => {
    current();
    const region: RegionRenderer | undefined = render && (image.width < sourceWidth || image.height < sourceHeight)
      ? async (rect, output, active) => {
        if (![rect.x, rect.y, rect.width, rect.height, output.width, output.height].every(Number.isSafeInteger)
          || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
          || rect.width > sourceWidth - rect.x || rect.height > sourceHeight - rect.y
          || output.width < 1 || output.height < 1 || output.width > Math.min(rect.width, LIMITS.canvasSide)
          || output.height > Math.min(rect.height, LIMITS.canvasSide)) {
          throw new QuickViewError('INVALID_REGION', '高清区域须在原图内，输出不放大且单边最多 1365 像素。');
        }
        return render(rect, output, active);
      } : undefined;
    return {
      metadata: {
        kind: 'rgba', format, width: image.width, height: image.height, sourceWidth, sourceHeight,
        regionAvailable: !!region, exportKind: nativeRows ? 'nativePng' : 'bitmapPng', details, warnings: image.warnings,
      },
      payload: new Uint8Array(image.pixels.buffer, image.pixels.byteOffset, image.pixels.byteLength),
      region, nativeRows,
    };
  };
  try {
    const head = await exact(0, Math.min(size, 4096));
    // Keep the existing Android prototype's ordinary PDF path. Native PdfRenderer performs
    // document parsing; the Mini Program's intentionally different policy is unchanged.
    if (!/\.ai$/i.test(name) && /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(ascii(head, 0, Math.min(head.length, 16)))) {
      return { metadata: { kind: 'pdf', format: 'PDF', details: 'PDF 兼容文档第一页',
        warnings: ['由 Android 系统 PDF 渲染器读取第一页；不解释编辑对象。'] } };
    }
    let nativeFormat: string | undefined;
    const signature = ascii(head, 0, Math.min(head.length, 12));
    if (/^GIF8[79]a/.test(signature)) nativeFormat = 'GIF';
    else if (signature.startsWith('BM')) nativeFormat = 'BMP';
    else if (head.length >= 12 && signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP') nativeFormat = 'WebP';
    else if (head.length >= 16 && ascii(head, 4, 4) === 'ftyp') {
      const box = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
      if (box >= 16 && box <= Math.min(4096, head.length) && box % 4 === 0) {
        const brands = [ascii(head, 8, 4)];
        for (let at = 16; at < box; at += 4) brands.push(ascii(head, at, 4));
        // A camera CR3 may advertise related brands; it must retain the RAW parser.
        if (!brands.includes('crx ') && brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand))) nativeFormat = 'HEIF';
      }
    }
    const format = nativeFormat || detectFormat(head, name);
    if (nativeFormat || format === 'JPEG' || format === 'PNG') {
      let dimensions: { width?: number; height?: number } = {};
      if (format === 'PNG') {
        if (head.length < 24) throw new QuickViewError('TRUNCATED', 'PNG 文件头不完整。');
        const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
        const width = view.getUint32(16), height = view.getUint32(20);
        if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw new QuickViewError('INVALID_DIMENSIONS', 'PNG 图像尺寸无效。');
        dimensions = { width, height };
      }
      current();
      return { metadata: { kind: 'native', format, ...dimensions, details: `${format} 本地图片`,
        warnings: ['由 Android 原生解码器校验图像并按预览预算缩小。'] } };
    }
    if (format === 'PSD' || format === 'PSB') {
      const header = readPhotoshopHeader(head);
      const description = `${photoshopDescription(header)}；原图 ${header.width} × ${header.height} px`;
      try {
        if (header.colorModeId === 3 && header.bitDepth === 8 && header.channels === 4
          && size <= LIMITS.photoshopBytes && Math.max(header.width, header.height) <= LIMITS.canvasSide) {
          checkImageBudget(header.width, header.height, size);
          const bytes = await exact(0, size);
          const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer;
          return rgba(format, decodePhotoshop(buffer), description, header.width, header.height, undefined);
        }
        let overview = true;
        const readComposite: AndroidRead = (offset, length) => overview ? ahead.read(offset, length) : exact(offset, length);
        const composite = await openPhotoshopComposite(readComposite, size, header,
          { rgb16Raw: true, rgb16RawBatchRows: 16, cropRaw8: true });
        const ratio = Math.min(1, LIMITS.canvasSide / Math.max(composite.width, composite.height));
        const image = await composite.decodeRegion({ x: 0, y: 0, width: composite.width, height: composite.height },
          { width: Math.max(1, Math.round(composite.width * ratio)), height: Math.max(1, Math.round(composite.height * ratio)) },
          { overview: true, isCurrent });
        overview = false;
        return rgba(format, image, description, header.width, header.height, () => composite,
          (rect, output, active) => composite.decodeRegion(rect, output, { isCurrent: active }));
      } catch (error) {
        current();
        // An unsupported composite may still have a genuine saved JPEG. Damaged data,
        // invalid ICC, budget failures and cancellation cannot silently become success.
        if (!(error instanceof QuickViewError) || !['UNSUPPORTED_PHOTOSHOP', 'UNSUPPORTED_COMPRESSION'].includes(error.code)) throw error;
        const thumbnail = await readPhotoshopThumbnail(exact, size, header);
        current();
        return { metadata: { kind: 'jpeg', format, width: thumbnail.width, height: thumbnail.height,
          sourceWidth: header.width, sourceHeight: header.height,
          details: description, warnings: [`合成图暂不可用：${error.message}`, '仅显示文件内保存的 1036 JPEG 缩略图，不是完整图像解码。'] }, payload: thumbnail.jpeg };
      }
    }
    if (format === 'RAW') {
      const image = await readCameraRawPreview(exact, size, isCurrent);
      current();
      // Native sampling can display a JPEG whose dimensions exceed the JS whole-image budget.
      // Carry the authoritative orientation into the JPEG without re-encoding scan data.
      const chosen = image.highest;
      const rotated = chosen.orientation >= 5;
      const sourceWidth = rotated ? chosen.height : chosen.width, sourceHeight = rotated ? chosen.width : chosen.height;
      return { metadata: { kind: 'jpeg', format, width: chosen.width, height: chosen.height, orientation: chosen.orientation,
        sourceWidth, sourceHeight, exportKind: 'cameraJpeg',
        details: `相机内嵌 JPEG ${sourceWidth} × ${sourceHeight} px`, warnings: [
          '只提取预算内最高有效相机 JPEG；未进行 RAW 传感器显影，不代表 RAW 原始分辨率。',
          '单份内嵌 JPEG 上限 8 MiB；保存保留相机 JPEG 的压缩像素和方向。',
        ] }, payload: rawPreviewJpeg(chosen.jpeg, chosen.orientation, { preserveUpright: true }) };
    }
    if (format === 'TIFF') {
      const bigTiff = head[2] === 43 || head[3] === 43;
      const metadata = await (bigTiff ? inspectBigTiffFile : inspectTiffFile)(exact, size);
      const { width, height, bitsPerSample, compression } = metadata.ifd;
      const description = `${bigTiff ? 'BigTIFF' : 'TIFF'} 第一页；原图 ${width} × ${height} px，${bitsPerSample} 位`;
      if (compression === 1) {
        return rgba(format, await previewRawTiff(ahead.read, size, metadata, isCurrent), description, width, height,
          () => rawTiffRows(exact, size, metadata),
          (region, output, active) => previewRawTiff(exact, size, metadata, active, { region, output }));
      }
      checkFileSize('TIFF', size);
      const image = decodeTiff(await exact(0, size));
      // Keep only operation descriptors while the preview is displayed. Re-run
      // the same bounded decoder when original-size output is requested.
      return rgba(format, { ...image, width: image.previewWidth, height: image.previewHeight }, description, width, height,
        async active => decodeTiff(await exact(0, size, active)).native);
    }
    if (format === 'SVG') {
      checkFileSize('SVG', size);
      const bytes = await exact(0, size);
      let text: string;
      // URI primitives supply strict UTF-8 conversion without Buffer or DOM codecs.
      try { text = decodeURIComponent(escape(ascii(bytes))); }
      catch {
        throw new QuickViewError('SVG_INVALID', 'SVG 必须是有效 UTF-8 文件。');
      }
      current();
      const image = parseSvg(text);
      current();
      const encoded = unescape(encodeURIComponent(image.svg));
      return { metadata: { kind: 'svg', format, width: image.width, height: image.height,
        sourceWidth: image.width, sourceHeight: image.height,
        ...(image.animation ? { svgDuration: Number.isFinite(image.animation.duration) ? image.animation.duration : null } : {}),
        details: image.animation ? '经过共享内核白名单校验的基础 SVG 动画' : '经过共享内核白名单校验与重建的静态 SVG',
        warnings: image.warnings }, payload: Uint8Array.from(encoded, char => char.charCodeAt(0)), animation: image.animation };
    }
    const inspection = await inspectAiFile(exact, size, isCurrent);
    current();
    return { metadata: { kind: 'pdf', format: 'AI', details: `PDF ${inspection.pdfVersion} 兼容内容第一页`, warnings: inspection.warnings } };
  } finally { ahead.clear(); }
}
