import { QuickViewError } from './shared';

export interface SvgAnimation {
  frame(seconds: number): string;
  duration: number;
}

export interface SvgAnimationTrack {
  attribute: string;
  duration: number;
  value(seconds: number): string | undefined;
}

const animationKeys = new Set(['attributeName', 'type', 'from', 'to', 'values', 'dur', 'begin',
  'repeatCount', 'fill', 'calcMode', 'keyTimes', 'additive']);
const geometry: Record<string, string[]> = {
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
};
const numericPaint = ['opacity', 'fill-opacity', 'stroke-opacity', 'stroke-width', 'stroke-dashoffset'];

function reject(): never {
  throw new QuickViewError('SVG_ANIMATION_UNSUPPORTED',
    '此 SVG 动画超出支持范围。请使用基础旋转、位移、缩放、数值或结构一致的路径动画。');
}

function scalar(value: string): number {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) reject();
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e7) reject();
  return n;
}

function clock(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value);
  if (!match) reject();
  const seconds = Number(match[1]) / (match[2] === 'ms' ? 1000 : 1);
  if (seconds < 0.1 || seconds > 60) reject();
  return seconds;
}

/** Only interpolates values that have already passed the static SVG validator. */
export function svgAnimationTrack(name: string, attrs: Record<string, string>,
  parent: string, base: Record<string, string>, validatePath: (value: string) => number): SvgAnimationTrack {
  if (Object.keys(attrs).some(key => !animationKeys.has(key)) || parent === 'title' || parent === 'desc') reject();
  if (attrs.begin && attrs.begin !== '0s' && attrs.begin !== '0') reject();
  if (attrs.fill && !['remove', 'freeze'].includes(attrs.fill)) reject();
  if (attrs.calcMode && !['linear', 'discrete'].includes(attrs.calcMode)) reject();
  const duration = clock(attrs.dur || '');
  const repeats = attrs.repeatCount === 'indefinite' ? Infinity : scalar(attrs.repeatCount || '1');
  if (!(repeats > 0) || (Number.isFinite(repeats) && (!Number.isInteger(repeats) || repeats > 1000))) reject();
  const attribute = attrs.attributeName;
  const transform = name === 'animateTransform';
  if (transform ? attribute !== 'transform' || !['translate', 'rotate', 'scale'].includes(attrs.type)
    : !!attrs.type || !!attrs.additive || !(numericPaint.includes(attribute)
      || geometry[parent]?.includes(attribute) || (parent === 'path' && attribute === 'd'))) reject();
  if (attrs.additive && !['sum', 'replace'].includes(attrs.additive)) reject();
  if (attrs.values && (attrs.from !== undefined || attrs.to !== undefined)) reject();
  const values = attrs.values ? attrs.values.split(';').map(value => value.trim()) : [attrs.from, attrs.to];
  if (values.length < 2 || values.length > 64 || values.some(value => !value || value.length > 65536)) reject();
  let template: string[] = [];
  const frames = values.map(value => {
    if (attribute === 'd') {
      if (validatePath(value) > 4096 || /[Aa]/.test(value)) reject();
      const tokens = value.match(/[a-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)!;
      const pattern = tokens.map(token => /^[a-z]$/i.test(token) ? token : '');
      if (template.length && pattern.join('|') !== template.join('|')) reject();
      template = pattern;
      return tokens.filter(token => !/^[a-z]$/i.test(token)).map(scalar);
    }
    const numbers = value.split(/[\s,]+/).map(scalar);
    const arities = transform ? (attrs.type === 'rotate' ? [1, 3] : [1, 2]) : [1];
    if (!arities.includes(numbers.length)) reject();
    if (attribute.endsWith('opacity') && numbers.some(n => n < 0 || n > 1)) reject();
    if (['width', 'height', 'rx', 'ry', 'r', 'stroke-width'].includes(attribute) && numbers.some(n => n < 0)) reject();
    return numbers;
  });
  if (frames.some(frame => frame.length !== frames[0].length)) reject();
  const times = attrs.keyTimes ? attrs.keyTimes.split(';').map(value => scalar(value.trim()))
    : frames.map((_, index) => index / (frames.length - 1));
  if (times.length !== frames.length || times[0] !== 0 || times[times.length - 1] !== 1
    || times.some((time, index) => index > 0 && time <= times[index - 1])) reject();
  return {
    attribute, duration: duration * repeats,
    value(seconds) {
      const ended = seconds >= duration * repeats;
      if (ended && attrs.fill !== 'freeze') return;
      const phase = ended ? 1 : Math.max(0, seconds % duration) / duration;
      const end = times.findIndex((time, index) => index > 0 && time > phase);
      const high = end < 0 ? times.length - 1 : end;
      const low = high - 1;
      const mix = attrs.calcMode === 'discrete' ? (phase === 1 ? 1 : 0) : (phase - times[low]) / (times[high] - times[low]);
      const numbers = frames[low].map((n, index) => String(Number((n + (frames[high][index] - n) * mix).toFixed(5))));
      if (transform) return (attrs.additive === 'sum' && base.transform ? base.transform + ' ' : '')
        + attrs.type + '(' + numbers.join(' ') + ')';
      if (attribute !== 'd') return numbers[0];
      let index = 0;
      return template.map(token => token || numbers[index++]).join(' ');
    },
  };
}
