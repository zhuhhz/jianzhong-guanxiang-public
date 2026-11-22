import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseSvg } from '../src/core/svg';
import { LIMITS, QuickViewError } from '../src/core/shared';

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
