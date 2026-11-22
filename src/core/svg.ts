import { SaxesParser } from 'saxes';
import { checkImageBudget, LIMITS, QuickViewError, utf8ByteLength } from './shared';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const LENGTH_RE = new RegExp(`^(${NUMBER})(px|mm|cm|in|pt|pc|%)?$`);
const UNITS: Record<string, number> = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16 };
const SHAPES: Record<string, string[]> = {
  svg: ['width', 'height', 'viewBox', 'preserveAspectRatio'],
  g: [],
  path: ['d', 'pathLength'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'pathLength'],
  circle: ['cx', 'cy', 'r', 'pathLength'],
  ellipse: ['cx', 'cy', 'rx', 'ry', 'pathLength'],
  line: ['x1', 'y1', 'x2', 'y2', 'pathLength'],
  polyline: ['points', 'pathLength'],
  polygon: ['points', 'pathLength'],
  title: [],
  desc: [],
};
const COMMON = new Set(['id', 'transform', 'fill', 'color', 'fill-opacity', 'fill-rule', 'opacity',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'vector-effect']);
const NONNEGATIVE = new Set(['width', 'height', 'r', 'rx', 'ry', 'pathLength', 'stroke-width']);
const PATH_ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

export interface SvgPreview {
  kind: 'svg';
  format: 'SVG';
  width: number;
  height: number;
  svg: string;
  warnings: string[];
}

function reject(message: string, code = 'SVG_UNSUPPORTED'): never {
  throw new QuickViewError(code, message);
}

function number(value: string): number {
  if (!NUMBER_RE.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e7) {
    return reject('SVG 数值无效或超出安全范围。', 'SVG_INVALID');
  }
  return Number(value);
}

function numbers(value: string, max = 20000): number[] {
  const tokens = value.trim().split(/[\s,]+/);
  if (!value.trim() || tokens.length > max) reject('SVG 数值列表为空或过于复杂。', 'SVG_LIMIT');
  return tokens.map(number);
}

function length(value: string, allowPercent = false): string {
  const match = LENGTH_RE.exec(value);
  if (!match) return reject('SVG 仅支持数值、px、mm、cm、in、pt、pc 和有参考视口的百分比尺寸。');
  const n = number(match[1]);
  const unit = match[2] || 'px';
  if (unit === '%') {
    if (!allowPercent) reject('微信原生 SVG 不支持百分比几何尺寸，请改用数值或绝对单位。');
    return `${n}%`;
  }
  const result = n * UNITS[unit];
  if (!Number.isFinite(result) || Math.abs(result) > 1e7) reject('SVG 尺寸超出安全范围。', 'SVG_LIMIT');
  return String(result);
}

function paint(value: string): string {
  if (/^#[\da-f]{3,4}$/i.test(value) || /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)
    || /^[a-z]{1,32}$/i.test(value)) return value;
  const match = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/i.exec(value);
  if (match) {
    const parts = match[2].split(',').map(p => p.trim());
    if (parts.some(p => p.includes('%'))) reject('微信原生 SVG 的当前子集不支持百分比颜色。');
    if (parts.length === (match[1].toLowerCase().endsWith('a') ? 4 : 3)) {
      for (const part of parts) number(part.endsWith('%') ? part.slice(0, -1) : part);
      return value;
    }
  }
  return reject('SVG 颜色仅支持纯色；不支持 CSS 或资源引用。');
}

function transform(value: string): void {
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)/g;
  let end = 0;
  let count = 0;
  for (let match = re.exec(value); match; match = re.exec(value)) {
    if (!/^[\s,]*$/.test(value.slice(end, match.index)) || ++count > 16) reject('SVG 变换过于复杂或格式无效。', 'SVG_LIMIT');
    const args = numbers(match[2], 6);
    const arities: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
    if (!arities[match[1]].includes(args.length)) reject('SVG 变换参数数量无效。', 'SVG_INVALID');
    end = re.lastIndex;
  }
  if (!count || value.slice(end).trim()) reject('SVG 变换格式无效。', 'SVG_INVALID');
}

