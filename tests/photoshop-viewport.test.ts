import assert from 'node:assert/strict';
import { test } from 'node:test';
import { photoshopViewport, type ViewRect } from '../src/pages/index/photoshop-viewport';

const stage: ViewRect = { left: 0, top: 0, width: 400, height: 400 };
function tile(style: string): ViewRect {
  const values = Object.fromEntries(style.split(';').filter(Boolean).map(declaration => {
    const [key, value] = declaration.split(':');
    return [key, Number.parseFloat(value)];
  }));
  return { left: values.left, top: values.top, width: values.width, height: values.height };
}
function screenTile(style: string, moved: ViewRect, zoom: number): ViewRect {
  const box = tile(style);
  return { left: moved.left + box.left * zoom, top: moved.top + box.top * zoom,
    width: box.width * zoom, height: box.height * zoom };
}

test('aspect-fit letterboxing preserves the full wide or tall source and its image placement', () => {
  const area = { left: 10, top: 20, width: 400, height: 400 };
  for (const [source, expectedOutput, expectedTile] of [
    [{ width: 400, height: 200 }, { width: 800, height: 400 }, { left: 0, top: 100, width: 400, height: 200 }],
    [{ width: 200, height: 400 }, { width: 400, height: 800 }, { left: 100, top: 0, width: 200, height: 400 }],
  ] as const) {
    const view = photoshopViewport(source, area, area, 2);
    assert.ok(view);
    assert.equal(view.zoom, 1);
    assert.deepEqual(view.rect, { x: 0, y: 0, ...source });
    assert.deepEqual(view.output, expectedOutput);
    assert.deepEqual(tile(view.style), expectedTile);
  }
});

test('actual scaled component bounds map nonzero screen offsets to the correct original pixel rectangle', () => {
  const area = { left: 50, top: 100, width: 400, height: 400 };
  const moved = { left: -150, top: -300, width: 800, height: 800 };
  const view = photoshopViewport({ width: 400, height: 200 }, area, moved, 2);
  assert.ok(view);
  assert.equal(view.zoom, 2);
  assert.deepEqual(view.rect, { x: 100, y: 100, width: 200, height: 100 });
  assert.deepEqual(view.output, { width: 800, height: 400 });
  assert.deepEqual(tile(view.style), { left: 100, top: 200, width: 200, height: 100 });
  assert.deepEqual(screenTile(view.style, moved, view.zoom), { left: 50, top: 100, width: 400, height: 200 });
});

test('a panned letterboxed image clips to the visible source edge without treating blank space as pixels', () => {
  const moved = { left: -100, top: 50, width: 800, height: 800 };
  const view = photoshopViewport({ width: 400, height: 200 }, stage, moved, 1);
  assert.ok(view);
  assert.deepEqual(view.rect, { x: 50, y: 0, width: 200, height: 75 });
  assert.deepEqual(view.output, { width: 400, height: 150 });
  assert.deepEqual(tile(view.style), { left: 50, top: 100, width: 200, height: 75 });
  assert.deepEqual(screenTile(view.style, moved, view.zoom), { left: 0, top: 250, width: 400, height: 150 });
});

test('images entirely outside the viewport or touching only its edge do not schedule a tile', () => {
  for (const moved of [{ ...stage, left: 401 }, { ...stage, top: 400 }, { ...stage, top: -300 }]) {
    assert.equal(photoshopViewport({ width: 400, height: 200 }, stage, moved, 2), undefined);
  }
});

test('DPR affects raster resolution without applying zoom a second time to tile geometry', () => {
  const area = { left: 0, top: 0, width: 500, height: 500 };
  const moved = { left: -750, top: -750, width: 2000, height: 2000 };
  const source = { width: 1000, height: 1000 };
  const low = photoshopViewport(source, area, moved, 1);
  const high = photoshopViewport(source, area, moved, 8);
  assert.ok(low && high);
  assert.equal(high.zoom, 4);
  assert.deepEqual(high.rect, { x: 375, y: 375, width: 250, height: 250 });
  assert.deepEqual(low.rect, high.rect);
  assert.deepEqual(low.output, { width: 500, height: 500 });
  assert.deepEqual(high.output, { width: 1365, height: 1365 });
  assert.equal(low.style, high.style);
  assert.deepEqual(tile(high.style), { left: 187.5, top: 187.5, width: 125, height: 125 });
  assert.deepEqual(screenTile(high.style, moved, high.zoom), area);
});

