import { LIMITS, QuickViewError } from './shared';

export type Format = 'RAW' | 'JPEG' | 'PNG' | 'PSD' | 'PSB' | 'TIFF' | 'AI' | 'SVG';
export const RAW_EXTENSIONS = ['arw', 'cr2', 'cr3', 'nef', 'raf', 'dng', 'raw'] as const;
export interface FileInfo {
  format: Format; filename: string; filesize: number;
  width?: number; height?: number; colorMode?: string; bitDepth?: number;
  previewAvailable: boolean; exportSupported: boolean; warnings: string[];
}

export function ascii(bytes: Uint8Array, start = 0, length = bytes.length - start): string {
  let text = '';
  const end = Math.min(bytes.length, start + length);
  for (let offset = start; offset < end; offset += 4096) {
    text += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 4096, end)));
  }
  return text;
}

export function isTiffHeader(head: Uint8Array): boolean {
  return head.length >= 4 && ((head[0] === 73 && head[1] === 73 && head[3] === 0 && [42, 43].includes(head[2]))
    || (head[0] === 77 && head[1] === 77 && head[2] === 0 && [42, 43].includes(head[3])));
}

export function detectFormat(head: Uint8Array, filename: string): Format {
  // Inspect actual container bytes before considering a returned filename.
  if (head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255) return 'JPEG';
  if (head.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => head[i] === b)
    && ascii(head, 12, 4) === 'IHDR' && new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(8) === 13) return 'PNG';
  if (ascii(head, 0, 16).startsWith('FUJIFILMCCD-RAW ')) {
    return 'RAW';
  }
  if (head.length >= 16 && ascii(head, 4, 4) === 'ftyp') {
    const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
    if (size < 16 || size % 4 || size > 4096) throw new QuickViewError('INVALID_IMAGE', '图像容器文件头无效或超出检查范围。');
    const brands = [ascii(head, 8, 4)];
    for (let at = 16; at + 4 <= Math.min(size, head.length); at += 4) brands.push(ascii(head, at, 4));
    if (brands.includes('crx ')) return 'RAW';
    if (brands.some(b => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(b))) {
      throw new QuickViewError('UNSUPPORTED_IMAGE', '取得的是 HEIC/HEIF 图像，不能作为相机 RAW 原始数据。当前不提供该图像的预览与保存；请以文件形式发送原始 RAW，或选择 JPEG/PNG。');
    }
  }
  if (/\.(?:arw|cr2|nef|dng|raw)$/i.test(filename)) {
    if (isTiffHeader(head) && (head[2] === 42 || head[3] === 42)) return 'RAW';
    throw new QuickViewError('UNSUPPORTED_RAW', '此 RAW 不是当前支持的经典 TIFF 容器，暂不支持；当前支持 ARW、CR2、NEF、DNG 中的可用内嵌 JPEG 预览。');
  }
  if (isTiffHeader(head)) return 'TIFF';
  const prefix = ascii(head, 0, Math.min(head.length, 4096));
  if (prefix.startsWith('8BPS')) {
    if (head.length < 6) throw new QuickViewError('TRUNCATED', 'Photoshop 文件头不完整。');
    const version = head[4] * 256 + head[5];
    if (version === 1) return 'PSD';
    if (version === 2) return 'PSB';
    throw new QuickViewError('UNSUPPORTED_VERSION', '不支持此 Photoshop 文件版本。');
  }
  if (/\.ai$/i.test(filename)) {
    if (prefix.startsWith('%PDF-')) return 'AI';
    if (prefix.startsWith('%!PS-Adobe')) throw new QuickViewError('AI_NO_PDF', '此 AI 文件未包含 PDF 兼容内容，请在 Illustrator 中启用 PDF 兼容后保存。');
    throw new QuickViewError('INVALID_AI', '未识别到 AI 文件中的有效 PDF 兼容文件头。');
  }
  if (prefix.startsWith('%PDF-') || /\.pdf$/i.test(filename)) throw new QuickViewError('UNSUPPORTED_FORMAT', '本工具不提供普通 PDF 预览，请使用微信自带的文档查看；AI 的 PDF 兼容预览与转发仍可使用。');
  // This only selects the strict XML parser; parseSvg must validate the actual root/namespace.
  if (/\.svg$/i.test(filename) || /^(?:\xEF\xBB\xBF)?\s*<(?:\?xml\s|svg(?:\s|>))/.test(prefix)) return 'SVG';
  throw new QuickViewError('UNSUPPORTED_FORMAT', '文件格式不支持，或文件头无效。请选择 RAW、PSD、PSB、TIFF、AI、SVG。');
}