function path(value: string): number {
  if (!value || value.length > 65536) reject('SVG 路径为空或超过复杂度限制。', 'SVG_LIMIT');
  const re = new RegExp(`[a-zA-Z]|${NUMBER}`, 'g');
  const tokens: string[] = [];
  let end = 0;
  for (let match = re.exec(value); match; match = re.exec(value)) {
    if (!/^[\s,]*$/.test(value.slice(end, match.index))) reject('SVG 路径包含无效字符。', 'SVG_INVALID');
    tokens.push(match[0]);
    if (tokens.length > 10000) reject('SVG 单条路径过于复杂。', 'SVG_LIMIT');
    end = re.lastIndex;
  }
  if (value.slice(end).trim() || !/^[Mm]$/.test(tokens[0] || '')) reject('SVG 路径必须以 moveto 开始。', 'SVG_INVALID');
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++].toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(PATH_ARITY, command)) reject('SVG 路径命令无效。', 'SVG_INVALID');
    const values: number[] = [];
    while (i < tokens.length && !/^[a-z]$/i.test(tokens[i])) values.push(number(tokens[i++]));
    const arity = PATH_ARITY[command];
    if (arity === 0 ? values.length !== 0 : !values.length || values.length % arity !== 0) reject('SVG 路径参数数量无效。', 'SVG_INVALID');
    if (command === 'A') {
      for (let n = 0; n < values.length; n += 7) {
        if (values[n] < 0 || values[n + 1] < 0 || ![0, 1].includes(values[n + 3]) || ![0, 1].includes(values[n + 4])) {
          reject('SVG 圆弧半径或标志无效。', 'SVG_INVALID');
        }
      }
    }
  }
  return tokens.length;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Strict XML parsing plus an SVG shape allowlist; input is never passed through. */