test('invalid or inconsistently scaled component bounds cannot produce an unsafe region', () => {
  const source = { width: 400, height: 200 };
  assert.equal(photoshopViewport({ ...source, width: 0 }, stage, stage, 1), undefined);
  assert.equal(photoshopViewport(source, { ...stage, height: 0 }, stage, 1), undefined);
  assert.equal(photoshopViewport(source, stage, { ...stage, left: Infinity }, 1), undefined);
  assert.equal(photoshopViewport(source, stage, { ...stage, width: 800, height: 600 }, 1), undefined);
  for (const pixelRatio of [0, -1, NaN, Infinity]) {
    assert.equal(photoshopViewport(source, stage, stage, pixelRatio), undefined);
  }
});

test('RGB16 waits for useful display density, then covers the entire visible original region', () => {
  const source = { width: 6016, height: 4016, previewWidth: 1365 };
  assert.equal(photoshopViewport(source, stage, stage, 3), undefined);
  const moved = { left: -200, top: -200, width: 800, height: 800 };
  const view = photoshopViewport(source, stage, moved, 3);
  assert.ok(view);
  assert.deepEqual(view.rect, { x: 1504, y: 504, width: 3008, height: 3008 });
  assert.deepEqual(view.output, { width: 1200, height: 1200 });
  const screen = screenTile(view.style, moved, 2);
  assert.ok(Math.abs(screen.left + screen.width / 2 - 200) < 1e-8);
  assert.ok(Math.abs(screen.top + screen.height / 2 - 200) < 1e-8);
  assert.deepEqual(screen, stage);
});

test('RGB16 visible patches use integer boundaries, clamp edges and never enlarge original pixels', () => {
  const source = { width: 6016, height: 4016, previewWidth: 1365 };
  const zoom = 32;
  const fit = stage.width / source.width;
  const letterbox = (stage.height - source.height * fit) / 2;
  for (const [centerX, centerY] of [[100, 100], [5900, 3900], [3000, 2000]]) {
    const moved = { left: 200 - centerX * fit * zoom, top: 200 - (letterbox + centerY * fit) * zoom,
      width: stage.width * zoom, height: stage.height * zoom };
    const view = photoshopViewport(source, stage, moved, 3);
    assert.ok(view);
    assert.ok(Number.isInteger(view.rect.x) && Number.isInteger(view.rect.y));
    assert.ok(view.rect.x >= 0 && view.rect.y >= 0 && view.rect.x + view.rect.width <= source.width
      && view.rect.y + view.rect.height <= source.height);
    assert.deepEqual(view.output, { width: view.rect.width, height: view.rect.height });
    const screen = screenTile(view.style, moved, zoom);
    assert.ok(Math.abs(screen.left - (moved.left + view.rect.x * fit * zoom)) < 1e-8);
  }
});

test('fractional RGB16 bounds cover visible edges with at most one source pixel of padding', () => {
  const source = { width: 6016, height: 4016, previewWidth: 1365 };
  const moved = { left: -233.33, top: -179.87, width: 1000, height: 1000 };
  const view = photoshopViewport(source, stage, moved, 8)!;
  const screen = screenTile(view.style, moved, view.zoom);
  const sourcePixel = 400 / source.width * view.zoom;
  assert.ok(screen.left <= stage.left && screen.left > stage.left - sourcePixel);
  assert.ok(screen.top <= stage.top && screen.top > stage.top - sourcePixel);
  assert.ok(screen.left + screen.width >= 400 && screen.left + screen.width < 400 + sourcePixel);
  assert.ok(screen.top + screen.height >= 400 && screen.top + screen.height < 400 + sourcePixel);
  assert.ok(view.output.width <= 1365 && view.output.height <= 1365);
});