export function checkFileSize(format: Format, size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new QuickViewError('EMPTY_FILE', '文件为空，或无法取得有效文件大小。');
  const max = format === 'SVG' ? LIMITS.svgBytes : format === 'AI' ? LIMITS.aiBytes : LIMITS.photoshopBytes;
  if (size > max) throw new QuickViewError('FILE_TOO_LARGE', format === 'SVG' ? 'SVG 文件超过 1 MiB 限制。' : '文件超过 32 MiB 限制；为保护设备内存，已停止读取。');
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  for (let start = bytes.indexOf(text.charCodeAt(0)); start >= 0; start = bytes.indexOf(text.charCodeAt(0), start + 1)) {
    if (start + text.length > bytes.length) return false;
    let match = true;
    for (let i = 1; i < text.length; i++) if (bytes[start + i] !== text.charCodeAt(i)) { match = false; break; }
    if (match) return true;
  }
  return false;
}

const aiIdentity = (bytes: Uint8Array) => containsAscii(bytes, 'Illustrator') || containsAscii(bytes, '/AIPrivateData');
const aiWarnings = () => ['已检查 PDF 文件头、索引、结束标记和 Illustrator 标识；完整兼容性由实际查看器确认。', 'AI 仅使用其 PDF 兼容内容，不重新渲染 Illustrator 编辑对象。'];
type PdfContainer = 'AI' | 'PDF';
type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;
export interface PdfInspection { warnings: string[]; pdfVersion: string; xrefOffset: number }

function pdfHeader(head: Uint8Array, kind: PdfContainer = 'AI'): string {
  const version = /^%PDF-(1\.[0-7]|2\.0)[\r\n]/.exec(ascii(head, 0, Math.min(head.length, 16)));
  if (!version) throw new QuickViewError(kind === 'AI' ? 'AI_NO_PDF' : 'INVALID_PDF',
    kind === 'AI' ? 'AI 文件缺少受支持的 PDF 兼容文件头。' : 'PDF 文件缺少受支持的文件头。');
  return version[1];
}
function pdfIndexOffset(tail: string, size: number, kind: PdfContainer = 'AI'): number {
  const match = /startxref\s+(\d+)\s+%%EOF[\x00\x09\x0A\x0C\x0D\x20]*$/.exec(tail);
  if (!match) throw new QuickViewError(`${kind}_INCOMPLETE`,
    kind === 'AI' ? 'AI 的 PDF 兼容结构不完整：缺少文件结束标记或索引。' : 'PDF 结构不完整：缺少文件结束标记或索引。');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 9 || offset >= size) throw new QuickViewError(`${kind}_INCOMPLETE`, `${kind === 'AI' ? 'AI 的 PDF' : 'PDF'} 索引偏移无效。`);
  return offset;
}
function pdfIndex(indexHead: string, tail: string, kind: PdfContainer = 'AI'): void {
  const classic = /^xref\s/.test(indexHead);
  const stream = /^\d+\s+\d+\s+obj\s*<</.test(indexHead) && /\/Type\s*\/XRef\b/.test(indexHead);
  if (!classic && !stream) throw new QuickViewError(`${kind}_INCOMPLETE`, `${kind === 'AI' ? 'AI 的 PDF' : 'PDF'} 索引位置与内容不一致。`);
  const trailer = classic ? tail.slice(tail.lastIndexOf('trailer')) : indexHead;
  if (!/\/Root\s+\d+\s+\d+\s+R\b/.test(trailer)) throw new QuickViewError(`${kind}_INCOMPLETE`, `${kind === 'AI' ? 'AI 的 PDF' : 'PDF'} 文档根目录引用缺失。`);
  if (/\/Encrypt\b/.test(trailer)) throw new QuickViewError(`${kind}_ENCRYPTED`, kind === 'AI' ? '暂不支持加密的 AI/PDF 兼容文件。' : '暂不支持加密的 PDF 文件。');
}