export function parseSvg(text: string): SvgPreview {
  if (text.length > LIMITS.svgBytes) reject('SVG 文件超过 1 MiB 本地处理上限。', 'SVG_LIMIT');
  const fileBytes = utf8ByteLength(text);
  if (fileBytes > LIMITS.svgBytes) reject('SVG 文件超过 1 MiB 本地处理上限。', 'SVG_LIMIT');
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
  const output: string[] = [];
  const stack: string[] = [];
  let width = 0;
  let height = 0;
  let nodes = 0;
  let complexity = 0;
  let namespace: string | undefined;
  let metadataLength = 0;
  parser.on('error', () => reject('XML 格式无效，无法安全读取 SVG。', 'SVG_INVALID'));
  parser.on('doctype', () => reject('SVG 禁止 DOCTYPE 和自定义实体。', 'SVG_UNSAFE'));
  parser.on('processinginstruction', () => reject('SVG 禁止处理指令和外部样式表。', 'SVG_UNSAFE'));
  parser.on('cdata', () => reject('当前安全子集不支持 CDATA。'));
  parser.on('opentag', tag => {
    const name = tag.local;
    const root = nodes === 0;
    if (++nodes > 10000 || stack.length >= 32) reject('SVG 节点数量或嵌套深度超过上限。', 'SVG_LIMIT');
    if (root) {
      if (name !== 'svg' || tag.prefix) reject('文件根节点必须为 SVG。', 'SVG_INVALID');
      namespace = tag.uri;
      if (namespace !== '' && namespace !== SVG_NS) reject('SVG 命名空间无效。', 'SVG_UNSAFE');
      if ((parser.xmlDecl.version && parser.xmlDecl.version !== '1.0')
        || (parser.xmlDecl.encoding && !/^utf-?8$/i.test(parser.xmlDecl.encoding))) reject('SVG 仅支持 UTF-8 XML 1.0。');
    } else if (name === 'svg' || !['svg', 'g'].includes(stack[stack.length - 1])) {
      reject('SVG 元素嵌套不属于当前支持范围。');
    }
    if (tag.prefix || tag.uri !== namespace || !Object.prototype.hasOwnProperty.call(SHAPES, name)) {
      reject(`当前不支持 SVG 元素：${name}。`);
    }
    const attrs: Record<string, string> = Object.create(null);
    const entries = Object.values(tag.attributes);
    if (entries.length > 48) reject('SVG 单个节点的属性数量超过上限。', 'SVG_LIMIT');
    for (const attr of entries) {
      if (attr.uri === XMLNS_NS) {
        if (attr.name !== 'xmlns' || attr.value !== SVG_NS) reject('SVG 禁止额外或重定义命名空间。', 'SVG_UNSAFE');
        continue;
      }
      const key = attr.local;
      const value = attr.value.trim();
      if (attr.prefix || attr.uri || /^on/i.test(key) || key === 'href' || key === 'style') reject('SVG 禁止事件、CSS 和资源引用属性。', 'SVG_UNSAFE');
      if (!COMMON.has(key) && !SHAPES[name].includes(key)) reject(`当前不支持 SVG 属性：${key}。`);
      if (value.length > (key === 'd' || key === 'points' ? 65536 : 4096)) reject('SVG 属性过长。', 'SVG_LIMIT');
      if (key === 'fill' || key === 'stroke' || key === 'color') attrs[key] = paint(value);
      else if (key === 'd') { complexity += path(value); attrs[key] = value; }
      else if (key === 'points') {
        const coords = numbers(value);
        if (coords.length < 4 || coords.length % 2) reject('SVG 点坐标必须成对。', 'SVG_INVALID');
        complexity += coords.length;
        attrs[key] = coords.join(' ');
      } else if (key === 'transform') { transform(value); attrs[key] = value; }
      else if (key === 'viewBox') {
        const box = numbers(value, 4);
        if (box.length !== 4 || box[2] <= 0 || box[3] <= 0) reject('SVG viewBox 无效。', 'SVG_INVALID');
        attrs[key] = box.join(' ');
      } else if (key === 'preserveAspectRatio') {
        if (!/^(none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)) reject('SVG 宽高比例设置无效。', 'SVG_INVALID');
        attrs[key] = value;
      } else if (key === 'id') {
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)) reject('SVG 标识无效。', 'SVG_INVALID');
        attrs[key] = value;
      } else if (key.endsWith('opacity') || key === 'opacity') {
        const n = number(value);
        if (n < 0 || n > 1) reject('SVG 不透明度必须在 0 和 1 之间。', 'SVG_INVALID');
        attrs[key] = String(n);
      } else if (key === 'stroke-dasharray') {
        if (value !== 'none' && numbers(value, 256).some(n => n < 0)) reject('SVG 虚线参数无效。', 'SVG_INVALID');
        attrs[key] = value;
      } else if (['fill-rule', 'stroke-linecap', 'stroke-linejoin', 'vector-effect'].includes(key)) {
        const choices: Record<string, string[]> = { 'fill-rule': ['nonzero', 'evenodd'], 'stroke-linecap': ['butt', 'round', 'square'], 'stroke-linejoin': ['miter', 'round', 'bevel'], 'vector-effect': ['none', 'non-scaling-stroke'] };
        if (!choices[key].includes(value)) reject('SVG 绘制属性无效。', 'SVG_INVALID');
        attrs[key] = value;
      } else {
        const normalized = length(value, root && (key === 'width' || key === 'height'));
        if (NONNEGATIVE.has(key) && parseFloat(normalized) < 0) reject('SVG 尺寸不能为负数。', 'SVG_INVALID');
        if (key === 'stroke-miterlimit' && Number(normalized) < 1) reject('SVG 斜接限制必须至少为 1。', 'SVG_INVALID');
        attrs[key] = normalized;
      }
    }
    if (complexity > 50000) reject('SVG 总路径复杂度超过上限。', 'SVG_LIMIT');
    if (root) {
      const box = attrs.viewBox ? numbers(attrs.viewBox, 4) : undefined;
      let w = attrs.width?.endsWith('%') ? undefined : attrs.width ? Number(attrs.width) : undefined;
      let h = attrs.height?.endsWith('%') ? undefined : attrs.height ? Number(attrs.height) : undefined;
      if ((attrs.width?.endsWith('%') || attrs.height?.endsWith('%')) && !box) reject('SVG 百分比尺寸需要 viewBox。');
      if (box) {
        if (w === undefined && h === undefined) { w = box[2]; h = box[3]; }
        else if (w === undefined) w = h! * box[2] / box[3];
        else if (h === undefined) h = w * box[3] / box[2];
      }
      if (w === undefined || h === undefined || w <= 0 || h <= 0 || !Number.isFinite(w) || !Number.isFinite(h)) reject('SVG 需要有效宽高或 viewBox。', 'SVG_INVALID');
      width = Math.ceil(w);
      height = Math.ceil(h);
      checkImageBudget(width, height, fileBytes);
      attrs.width = String(width);
      attrs.height = String(height);
      if (!box) attrs.viewBox = `0 0 ${w} ${h}`;
      attrs.preserveAspectRatio ||= 'xMidYMid meet';
      attrs.xmlns = SVG_NS;
    }
    const serialized = Object.entries(attrs).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
    output.push(`<${name}${serialized}>`);
    stack.push(name);
  });
  parser.on('closetag', () => { output.push(`</${stack.pop()}>`); });
  parser.on('text', value => {
    if (['title', 'desc'].includes(stack[stack.length - 1])) {
      metadataLength += value.length;
      if (metadataLength > 4096) reject('SVG 描述文字超过上限。', 'SVG_LIMIT');
      output.push(escapeXml(value));
    } else if (value.trim()) reject('当前安全子集不支持 SVG 文字内容。');
  });
  parser.write(text).close();
  if (!nodes || !width || !height || stack.length) reject('SVG 文件为空或不完整。', 'SVG_INVALID');
  return { kind: 'svg', format: 'SVG', width, height, svg: output.join(''), warnings: [] };
}
