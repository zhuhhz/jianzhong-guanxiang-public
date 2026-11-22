import { LIMITS } from '../../core/shared';
import type { PhotoshopRegion } from '../../core/photoshop-preview';

export interface ViewRect { left: number; top: number; width: number; height: number }

/** Enough magnification for native-source pixels in the existing bounded overlay.
 * Wide/high-DPI viewports may need extra magnification because Canvas stays <=1365px.
 */
export function rawPixelZoom(source: { width: number; height: number }, area: ViewRect, pixelRatio: number) {
  if (![source.width, source.height, area.width, area.height, pixelRatio].every(Number.isFinite)
    || Math.min(source.width, source.height, area.width, area.height, pixelRatio) <= 0) return;
  const fit = Math.min(area.width / source.width, area.height / source.height);
  const density = Math.min(pixelRatio, LIMITS.canvasSide / Math.max(area.width, area.height));
  // Leave a two-pixel edge allowance for integer clipping of subpixel view bounds.
  return Math.max(1, 1.002 / (fit * density));
}

/** Map actual transformed component bounds, without guessing movable-view's scale origin. */
export function photoshopViewport(source: { width: number; height: number; previewWidth?: number },
  area: ViewRect, moved: ViewRect, pixelRatio: number) {
  if (![source.width, source.height, area.left, area.top, moved.left, moved.top, area.width, area.height,
    moved.width, moved.height, pixelRatio].every(Number.isFinite)
    || Math.min(source.width, source.height, area.width, area.height, moved.width, moved.height, pixelRatio) <= 0) return;
  const zoom = moved.width / area.width;
  if (Math.abs(moved.height / area.height - zoom) > 0.02 * zoom) return;
  const fit = Math.min(area.width / source.width, area.height / source.height);
  const left = (area.width - source.width * fit) / 2;
  const top = (area.height - source.height * fit) / 2;
  const imageX = moved.left + left * zoom;
  const imageY = moved.top + top * zoom;
  const scale = fit * zoom;
  const x = Math.max(0, (area.left - imageX) / scale);
  const y = Math.max(0, (area.top - imageY) / scale);
  const right = Math.min(source.width, (area.left + area.width - imageX) / scale);
  const bottom = Math.min(source.height, (area.top + area.height - imageY) / scale);
  if (right <= x || bottom <= y) return;
  const rect: PhotoshopRegion = { x, y, width: right - x, height: bottom - y };
  if (source.previewWidth !== undefined) {
    if (!Number.isFinite(source.previewWidth) || source.previewWidth <= 0
      || scale * pixelRatio <= source.previewWidth / source.width) return;
    // One bounded surface covers the whole visible source, reusing the RGB8 overlay.
    // Integer edges include the subpixel boundary without shifting its placement.
    const snap = (value: number) => Math.abs(value - Math.round(value)) < 1e-7 ? Math.round(value) : value;
    rect.x = Math.floor(snap(x)); rect.y = Math.floor(snap(y));
    rect.width = Math.ceil(snap(right)) - rect.x; rect.height = Math.ceil(snap(bottom)) - rect.y;
  }
  const density = Math.min(pixelRatio, LIMITS.canvasSide / Math.max(area.width, area.height));
  const rasterScale = source.previewWidth === undefined ? scale * density : Math.min(1, scale * density,
    LIMITS.canvasSide / Math.max(rect.width, rect.height));
  const output = { width: Math.max(1, Math.min(LIMITS.canvasSide, Math.round(rect.width * rasterScale))),
    height: Math.max(1, Math.min(LIMITS.canvasSide, Math.round(rect.height * rasterScale))) };
  return { rect, output, zoom,
    style: `left:${left + rect.x * fit}px;top:${top + rect.y * fit}px;width:${rect.width * fit}px;height:${rect.height * fit}px;` };
}