function documentReader(read: RangeReader, size: number, isCurrent: () => boolean, kind: PdfContainer): RangeReader {
  if (!Number.isSafeInteger(size) || size <= 0) throw new QuickViewError('EMPTY_FILE', `${kind} 文件大小无效。`);
  return async (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > size - offset) {
      throw new QuickViewError(`${kind}_INCOMPLETE`, `${kind} 文件读取范围无效。`);
    }
    if (!isCurrent()) throw new QuickViewError('CANCELLED', `已取消 ${kind} 检查。`);
    const bytes = await read(offset, length);
    if (!isCurrent()) throw new QuickViewError('CANCELLED', `已取消 ${kind} 检查。`);
    if (!bytes || bytes.byteLength !== length || bytes.length !== length) throw new QuickViewError('TRUNCATED', `${kind} 分段读取不完整。`);
    return bytes;
  };
}

// A bounded compatibility check, not a replacement PDF parser/reader. The native viewer
// remains responsible for full validation. No rendering or remote resource loading here.
export function inspectAi(bytes: Uint8Array): { warnings: string[] } {
  checkFileSize('AI', bytes.byteLength);
  pdfHeader(bytes);
  if (!aiIdentity(bytes)) {
    throw new QuickViewError('AI_IDENTITY', '此文件包含 PDF 数据，但未找到 Illustrator 标识；不能确认它是 PDF 兼容型 AI。');
  }
  const tail = ascii(bytes, Math.max(0, bytes.length - 8192));
  const offset = pdfIndexOffset(tail, bytes.length);
  const indexHead = ascii(bytes, offset, 2048);
  pdfIndex(indexHead, tail);
  return { warnings: aiWarnings() };
}

/** Bounded read-only container probe. Callers enforce their production size policy.
 * No PDF rendering/object rewriting; identity scanning visits at most the existing
 * 32 MiB budget, with overlap so an identifier crossing a block remains visible.
 */
export async function inspectAiFile(read: RangeReader, size: number,
  isCurrent: () => boolean = () => true): Promise<PdfInspection> {
  const exact = documentReader(read, size, isCurrent, 'AI');
  const pdfVersion = pdfHeader(await exact(0, Math.min(size, 16)));
  const tailBytes = await exact(Math.max(0, size - 8192), Math.min(size, 8192));
  let identity = aiIdentity(tailBytes), overlap = new Uint8Array(0);
  for (let offset = 0, limit = Math.min(size, LIMITS.aiBytes); !identity && offset < limit;) {
    const length = Math.min(64 * 1024, limit - offset), bytes = await exact(offset, length);
    const joined = new Uint8Array(overlap.length + length); joined.set(overlap); joined.set(bytes, overlap.length);
    identity = aiIdentity(joined); overlap = joined.slice(Math.max(0, joined.length - 13)); offset += length;
  }
  if (!identity) throw new QuickViewError('AI_IDENTITY', '在有界检查范围内未找到 Illustrator 标识，无法确认 PDF 兼容型 AI。');
  const tail = ascii(tailBytes), xrefOffset = pdfIndexOffset(tail, size);
  pdfIndex(ascii(await exact(xrefOffset, Math.min(2048, size - xrefOffset))), tail);
  return { warnings: aiWarnings(), pdfVersion, xrefOffset };
}
