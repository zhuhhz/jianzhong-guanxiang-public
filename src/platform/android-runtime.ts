import { prepareAndroidPreview, type AndroidPreview } from './android';
import { writePngRows } from '../core/png-stream';

interface Bridge {
  read(token: number, offset: number, length: number): string;
  isCurrent(token: number): boolean;
  complete(token: number, metadata: string, payload: string): void;
  fail(token: number, message: string): void;
  isRegionCurrent(token: number, request: number): boolean;
  completeRegion(token: number, request: number, width: number, height: number, payload: string): void;
  failRegion(token: number, request: number, message: string): void;
  exportCurrent(token: number, request: number): boolean;
  writePng(token: number, request: number, base64: string): boolean;
  exportComplete(token: number, request: number, message: string): void;
}
const host = globalThis as unknown as {
  AndroidBridge: Bridge;
  JzgCore: {
    start(token: number, name: string, size: number): Promise<void>;
    clear(token: number): void;
    svgFrame(token: number, seconds: number): string | null;
    region(token: number, request: number, x: number, y: number, width: number, height: number,
      outputWidth: number, outputHeight: number): Promise<void>;
    exportPng(token: number, request: number): Promise<void>;
  };
  atob(value: string): string;
  btoa(value: string): string;
};
function encode(bytes?: Uint8Array): string {
  if (!bytes) return '';
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  }
  return host.btoa(parts.join(''));
}
function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

// A single decode may check for cancellation before every row. Bound the
// synchronous Java calls while retaining an exact check before a result.
function poll(check: () => boolean): () => boolean {
  let checked = -Infinity, current = false;
  return () => {
    const now = Date.now();
    if (now - checked >= 20) { current = check(); checked = now; }
    return current;
  };
}

// Only the packaged asset calls this bridge. SVG text is parsed as input data.
// Serialize runs so cancellation/reselection cannot retain several decoder heaps.
let pending = Promise.resolve();
let active: ({ token: number } & Pick<AndroidPreview, 'region' | 'nativeRows' | 'animation'>) | undefined;
function enqueue(task: () => Promise<void>): Promise<void> {
  pending = pending.then(task, task);
  return pending;
}

host.JzgCore = {
  start(token, name, size) {
    return enqueue(async () => {
      const bridge = host.AndroidBridge;
      try {
        if (!bridge.isCurrent(token)) return;
        active = undefined;
        const result = await prepareAndroidPreview(async (offset, length) => {
          const reply = JSON.parse(bridge.read(token, offset, length)) as { base64?: string; error?: string };
          if (reply.error || typeof reply.base64 !== 'string') throw new Error(reply.error || '本地读取失败');
          const binary = host.atob(reply.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return bytes;
        }, size, name, poll(() => bridge.isCurrent(token)));
        if (!bridge.isCurrent(token)) return;
        const payload = encode(result.payload);
        if (!bridge.isCurrent(token)) return;
        active = { token, region: result.region, nativeRows: result.nativeRows, animation: result.animation };
        bridge.complete(token, JSON.stringify(result.metadata), payload);
      } catch (error) {
        if (bridge.isCurrent(token)) bridge.fail(token, message(error));
      }
    });
  },
  clear(token) {
    if (active?.token === token) active = undefined;
  },
  svgFrame(token, seconds) {
    const animation = active?.token === token ? active.animation : undefined;
    if (!animation || !Number.isFinite(seconds) || seconds < 0) return null;
    try {
      const frame = animation.frame(Math.min(seconds, animation.duration));
      if (frame.length > 256 * 1024) return null;
      const bytes = unescape(encodeURIComponent(frame));
      return bytes.length <= 256 * 1024 ? host.btoa(bytes) : null;
    } catch {
      return null;
    }
  },
  region(token, request, x, y, width, height, outputWidth, outputHeight) {
    return enqueue(async () => {
      const bridge = host.AndroidBridge;
      const current = () => bridge.isRegionCurrent(token, request);
      try {
        if (!current()) return;
        const render = active?.token === token ? active.region : undefined;
        if (!render) throw new Error('当前文件不支持分段高清预览。');
        const raster = await render({ x, y, width, height }, { width: outputWidth, height: outputHeight }, poll(current));
        if (!current()) return;
        const payload = encode(new Uint8Array(raster.pixels.buffer, raster.pixels.byteOffset, raster.pixels.byteLength));
        if (current()) bridge.completeRegion(token, request, raster.width, raster.height, payload);
      } catch (error) {
        if (current()) bridge.failRegion(token, request, message(error));
      }
    });
  },
  exportPng(token, request) {
    return enqueue(async () => {
      const bridge = host.AndroidBridge;
      const current = () => bridge.exportCurrent(token, request);
      const check = poll(current);
      let errorMessage = '';
      try {
        if (!current()) throw new Error('已取消原尺寸 PNG 导出。');
        const openRows = active?.token === token ? active.nativeRows : undefined;
        if (!openRows) throw new Error('当前文件不支持原尺寸 PNG 导出。');
        const source = await openRows(check);
        await writePngRows(source.width, source.height, source.nativeChannels,
          consume => source.readRows(consume, { isCurrent: check }), async bytes => {
            if (!bridge.writePng(token, request, encode(bytes))) throw new Error('原尺寸 PNG 写入失败。');
          }, { isCurrent: check, srgb: source.nativeSrgb });
        if (!current()) throw new Error('已取消原尺寸 PNG 导出。');
      } catch (error) {
        errorMessage = message(error);
      }
      bridge.exportComplete(token, request, errorMessage);
    });
  },
};
