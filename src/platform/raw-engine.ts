import { initWechat, inspectRaw, decodeRaw, memoryBytes } from '../vendor/flashraw';
import { QuickViewError } from '../core/shared';

let pending: Promise<void> | undefined;

/** WeChat rejects native loads with {errMsg, mod}, not necessarily an Error. */
export function rawFailureMessage(error: unknown): string {
  const detail = typeof error === 'string' ? error : error && typeof error === 'object'
    ? (error as { message?: unknown; errMsg?: unknown }).message || (error as { errMsg?: unknown }).errMsg : undefined;
  return typeof detail === 'string' && detail.trim() ? detail.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : '未返回具体错误信息';
}

export async function rawEngine() {
  const runtimeRequire = typeof require === 'function' ? require as unknown as { async?: (path: string) => Promise<unknown> } : undefined;
  if (typeof WXWebAssembly === 'undefined') {
    throw new QuickViewError('RAW_ENGINE_UNAVAILABLE', '当前微信没有 WXWebAssembly，无法启动本地 RAW 显影引擎。');
  }
  if (!runtimeRequire || typeof runtimeRequire.async !== 'function') {
    throw new QuickViewError('RAW_SUBPACKAGE_UNAVAILABLE', '当前微信没有 require.async，无法加载 RAW 显影分包。');
  }
  // This module is bundled into pages/index/index.js; async require loads the asset-only subpackage.
  if (!pending) pending = (async () => {
    try { await runtimeRequire.async!('../../raw-engine/entry.js'); }
    catch (error) { throw new QuickViewError('RAW_SUBPACKAGE_LOAD', `RAW 分包加载失败：${rawFailureMessage(error)}`); }
    try { await initWechat('/raw-engine/flashraw.wasm.br'); }
    catch (error) { throw new QuickViewError('RAW_ENGINE_INIT', `RAW WASM 初始化失败：${rawFailureMessage(error)}`); }
  })().catch(error => { pending = undefined; throw error; });
  await pending;
  return { inspect: inspectRaw, decode: decodeRaw, memoryBytes };
}
