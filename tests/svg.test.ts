import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseSvg } from '../src/core/svg';
import { LIMITS, QuickViewError } from '../src/core/shared';
import { startSvgPlayback } from '../src/platform/svg-player';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'svg', name), 'utf8');
const wrap = (body: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" ${attrs}>${body}</svg>`;

for (const [name, width, height] of [
  ['basic.svg', 320, 180], ['path.svg', 100, 100], ['transform.svg', 200, 100],
  ['viewbox.svg', 240, 120], ['transparent.svg', 160, 90],
] as const) {
  test(`actual SVG fixture: ${name}`, () => {
    const source = fixture(name);
    const parsed = parseSvg(source);
    assert.equal(parsed.kind, 'svg');
    assert.equal(parsed.format, 'SVG');
    assert.equal(parsed.width, width);
    assert.equal(parsed.height, height);
    assert.deepEqual(parsed.warnings, []);
    assert.match(parsed.svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal(parseSvg(parsed.svg).svg, parsed.svg, 'sanitized SVG remains valid and stable');
  });
}

test('serializes allowed XML rather than passing source through', () => {
  const result = parseSvg('<?xml version="1.0"?><svg width="10" height="20"><!-- discarded --><title>A &lt; B &amp; &quot;safe&quot;</title><rect width="2" height="3"/></svg>');
  assert.equal(result.svg, '<svg width="10" height="20" viewBox="0 0 10 20" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"><title>A &lt; B &amp; &quot;safe&quot;</title><rect width="2" height="3"></rect></svg>');
});

test('keeps paths and native transformations without inventing geometry', () => {
  assert.match(parseSvg(fixture('path.svg')).svg, /A 40 40 0 0 1 10 50 Z/);
  assert.match(parseSvg(fixture('transform.svg')).svg, /transform="translate\(40 20\) rotate\(15\) scale\(1\.25\)"/);
});

test('samples cycling transforms, matching paths and blinking into safe static SVG frames', () => {
  const parsed = parseSvg(wrap(
    '<g transform="translate(10 5)"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s" additive="sum" repeatCount="indefinite"/>'
    + '<path d="M0 0 L4 8"><animate attributeName="d" values="M0 0 L4 8;M2 0 L8 4;M0 0 L4 8" dur="2s" repeatCount="indefinite"/></path>'
    + '<ellipse rx="2" ry="3"><animate attributeName="ry" values="3;0;3" keyTimes="0;0.5;1" dur="2s" repeatCount="indefinite"/></ellipse></g>'));
  assert.ok(parsed.animation);
  const midway = parsed.animation.frame(0.5);
  assert.match(midway, /transform="translate\(10 5\) rotate\(90\)"/);
  assert.match(midway, /d="M 1 0 L 6 6"/);
  assert.match(midway, /ry="1.5"/);
  assert.doesNotMatch(midway, /<animate/);
  assert.equal(parseSvg(midway).svg, midway);
  assert.equal(parsed.animation.frame(2), parsed.svg);
  assert.equal(parsed.animation.frame(0), parsed.svg, 'sampling must not mutate the first-frame export');
});

test('finite animations honor freeze, removal and discrete keyframe boundaries', () => {
  const freeze = parseSvg(wrap('<rect x="5"><animate attributeName="x" from="0" to="10" dur="1s" fill="freeze"/></rect>'));
  assert.match(freeze.animation!.frame(2), /x="10"/);
  const remove = parseSvg(wrap('<rect x="5"><animate attributeName="x" from="0" to="10" dur="1s"/></rect>'));
  assert.match(remove.animation!.frame(2), /x="5"/);
  const discrete = parseSvg(wrap('<g><animate attributeName="opacity" values="0;0.5;1" keyTimes="0;0.5;1" calcMode="discrete" dur="1s" fill="freeze"/></g>'));
  assert.match(discrete.animation!.frame(0.5), /opacity="0.5"/);
});

test('animation values cannot bypass resource, event, geometry or complexity validation', () => {
  for (const body of [
    '<g><animate attributeName="href" from="a" to="https://example.invalid/a" dur="1s"/></g>',
    '<g><animate attributeName="fill" values="red;url(https://example.invalid/a)" dur="1s"/></g>',
    '<g><animate attributeName="opacity" values="0;1" dur="1s" onbegin="x()"/></g>',
    '<g><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s" href="#target"/></g>',
    '<g><animate attributeName="opacity" values="0;1" dur="0.001s"/></g>',
    '<g><animate attributeName="opacity" values="0;2" dur="1s"/></g>',
    '<rect><animate attributeName="width" values="1;-2" dur="1s"/></rect>',
    '<path><animate attributeName="d" values="M0 0;M0 0 L1 1" dur="1s"/></path>',
    '<g><animate attributeName="opacity" values="0;1" keyTimes="0;0" dur="1s"/></g>',
    '<g><animate attributeName="opacity" values="0;1" dur="1s"/><animate attributeName="opacity" values="1;0" dur="1s"/></g>',
    '<g><animate attributeName="opacity" values="0;1" dur="1s" begin="click"/></g>',
    '<g><animate attributeName="opacity" values="0;1" dur="1s"><rect/></animate></g>',
    '<g><animate attributeName="opacity" values="' + Array.from({ length: 65 }, () => '0').join(';') + '" dur="1s"/></g>',
    '<g><animate attributeName="opacity" from="0" to="1" dur="1s"/></g>'.repeat(33),
  ]) assert.throws(() => parseSvg(wrap(body)), QuickViewError);
});

test('SVG playback decodes one frame at a time, fits the image and cancels pending work', () => {
  const runtime = globalThis as unknown as { wx: typeof wx };
  const previousWx = runtime.wx, previousNow = Date.now;
  let now = 1000, next = 0, stopped = 0;
  const scheduled = new Map<number, () => void>(), drawn: number[][] = [], sources: string[] = [];
  const images: { onload: () => void; onerror: () => void; src: string }[] = [];
  const context = { globalCompositeOperation: 'source-over',
    clearRect: () => assert.fail('A cleared display frame would flash between decoded images'),
    drawImage: (_image: unknown, ...rect: number[]) => { assert.equal(context.globalCompositeOperation, 'copy'); drawn.push(rect); },
  };
  const canvas = { width: 200, height: 200, createImage: () => {
    let source = '';
    const image = { onload: () => {}, onerror: () => {}, get src() { return source; },
      set src(value: string) { source = value; sources.push(value); } };
    images.push(image); return image;
  },
    getContext: () => context,
    requestAnimationFrame: (callback: () => void) => { scheduled.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => { scheduled.delete(id); },
  };
  try {
    Date.now = () => now;
    runtime.wx = { arrayBufferToBase64: (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64') } as typeof wx;
    const animation = parseSvg(wrap('<g><animate attributeName="opacity" from="0" to="1" dur="1s" repeatCount="indefinite"/></g>')).animation!;
    const cancel = startSvgPlayback(animation, canvas as unknown as WechatMiniprogram.Canvas,
      { width: 100, height: 50 }, () => true, () => { stopped++; });
    assert.equal(sources.length, 1); assert.equal(scheduled.size, 0);
    assert.equal(images.length, 2);
    images[0].onload();
    assert.equal(drawn.length, 0, 'Presentation waits for the next display frame');
    const presentation = next;
    const present = scheduled.get(presentation)!;
    scheduled.delete(presentation);
    present();
    assert.deepEqual(drawn[0], [0, 50, 200, 100]);
    assert.equal(scheduled.size, 1);
    const visibleSource = images[0].src;
    now += 100;
    scheduled.get(next)!(); scheduled.delete(next);
    assert.equal(sources.length, 2);
    assert.equal(images[0].src, visibleSource, 'Decoding must not replace the visible texture source');
    const lateLoad = images[1].onload;
    cancel.stop(); lateLoad();
    assert.equal(drawn.length, 1); assert.equal(stopped, 0);
    assert.equal(canvas.width, 1); assert.equal(canvas.height, 1);
  } finally { Date.now = previousNow; runtime.wx = previousWx; }
});

test('SVG playback pauses on its last frame, resumes the same time and displays the finite final frame', () => {
  const runtime = globalThis as unknown as { wx: typeof wx };
  const previousWx = runtime.wx, previousNow = Date.now;
  let now = 1000, next = 0;
  const scheduled = new Map<number, () => void>(), stops: boolean[] = [], sources: string[] = [];
  const images: { onload: () => void; onerror: () => void; src: string }[] = [];
  let pending = 0, visible = '';
  const canvas = { width: 200, height: 100, createImage: () => {
    const index = images.length;
    let source = '';
    const image = { onload: () => {}, onerror: () => {}, get src() { return source; },
      set src(value: string) { source = value; if (value) { sources.push(value); pending = index; } } };
    images.push(image); return image;
  },
    getContext: () => ({ drawImage: (image: { src: string }) => { visible = image.src; } }),
    requestAnimationFrame: (callback: () => void) => { scheduled.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => { scheduled.delete(id); },
  };
  const frame = () => Buffer.from(sources[sources.length - 1].split(',')[1], 'base64').toString('utf8');
  const advance = (milliseconds: number) => {
    now += milliseconds;
    const id = next, callback = scheduled.get(id)!;
    scheduled.delete(id); callback();
  };
  const present = () => { images[pending].onload(); advance(0); };
  let player: ReturnType<typeof startSvgPlayback> | undefined;
  try {
    Date.now = () => now;
    runtime.wx = { arrayBufferToBase64: (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64') } as typeof wx;
    const animation = parseSvg(wrap('<rect x="0"><animate attributeName="x" from="0" to="10" dur="1s" fill="freeze"/></rect>')).animation!;
    player = startSvgPlayback(animation, canvas as unknown as WechatMiniprogram.Canvas,
      { width: 100, height: 50 }, () => true, failed => { stops.push(failed); });
    present(); advance(250); present();
    assert.match(frame(), /x="2.5"/);
    const front = images[pending], lateError = front.onerror, lateLoad = front.onload;
    player.pause();
    assert.equal(scheduled.size, 0); assert.equal(canvas.width, 200);
    assert.equal(front.src, visible, 'Pausing must retain the last frame texture');
    assert.ok(front.src);
    now += 5000;
    player.resume(); lateError(); lateLoad(); present();
    assert.equal(canvas.width, 200);
    assert.match(frame(), /x="2.5"/);
    advance(1000); present();
    assert.match(frame(), /x="10"/);
    assert.deepEqual(stops, [false]);
    assert.equal(scheduled.size, 0); assert.equal(canvas.width, 200);
    player.restart(); present();
    assert.match(frame(), /x="0"/);
  } finally { player?.stop(); Date.now = previousNow; runtime.wx = previousWx; }
});

test('preserves transparent background and alpha', () => {
  const result = parseSvg(fixture('transparent.svg'));
  assert.match(result.svg, /rgba\(30, 120, 240, 0\.4\)/);
  assert.doesNotMatch(result.svg, /<rect|background/);
});

test('normalizes root percentages, absolute units, missing side, and fractional viewport', () => {
  assert.doesNotMatch(parseSvg(fixture('viewbox.svg')).svg, /100%/);
  const absolute = parseSvg('<svg width="1in" height="72pt"/>');
  assert.equal(absolute.width, 96);
  assert.equal(absolute.height, 96);
  const inferred = parseSvg('<svg width="150" viewBox="-5 -5 300 100"/>');
  assert.equal(inferred.height, 50);
  assert.match(inferred.svg, /viewBox="-5 -5 300 100"/);
  const fractional = parseSvg('<svg width="10.5" height="5.25"/>');
  assert.equal(fractional.width, 11);
  assert.equal(fractional.height, 6);
  assert.match(fractional.svg, /viewBox="0 0 10\.5 5\.25"/);
  assert.match(fractional.svg, /preserveAspectRatio="xMidYMid meet"/);
});

for (const name of ['doctype.svg', 'script.svg', 'external-resource.svg', 'malformed.svg']) {
  test(`rejects actual unsafe or invalid fixture: ${name}`, () => {
    assert.throws(() => parseSvg(fixture(name)), QuickViewError);
  });
}

const attacks = {
  'external DTD': '<!DOCTYPE svg SYSTEM "https://example.invalid/xxe"><svg width="1" height="1"/>',
  'entity expansion': '<!DOCTYPE svg [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg width="1" height="1"><title>&b;</title></svg>',
  'unknown entity': wrap('<title>&remote;</title>'),
  'attribute event': wrap('<rect width="1" height="1" onload="alert(1)"/>'),
  'numeric escaped event': wrap('<rect width="1" height="1" onload="&#97;lert(1)"/>'),
  'foreign object': wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
  'image URL': wrap('<image href="https://example.invalid/design.png"/>'),
  'data image': wrap('<image href="data:image/svg+xml;base64,abc"/>'),
  'local use': wrap('<use href="#shape"/>'),
  'local URL paint': wrap('<rect fill="url(#gradient)"/>'),
  'CSS style': wrap('<rect style="fill:url(https://example.invalid/x)"/>'),
  'CSS element': wrap('<style>@import "https://example.invalid/x";</style>'),
  'escaped URL': wrap('<rect fill="u&#114;l(https://example.invalid/x)"/>'),
  'CSS escape': wrap('<rect fill="u\\72l(https://example.invalid/x)"/>'),
  'stylesheet instruction': '<?xml-stylesheet href="https://example.invalid/x"?>' + wrap(''),
  'wrong namespace': '<svg xmlns="http://www.w3.org/1999/xhtml" width="1" height="1"/>',
  'namespace reset': wrap('<g xmlns=""><rect width="1" height="1"/></g>'),
  'xlink namespace': wrap('<g xmlns:xlink="http://www.w3.org/1999/xlink"/>'),
  'XML base': wrap('<g xml:base="https://example.invalid/"/>'),
  'XML 1.1': '<?xml version="1.1"?>' + wrap(''),
  'non UTF-8': '<?xml version="1.0" encoding="UTF-16"?>' + wrap(''),
  'duplicate attribute': '<svg width="1" width="2" height="1"/>',
  'unclosed root': '<svg width="1" height="1">',
  'multiple roots': '<svg width="1" height="1"/><svg width="1" height="1"/>',
  'case mismatch': '<svg width="1" height="1"></SVG>',
  'CDATA script': wrap('<title><![CDATA[<script/>]]></title>'),
  'control character': wrap('<title>\u0000</title>'),
};
for (const [name, source] of Object.entries(attacks)) {
  test(`rejects ${name}`, () => assert.throws(() => parseSvg(source), QuickViewError));
}

for (const body of ['<text>x</text>', '<defs/>', '<filter/>', '<mask/>', '<linearGradient/>', '<animate/>', '<svg/>']) {
  test(`explicit unsupported subset: ${body}`, () => assert.throws(() => parseSvg(wrap(body)), QuickViewError));
}

test('bounds bytes, dimensions, depth, nodes, attributes, and path complexity', () => {
  const cases = [
    ' '.repeat(LIMITS.svgBytes + 1),
    wrap(`<desc>${'中'.repeat(Math.ceil(LIMITS.svgBytes / 3))}</desc>`),
    '<svg width="4097" height="1"/>',
    '<svg width="2049" height="2049"/>',
    wrap('<g>'.repeat(32) + '</g>'.repeat(32)),
    wrap('<rect/>'.repeat(10000)),
    wrap(`<g ${Array.from({ length: 49 }, (_, n) => `a${n}="0"`).join(' ')}/>`),
    wrap(`<path d="M 0 0 ${'L 0 0 '.repeat(4000)}"/>`),
    wrap(`<path d="M 0 0 ${'L 0 0 '.repeat(3000)}"/>`.repeat(6)),
  ];
  for (const source of cases) assert.throws(() => parseSvg(source), QuickViewError);
});

test('rejects invalid dimensions, geometry, paths, paints and transforms', () => {
  const bodies = [
    '<rect width="-1"/>', '<rect width="100%"/>', '<circle r="NaN"/>', '<circle r="1e99"/>',
    '<path d="M 1"/>', '<path d="X 1 2"/>', '<path d="M 0 0 A -1 2 0 0 1 3 4"/>',
    '<path d="M 0 0 A 1 2 0 2 1 3 4"/>', '<path d="M 0 0 L Infinity 0"/>',
    '<polyline points="1 2 3"/>', '<g transform="translate(1,2,3)"/>', '<g transform="url(x)"/>',
    '<g opacity="2"/>', '<rect fill="rgb(1%,2%,3%)"/>',
  ];
  for (const body of bodies) assert.throws(() => parseSvg(wrap(body)), QuickViewError);
  for (const source of ['<svg/>', '<svg width="0" height="1"/>', '<svg viewBox="0 0 -1 1"/>', '<svg width="100%" height="100%"/>']) {
    assert.throws(() => parseSvg(source), QuickViewError);
  }
});
