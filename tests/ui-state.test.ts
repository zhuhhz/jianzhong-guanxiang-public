import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { LIMITS, QuickViewError } from '../src/core/shared';
import { photoshopViewport, rawPixelZoom } from '../src/pages/index/photoshop-viewport';
import type { PhotoshopDetail } from '../src/platform/wechat';

const code = transformSync(readFileSync('src/pages/index/index.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const selected = { path: '/chat/design.psd', name: 'design.psd', size: 1024 };
const preview = { info: { format: 'PSD', filename: selected.name, filesize: selected.size,
  width: 2, height: 3, warnings: [], exportSupported: true, previewAvailable: true },
  previewPath: '/local/preview.png', exportPath: '/local/preview.png' };

// Run the actual Page handlers against native API stubs; parser tests use real files separately.
function loadPage(overrides: Record<string, unknown> = {}, wxOverrides: Record<string, any> = {}) {
  let definition: Record<string, any> = {};
  let cleanups = 0;
  const opened: string[] = [];
  const saved: string[] = [];
  const nativeSaved: string[] = [];
  const updates: unknown[] = [];
  const accessFailures: (() => void)[] = [];
  const storageValues = new Map<string, unknown>();
  const storageReads: string[] = [];
  const storageWrites: { key: string; value: unknown }[] = [];
  const navigationColors: Record<string, any>[] = [];
  const backgroundColors: Record<string, any>[] = [];
  const toasts: Record<string, any>[] = [];
  const modals: WechatMiniprogram.ShowModalOption[] = [];
  const platform = {
    chooseDesignFile: async () => selected,
    preparePreview: async () => preview,
    openAiDocument: async (path: string) => { opened.push(path); },
    savePng: async (path: string) => { saved.push(path); },
    previewRawJpeg: async () => {},
    saveRawJpeg: async (path: string) => { saved.push(path); },
    saveNativePng: async (path: string) => { nativeSaved.push(path); },
    sharePdfDocument: async () => {},
    cleanupPreview: async () => { cleanups++; },
    ...overrides,
  };
  const wx = { nextTick: (callback: () => void) => callback(), canIUse: () => true,
    saveImageToPhotosAlbum: () => {},
    getFileSystemManager: () => ({ access: (options: { fail: () => void }) => { accessFailures.push(options.fail); } }),
    showModal: (options: WechatMiniprogram.ShowModalOption) => { modals.push(options); },
    ...wxOverrides,
    getStorageSync: (key: string) => {
      storageReads.push(key);
      return wxOverrides.getStorageSync ? wxOverrides.getStorageSync(key) : storageValues.get(key);
    },
    setStorageSync: (key: string, value: unknown) => {
      storageWrites.push({ key, value });
      if (wxOverrides.setStorageSync) wxOverrides.setStorageSync(key, value);
      else storageValues.set(key, value);
    },
    setNavigationBarColor: (options: Record<string, any>) => {
      navigationColors.push(options);
      wxOverrides.setNavigationBarColor?.(options);
    },
    setBackgroundColor: (options: Record<string, any>) => {
      backgroundColors.push(options);
      wxOverrides.setBackgroundColor?.(options);
    },
    showToast: (options: Record<string, any>) => {
      toasts.push(options);
      wxOverrides.showToast?.(options);
    } };
  runInNewContext(code, { Page: (value: Record<string, any>) => { definition = value; }, wx, Error, setTimeout, clearTimeout, getApp: wxOverrides.getApp,
    require: (id: string) => {
      if (id === '../../core/shared') return { LIMITS, QuickViewError };
      if (id === './photoshop-viewport') return { photoshopViewport, rawPixelZoom };
      assert.equal(id, '../../platform/wechat'); return platform;
    } });
  const page: Record<string, any> = { ...definition, data: { ...definition.data },
    setData(update: Record<string, unknown>, callback?: () => void) { updates.push(update); Object.assign(this.data, update); callback?.(); },
    createSelectorQuery: () => ({ select: () => ({ fields: () => ({ exec: (callback: (results: unknown[]) => void) => callback([{ node: {} }]) }) }) }) };
  for (const [key, value] of Object.entries(page)) if (typeof value === 'function') page[key] = value.bind(page);
  return { page, opened, saved, nativeSaved, updates, accessFailures, storageValues, storageReads, storageWrites,
    navigationColors, backgroundColors, toasts, modals, cleanups: () => cleanups };
}

test('chat material opens in the normal PSD preview without reopening the file picker', async () => {
  const file = { ...selected, path: 'wxfile://tmp_sample', source: 'chat-open' };
  let pending: typeof file | 'unavailable' | undefined = file, prepared = 0;
  const { page, toasts, modals } = loadPage({ chooseDesignFile: () => assert.fail('direct open invoked the selector'),
    preparePreview: async (chosen: unknown) => { assert.equal(chosen, file); prepared++; return preview; } },
  { getApp: () => ({ takeChatPsd: () => { const next = pending; pending = undefined; return next; } }) });
  page.onShow();
  await waitFor(() => !page.data.busy, 'direct open completed');
  assert.equal(prepared, 1);
  assert.equal(page.data.format, 'PSD');
  assert.equal(page.data.fileFacts.find((fact: { label: string }) => fact.label === '导入来源')?.value, '聊天直接打开');
  page.onShow(); assert.equal(prepared, 1);
  pending = file; page.setData({ busy: true }); page.onShow();
  assert.equal(prepared, 1); assert.match(toasts[toasts.length - 1]?.title, /当前操作/);
  pending = 'unavailable'; page.setData({ busy: false }); page.onShow();
  assert.equal(page.data.errorCode, 'CHAT_PSD_UNAVAILABLE'); assert.equal(page.data.previewPath, preview.previewPath);
  assert.equal(modals.length, 1); assert.match(modals[0].content ?? '', /微信未提供可读取的 PSD/);
});

test('sharing always points to the home page with a fixed cover, even during a file preview', () => {
  const menus: string[][] = [];
  const { page } = loadPage({}, {
    showShareMenu: (options: WechatMiniprogram.ShowShareMenuOption) => menus.push([...(options.menus ?? [])]),
  });
  page.onLoad();
  assert.deepEqual(menus, [['shareAppMessage', 'shareTimeline']]);
  page.setData({ hasFile: true, filename: 'private.psd', previewPath: '/local/private.png' });
  const share = page.onShareAppMessage({ from: 'menu' });
  assert.deepEqual({ ...share }, {
    title: '鉴中观象 · 设计文件，打开就看',
    path: '/pages/index/index',
    imageUrl: '/assets/share-cover.png',
  });
  assert.deepEqual({ ...page.onShareTimeline() }, {
    title: share.title,
    query: '',
  });
});

function controlledDetail() {
  const calls: { rect: { x: number; y: number; width: number; height: number };
    output: { width: number; height: number }; isCurrent: () => boolean;
    finish: (path: string) => void; fail: (error: Error) => void }[] = [];
  const released: string[] = [];
  let active = 0, maximum = 0;
  const detail: PhotoshopDetail = { width: 6000, height: 4000,
    render(rect, output, isCurrent) {
      active++; maximum = Math.max(maximum, active);
      return new Promise<string>((finish, fail) => calls.push({ rect: { ...rect }, output: { ...output },
        isCurrent, finish, fail })).finally(() => { active--; });
    },
    async release(path) { released.push(path); },
  };
  return { detail, calls, released, active: () => active, maximum: () => maximum };
}

const detailedPreview = (detail: PhotoshopDetail) => ({ ...preview, info: { ...preview.info,
  width: detail.width, height: detail.height }, detail });

function detailGeometry(page: Record<string, any>) {
  const area = { left: 0, top: 0, width: 300, height: 200 };
  const moved = { left: -150, top: -100, width: 600, height: 400 };
  let queries = 0;
  page.getCanvas = async () => ({});
  page.createSelectorQuery = () => {
    const selectors: string[] = [];
    const query: Record<string, any> = { select(selector: string) { selectors.push(selector); return query; },
      boundingClientRect() { return query; },
      exec(done: (results: unknown[]) => void) {
        assert.deepEqual(selectors, ['.preview-area', '.preview-image-wrap']);
        queries++; done([{ ...area }, { ...moved }]);
      } };
    return query;
  };
  return { area, moved, queries: () => queries };
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('canceling selection preserves the current preview without deleting its files', async () => {
  const { page, cleanups, modals } = loadPage({ chooseDesignFile: async () => { throw new Error('已取消选择'); } });
  page.data.hasFile = true;
  page.data.previewPath = '/local/existing.png';
  await page.chooseFile();
  assert.equal(page.data.previewPath, '/local/existing.png');
  assert.equal(page.data.hasFile, true);
  assert.equal(page.data.errorMessage, '');
  assert.equal(page.data.busy, false);
  assert.equal(cleanups(), 0);
  assert.equal(modals.length, 0);
});

test('real parser errors keep the selected filename and expose an actionable message', async () => {
  const { page, modals } = loadPage({ preparePreview: async () => { throw new Error('图像尺寸超出限制。'); } });
  await page.chooseFile();
  assert.equal(page.data.filename, selected.name);
  assert.equal(page.data.errorMessage, '图像尺寸超出限制。');
  assert.equal(page.data.previewPath, '');
  assert.equal(page.data.canSave, false);
  assert.equal(page.data.busy, false);
  assert.equal(modals.length, 1);
  assert.equal(modals[0].title, '无法读取文件');
  assert.equal(modals[0].content, page.data.errorMessage);
  assert.equal(modals[0].showCancel, false);
});

test('returning home clears the preview without opening a picker and permits a new selection', async () => {
  let pickerCalls = 0;
  const { page, accessFailures, cleanups } = loadPage({ chooseDesignFile: async () => { pickerCalls++; return selected; } });
  const home = JSON.parse(JSON.stringify(page.data));
  await page.chooseFile();
  page.onShow();
  page.zoomIn();
  const beforeReturn = cleanups();
  page.backToHome();
  accessFailures[0](); // A check from the discarded preview must not report an error on home.
  assert.deepEqual(JSON.parse(JSON.stringify(page.data)), home);
  assert.equal(page.exportPath, '');
  assert.equal(page.documentPath, '');
  assert.ok(cleanups() > beforeReturn);
  assert.equal(pickerCalls, 1);
  assert.equal(page.disposed, false);
  await page.chooseFile();
  assert.equal(pickerCalls, 2);
  assert.equal(page.data.hasFile, true);
  assert.equal(page.data.previewPath, preview.previewPath);
});

test('unloading during parsing discards late results and cleans generated files', async () => {
  let finish!: (value: typeof preview) => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const pending = new Promise<typeof preview>(resolve => { finish = resolve; });
  const { page, updates, cleanups } = loadPage({ preparePreview: () => { notifyStarted(); return pending; } });
  const task = page.chooseFile();
  await started;
  page.onUnload();
  const count = updates.length;
  finish(preview);
  await task;
  assert.equal(updates.length, count);
  assert.equal(page.data.previewPath, '');
  assert.equal(cleanups(), 3);
});

test('unloading during native canvas lookup prevents parsing and retaining the canvas', async () => {
  let resolveNode!: (results: unknown[]) => void;
  let notifyLookup!: () => void;
  let parsed = false;
  const lookup = new Promise<void>(resolve => { notifyLookup = resolve; });
  const { page } = loadPage({ preparePreview: async () => { parsed = true; return preview; } });
  page.createSelectorQuery = () => ({ select: () => ({ fields: () => ({ exec: (callback: typeof resolveNode) => { resolveNode = callback; notifyLookup(); } }) }) });
  const task = page.chooseFile();
  await lookup;
  page.onUnload();
  resolveNode([{ node: {} }]);
  await task;
  assert.equal(parsed, false);
  assert.equal(page.canvas, undefined);
});

test('AI opens through the native viewer and retains a reopen action without PNG export', async () => {
  const ai = { info: { ...preview.info, format: 'AI', exportSupported: false, previewAvailable: false }, documentPath: '/local/checked.pdf' };
  const { page, opened, saved } = loadPage({ preparePreview: async () => ai });
  await page.chooseFile();
  assert.equal(page.data.isDocument, true);
  assert.equal(page.data.canSave, false);
  assert.equal(page.data.previewPath, '');
  await page.openDocument();
  await page.saveImage();
  assert.deepEqual(opened, ['/local/checked.pdf', '/local/checked.pdf']);
  assert.deepEqual(saved, []);
});

test('PNG save uses the prepared export and ignores an expired check from the previous file', async () => {
  const { page, saved, accessFailures } = loadPage();
  page.data.previewPath = '/local/previous.png';
  page.onShow();
  await page.chooseFile();
  accessFailures[0]();
  assert.equal(page.data.previewPath, preview.previewPath);
  assert.equal(page.data.dimensions, '2 × 3 px');
  await page.saveImage();
  assert.deepEqual(saved, [preview.exportPath]);
  assert.equal(page.data.errorMessage, '');
});

test('an expired preview opens one dialog even when multiple access checks fail', async () => {
  const { page, modals, accessFailures } = loadPage();
  await page.chooseFile();
  page.onShow();
  for (const fail of accessFailures) fail();
  assert.equal(page.data.errorCode, 'FILE_EXPIRED');
  assert.equal(modals.length, 1);
  assert.match(modals[0].content ?? '', /临时预览已失效/);
});

test('native image errors during busy state are reported while stale image errors are ignored', async () => {
  const { page, modals } = loadPage();
  const setData = page.setData;
  page.setData = (update: Record<string, unknown>, callback?: () => void) => {
    setData(update, callback);
    if (update.previewPath) page.onPreviewError({ currentTarget: { dataset: { path: update.previewPath } } });
  };
  await page.chooseFile();
  assert.equal(page.data.busy, false);
  assert.equal(page.data.canSave, false);
  assert.equal(page.data.previewPath, '');
  assert.match(page.data.errorMessage, /无法显示/);
  page.data.previewPath = '/local/next.png';
  page.data.errorMessage = '';
  page.onPreviewError({ currentTarget: { dataset: { path: '/local/old.png' } } });
  assert.equal(page.data.previewPath, '/local/next.png');
  assert.equal(page.data.errorMessage, '');
  assert.equal(modals.length, 1);
  assert.match(modals[0].content ?? '', /无法显示/);
});

test('only tiny raster previews disable display smoothing while saving the original PNG', async () => {
  for (const [format, width, height, tiny] of [
    ['PSD', 3, 2, true], ['PSB', 6, 1, true], ['PSD', 32, 32, true],
    ['PSD', 33, 1, false], ['PSD', 600, 420, false], ['SVG', 3, 2, false],
  ] as const) {
    const { page, saved } = loadPage({ preparePreview: async () => ({ ...preview,
      info: { ...preview.info, format, width, height } }) });
    const draws: unknown[][] = [];
    const context = { imageSmoothingEnabled: true, drawImage: (...args: unknown[]) => { draws.push(args); } };
    const display = { width: 0, height: 0, getContext: () => context,
      createImage: () => ({ onload: () => {}, set src(path: string) { assert.equal(path, preview.previewPath); this.onload(); } }) };
    page.getCanvas = async () => ({}); // Export canvas is provided to the existing platform preparation only.
    page.createSelectorQuery = () => ({ select: () => ({ fields: () => ({ exec: (done: (value: unknown[]) => void) =>
      done([{ node: display, width: 300, height: 360 }]) }) }) });
    await page.chooseFile();
    assert.equal(page.data.pixelPreview, tiny);
    assert.equal(context.imageSmoothingEnabled, !tiny);
    assert.equal(draws.length, tiny ? 1 : 0);
    assert.ok(Math.max(display.width, display.height) <= LIMITS.canvasSide);
    assert.equal(page.exportPath, preview.exportPath);
    await page.saveImage();
    assert.deepEqual(saved, [preview.exportPath]);
  }
});

test('unsupported pixel display falls back without losing the PNG or accepting stale callbacks', async () => {
  const { page, saved } = loadPage();
  page.getCanvas = async () => ({});
  let finish!: (value: unknown[]) => void;
  page.createSelectorQuery = () => ({ select: () => ({ fields: () => ({ exec: (done: typeof finish) => { finish = done; } }) }) });
  await page.chooseFile();
  finish([{ node: { getContext: () => ({}) }, width: 300, height: 360 }]);
  assert.equal(page.data.pixelPreview, false);
  assert.equal(page.data.canSave, true);
  await page.saveImage();
  assert.deepEqual(saved, [preview.exportPath]);
  await page.chooseFile();
  page.backToHome();
  const home = JSON.stringify(page.data);
  finish([]);
  assert.equal(JSON.stringify(page.data), home);
});

test('HD viewport changes debounce to the final bounds and keep at most one render in flight', async () => {
  const control = controlledDetail();
  const { page, updates } = loadPage({ preparePreview: async () => detailedPreview(control.detail) },
    { getSystemInfoSync: () => ({ pixelRatio: 2 }) });
  const geometry = detailGeometry(page);
  await page.chooseFile();
  assert.equal(page.data.zoomMax, 64);
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  geometry.moved.left = -120; geometry.moved.top = -80;
  page.onMove({ detail: { x: -120, y: -80, source: 'touch' } });
  geometry.moved.left = -200; geometry.moved.top = -100;
  page.onMove({ detail: { x: -200, y: -100, source: 'touch' } });
  assert.equal(control.calls.length, 0);
  await waitFor(() => control.calls.length === 1, 'Final debounced viewport must start rendering');
  assert.deepEqual(control.calls[0].rect, { x: 2000, y: 1000, width: 3000, height: 2000 });
  assert.deepEqual(control.calls[0].output, { width: 600, height: 400 });
  const firstTask = page.detailTask;

  geometry.moved.left = -240; geometry.moved.top = -140;
  page.onMove({ detail: { x: -240, y: -140, source: 'touch' } });
  geometry.moved.left = -260; geometry.moved.top = -160;
  page.onMove({ detail: { x: -260, y: -160, source: 'touch' } });
  assert.equal(control.calls[0].isCurrent(), false);
  await waitFor(() => page.detailPending, 'Latest viewport must wait behind the active render');
  assert.equal(control.calls.length, 1);
  assert.equal(control.maximum(), 1);
  control.calls[0].finish('/local/stale-detail.png');
  await firstTask;
  await waitFor(() => control.calls.length === 2, 'Only the latest pending viewport must follow the old task');
  assert.deepEqual(control.calls[1].rect, { x: 2600, y: 1600, width: 3000, height: 2000 });
  assert.deepEqual(control.released, ['/local/stale-detail.png']);
  assert.equal(updates.some((update: any) => update.detailPath === '/local/stale-detail.png'), false);
  control.calls[1].finish('/local/current-detail.png');
  await page.detailTask;
  assert.equal(page.data.detailPath, '/local/current-detail.png');
  assert.equal(control.maximum(), 1);
  await page.clearDetail();
});

test('a new file waits for the discarded HD task before preparing the shared canvas', async () => {
  const control = controlledDetail();
  const next = { ...preview, info: { ...preview.info, width: 600, height: 420, filename: 'next.psd' },
    previewPath: '/local/next-overview.png', exportPath: '/local/next-overview.png' };
  const preparations: number[] = [];
  let choices = 0;
  const { page } = loadPage({
    chooseDesignFile: async () => ++choices === 1 ? selected : { ...selected, name: 'next.psd', path: '/chat/next.psd' },
    preparePreview: async () => {
      preparations.push(control.active());
      return preparations.length === 1 ? detailedPreview(control.detail) : next;
    },
  }, { getSystemInfoSync: () => ({ pixelRatio: 2 }) });
  detailGeometry(page);
  await page.chooseFile();
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  await waitFor(() => control.calls.length === 1, 'HD request must be active before returning home');
  page.backToHome();
  assert.equal(control.calls[0].isCurrent(), false);
  assert.equal(page.data.hasFile, false);
  const selecting = page.chooseFile();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(choices, 2);
  assert.equal(preparations.length, 1, 'New parsing must wait until the old detail render releases the canvas');
  control.calls[0].finish('/local/late-old-file-detail.png');
  await selecting;
  assert.deepEqual(preparations, [0, 0]);
  assert.deepEqual(control.released, ['/local/late-old-file-detail.png']);
  assert.equal(page.data.detailPath, '');
  assert.equal(page.data.filename, 'next.psd');
  assert.equal(page.data.previewPath, next.previewPath);
  assert.equal(page.exportPath, next.exportPath);
  assert.equal(page.data.zoomMax, 6);
});

test('stable HD bounds reuse one tile, replacements release it, and errors preserve overview saving', async () => {
  const control = controlledDetail();
  const { page, saved } = loadPage({ preparePreview: async () => detailedPreview(control.detail) },
    { getSystemInfoSync: () => ({ pixelRatio: 2 }) });
  const geometry = detailGeometry(page);
  await page.chooseFile();
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  await waitFor(() => control.calls.length === 1, 'First detail tile must render');
  control.calls[0].finish('/local/detail-one.png');
  await page.detailTask;
  const previousQueries = geometry.queries();
  page.onMove({ detail: { x: 0, y: 0, source: 'touch' } });
  await waitFor(() => geometry.queries() > previousQueries, 'Stable viewport must be checked without rerendering');
  await page.detailTask;
  assert.equal(control.calls.length, 1);
  assert.deepEqual(control.released, []);
  assert.equal(page.data.detailPath, '/local/detail-one.png');
  await page.saveImage();
  assert.deepEqual(saved, [preview.exportPath]);

  geometry.moved.left = -200;
  page.onMove({ detail: { x: -200, y: -100, source: 'touch' } });
  await waitFor(() => control.calls.length === 2, 'Changed bounds must replace the current tile');
  control.calls[1].finish('/local/detail-two.png');
  await page.detailTask;
  assert.deepEqual(control.released, ['/local/detail-one.png']);
  assert.equal(page.data.detailPath, '/local/detail-two.png');
  geometry.moved.left = -250;
  page.onMove({ detail: { x: -250, y: -100, source: 'touch' } });
  await waitFor(() => control.calls.length === 3, 'A later detail error must be contained');
  control.calls[2].fail(new Error('Test detail read failed'));
  await page.detailTask;
  assert.equal(page.data.detailPath, '');
  assert.equal(page.data.previewPath, preview.previewPath);
  assert.equal(page.data.canSave, true);
  assert.equal(page.exportPath, preview.exportPath);
  assert.ok(page.data.warnings.some((warning: string) => /继续显示概览/.test(warning)));
  assert.deepEqual(control.released, ['/local/detail-one.png', '/local/detail-two.png']);
  await page.saveImage();
  assert.deepEqual(saved, [preview.exportPath, preview.exportPath]);
  await page.clearDetail();
});

test('native scale readback does not issue another scale command and fitting resets both values', async () => {
  const { page, updates } = loadPage();
  await page.chooseFile();
  page.zoomIn();
  assert.equal(page.data.zoomCommand, 1.25);
  const beforeReadback = updates.length;
  page.onScale({ detail: { scale: 1.11, x: 8, y: -4 } });
  page.onScale({ detail: { scale: 1.25, x: 8, y: -4 } });
  assert.equal(page.data.zoom, 1.25);
  assert.equal(page.data.zoomCommand, 1.25);
  assert.equal(updates.slice(beforeReadback).some((update: any) => 'zoomCommand' in update), false);
  assert.equal(page.data.zoomMax, 6);
  page.fitToScreen();
  assert.equal(page.data.zoom, 1);
  assert.equal(page.data.zoomCommand, 1);
  assert.equal(page.data.zoomLabel, '100%');
  assert.equal(page.viewportZoom, 1);
  assert.equal('panX' in page.data || 'panY' in page.data, false);
});

test('gesture bursts keep native coordinates local and publish only the latest zoom reading', async () => {
  const { page, updates } = loadPage();
  await page.chooseFile();
  const before = updates.length;
  for (let i = 1; i <= 200; i++) {
    page.onScale({ detail: { scale: 1 + i / 100, x: -i, y: -i } });
    page.onMove({ detail: { x: -i, y: -i, source: 'touch' } });
  }
  assert.equal(page.viewportZoom, 3);
  assert.equal(updates.length, before);
  await waitFor(() => page.data.zoom === 3, 'The latest zoom reading is published after the throttle interval');
  assert.equal(updates.length, before + 1);
  assert.equal(page.data.zoomLabel, '300%');
  assert.equal(page.data.zoomCommand, 1);
  assert.equal('panX' in page.data || 'panY' in page.data, false);
  page.settleZoom();
  assert.equal(page.data.zoomCommand, 3);
  const settled = updates.length;
  page.settleZoom();
  assert.equal(updates.length, settled);
  page.onScale({ detail: { scale: 4, x: 0, y: 0 } });
  page.zoomIn();
  assert.equal(page.data.zoomCommand, 4.25);
  assert.equal(page.zoomTimer, undefined);
  page.backToHome();
});

test('pending zoom readings are cancelled on hide, file replacement and unload', async () => {
  for (const action of ['onHide', 'backToHome', 'onUnload']) {
    const { page, updates } = loadPage();
    await page.chooseFile();
    page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
    page[action]();
    const count = updates.length;
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(updates.length, count, action);
    assert.equal(page.zoomTimer, undefined);
    if (action === 'onHide') {
      page.onShow();
      assert.equal(page.data.zoom, 2);
    }
  }
  const { page } = loadPage();
  await page.chooseFile();
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  await page.chooseFile();
  assert.equal(page.viewportZoom, 1);
  assert.equal(page.data.zoom, 1);
  assert.equal(page.zoomTimer, undefined);
});

test('fitted gestures do not repeatedly clear an empty HD overlay and release a real overlay once', async () => {
  const control = controlledDetail();
  const { page, updates } = loadPage({ preparePreview: async () => detailedPreview(control.detail) });
  await page.chooseFile();
  const before = updates.length;
  for (let i = 0; i < 200; i++) page.onMove({ detail: { x: i, y: i, source: 'touch' } });
  assert.equal(updates.length, before);
  page.setData({ detailPath: '/local/detail.png', detailStyle: 'left:0;' });
  page.scheduleDetail(); page.scheduleDetail();
  assert.deepEqual(control.released, ['/local/detail.png']);
  assert.equal(updates.length, before + 2);
  page.backToHome();
});

test('HD rendering uses the live zoom before its throttled label and reuses the cached window density', async () => {
  const control = controlledDetail();
  let modernReads = 0, legacyReads = 0;
  const { page } = loadPage({ preparePreview: async () => detailedPreview(control.detail) }, {
    getWindowInfo: () => { modernReads++; return { pixelRatio: 2 }; },
    getSystemInfoSync: () => { legacyReads++; throw new Error('Legacy API must not run'); },
  });
  page.onLoad();
  detailGeometry(page);
  await page.chooseFile();
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  assert.equal(page.data.zoom, 1);
  clearTimeout(page.detailTimer); page.refreshDetail();
  await waitFor(() => control.calls.length === 1, 'A live native zoom must work before the label update');
  assert.deepEqual(control.calls[0].output, { width: 600, height: 400 });
  control.calls[0].finish('/local/current.png'); await page.detailTask;
  for (let i = 0; i < 10; i++) assert.equal(page.getPixelRatio(), 2);
  assert.equal(modernReads, 1); assert.equal(legacyReads, 0);
  page.backToHome();
  let fallbackReads = 0;
  const older = loadPage({}, { getWindowInfo: () => { throw new Error('Unavailable'); },
    getSystemInfoSync: () => { fallbackReads++; return { pixelRatio: 3 }; } }).page;
  assert.equal(older.getPixelRatio(), 3); assert.equal(older.getPixelRatio(), 3);
  assert.equal(fallbackReads, 1);
  assert.equal(loadPage({}, { getWindowInfo: () => ({ pixelRatio: -1 }) }).page.getPixelRatio(), 1);
});

test('compact file metadata stays above the preview, details stay outside it and resize refreshes source coordinates', async () => {
  const wxml = readFileSync('src/pages/index/index.wxml', 'utf8');
  const scroller = wxml.indexOf('<scroll-view class="preview-content"');
  const end = wxml.indexOf('</scroll-view>', scroller);
  const stage = wxml.indexOf('<view class="stage ');
  assert.ok(wxml.indexOf('class="file-info"') < stage);
  assert.ok(stage < scroller);
  assert.ok(wxml.indexOf('class="toolbar"') < scroller);
  assert.ok(wxml.indexOf('class="full-filename"') > scroller && wxml.indexOf('class="full-filename"') < end);
  assert.ok(wxml.indexOf('class="preview-actions ') < scroller);
  assert.match(wxml, /class="filename">{{filename}}/);
  assert.match(wxml, /class="preview-image"[^>]+mode="aspectFit"/);
  const control = controlledDetail();
  const { page } = loadPage({ preparePreview: async () => detailedPreview(control.detail) },
    { getWindowInfo: () => ({ pixelRatio: 2 }) });
  const geometry = detailGeometry(page);
  await page.chooseFile();
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  await waitFor(() => control.calls.length === 1, 'Initial landscape viewport renders');
  control.calls[0].finish('/local/landscape.png'); await page.detailTask;
  Object.assign(geometry.area, { width: 200, height: 300 });
  Object.assign(geometry.moved, { left: -100, top: -150, width: 400, height: 600 });
  page.onResize();
  await waitFor(() => control.calls.length === 2, 'Resized portrait viewport renders with new bounds');
  assert.deepEqual(control.calls[1].rect, { x: 1500, y: 0, width: 3000, height: 4000 });
  assert.deepEqual(control.calls[1].output, { width: 400, height: 533 });
  control.calls[1].finish('/local/portrait.png'); await page.detailTask;
  assert.deepEqual(control.released, ['/local/landscape.png']);
  page.backToHome();
});

test('theme starts in ink and restores only supported stored preferences', () => {
  const initial = loadPage();
  assert.equal(initial.page.data.theme, 'ink');
  assert.equal(initial.page.data.themePickerOpen, false);
  initial.page.onLoad();
  assert.equal(initial.page.data.theme, 'ink');
  assert.deepEqual(initial.storageReads, ['yijian-theme']);

  for (const theme of ['ink', 'paper', 'night']) {
    const { page } = loadPage({}, { getStorageSync: () => theme });
    page.onLoad();
    assert.equal(page.data.theme, theme);
    assert.equal(page.data.themePickerOpen, false);
  }
  for (const stored of ['unknown', '', null, 42, { theme: 'night' }]) {
    const { page } = loadPage({}, { getStorageSync: () => stored });
    page.onLoad();
    assert.equal(page.data.theme, 'ink');
  }
  const unavailable = loadPage({}, { getStorageSync: () => { throw new Error('storage unavailable'); } });
  assert.doesNotThrow(() => unavailable.page.onLoad());
  assert.equal(unavailable.page.data.theme, 'ink');
});

test('theme picker opens and closes while selections persist across page restarts', () => {
  const current = loadPage();
  current.page.openThemePicker();
  assert.equal(current.page.data.themePickerOpen, true);
  current.page.closeThemePicker();
  assert.equal(current.page.data.themePickerOpen, false);

  for (const theme of ['paper', 'night', 'ink']) {
    current.page.openThemePicker();
    current.page.selectTheme({ currentTarget: { dataset: { theme } } });
    assert.equal(current.page.data.theme, theme);
    assert.equal(current.page.data.themePickerOpen, false);
    assert.deepEqual(current.storageWrites[current.storageWrites.length - 1], { key: 'yijian-theme', value: theme });
    const navigation = current.navigationColors[current.navigationColors.length - 1];
    assert.ok(['#000000', '#ffffff'].includes(navigation.frontColor.toLowerCase()));
    assert.equal(typeof navigation.backgroundColor, 'string');
    assert.equal(typeof current.backgroundColors[current.backgroundColors.length - 1].backgroundColor, 'string');

    const restarted = loadPage({}, { getStorageSync: (key: string) => current.storageValues.get(key) });
    restarted.page.onLoad();
    assert.equal(restarted.page.data.theme, theme);
  }
  assert.equal(current.storageWrites.length, 3);
  assert.equal(current.navigationColors.length, 3);
  assert.equal(current.backgroundColors.length, 3);
});

test('theme changes immediately and reports a failed preference save without reverting', () => {
  const { page, storageWrites, toasts } = loadPage({}, {
    setStorageSync: () => { throw new Error('storage full'); },
  });
  page.openThemePicker();
  assert.doesNotThrow(() => page.selectTheme({ currentTarget: { dataset: { theme: 'night' } } }));
  assert.equal(page.data.theme, 'night');
  assert.equal(page.data.themePickerOpen, false);
  assert.deepEqual(storageWrites, [{ key: 'yijian-theme', value: 'night' }]);
  assert.equal(toasts.length, 1);
  assert.equal(typeof toasts[0].title, 'string');
  assert.ok(toasts[0].title.length > 0);
});

test('theme selection preserves the prepared preview, export, canvas and zoom without file operations', async () => {
  let choices = 0;
  let preparations = 0;
  const state = loadPage({
    chooseDesignFile: async () => { choices++; return selected; },
    preparePreview: async () => { preparations++; return preview; },
  });
  const { page } = state;
  await page.chooseFile();
  page.zoomIn();
  page.onMove({ detail: { x: 12, y: -8, source: 'touch' } });
  const withoutTheme = () => {
    const { theme: _theme, themePickerOpen: _picker, ...data } = page.data;
    return JSON.parse(JSON.stringify(data));
  };
  const before = { data: withoutTheme(), exportPath: page.exportPath, documentPath: page.documentPath,
    canvas: page.canvas, jobId: page.jobId, cleanups: state.cleanups() };
  for (const theme of ['paper', 'night', 'ink']) {
    page.openThemePicker();
    page.selectTheme({ currentTarget: { dataset: { theme } } });
    assert.deepEqual(withoutTheme(), before.data);
    assert.equal(page.exportPath, before.exportPath);
    assert.equal(page.documentPath, before.documentPath);
    assert.equal(page.canvas, before.canvas);
    assert.equal(page.jobId, before.jobId);
    assert.equal(state.cleanups(), before.cleanups);
  }
  assert.equal(choices, 1);
  assert.equal(preparations, 1);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.opened, []);
});

test('saving resumes HD for the final settled viewport and still saves only the overview', async () => {
  const control = controlledDetail();
  let finishSave!: () => void;
  const pendingSave = new Promise<void>(resolve => { finishSave = resolve; });
  const savePaths: string[] = [];
  const { page } = loadPage({
    preparePreview: async () => detailedPreview(control.detail),
    savePng: (path: string) => { savePaths.push(path); return pendingSave; },
  }, { getSystemInfoSync: () => ({ pixelRatio: 2 }) });
  const geometry = detailGeometry(page);
  await page.chooseFile();
  const saving = page.saveImage();
  assert.equal(page.data.busy, true);
  await waitFor(() => savePaths.length === 1, 'Album saving starts after the export overlay is rendered');
  assert.deepEqual(savePaths, [preview.exportPath]);
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  geometry.moved.left = -200; geometry.moved.top = -120;
  page.onMove({ detail: { x: -200, y: -120, source: 'touch' } });
  geometry.moved.left = -260; geometry.moved.top = -160;
  page.onMove({ detail: { x: -260, y: -160, source: 'touch' } });
  page.settleZoom();
  await waitFor(() => page.detailPending, 'The final viewport must remain pending while album saving is busy');
  assert.equal(control.calls.length, 0);
  finishSave();
  await saving;
  assert.equal(page.data.busy, false);
  await waitFor(() => control.calls.length === 1, 'Saving completion must automatically resume the pending HD viewport');
  assert.deepEqual(control.calls[0].rect, { x: 2600, y: 1600, width: 3000, height: 2000 });
  assert.deepEqual(control.calls[0].output, { width: 600, height: 400 });
  control.calls[0].finish('/local/after-saving-detail.png');
  await page.detailTask;
  assert.equal(page.data.detailPath, '/local/after-saving-detail.png');
  assert.equal(control.maximum(), 1);
  assert.equal(page.exportPath, preview.exportPath);
  assert.equal(page.data.previewPath, preview.previewPath);
  assert.deepEqual(savePaths, [preview.exportPath]);
  await page.clearDetail();
});

test('parsing starts only after the loading view callback and next native tick', async () => {
  let rendered!: () => void;
  const ticks: (() => void)[] = [];
  let parses = 0;
  const { page } = loadPage({ preparePreview: async (_file: unknown, _canvas: unknown, stage: (s: string, overview?: unknown, progress?: number) => void) => {
    parses++;
    stage('metadata'); assert.equal(page.data.busyText, '正在读取文件信息…');
    stage('preview'); assert.equal(page.data.busyHint, '正在生成设计稿预览');
    stage('raw-engine'); assert.equal(page.data.busyText, '正在加载 RAW 引擎…');
    stage('raw-overview', undefined, 45); assert.equal(page.data.busyText, '正在生成传感器概览 45%');
    stage('raw-auto', undefined, 75); assert.equal(page.data.busyText, '正在自动显影 75%');
    return { ...preview, exportSize: { width: 2, height: 3 } };
  } }, { nextTick: (callback: () => void) => ticks.push(callback) });
  page.getCanvas = async () => ({});
  const setData = page.setData;
  page.setData = (update: Record<string, unknown>, callback?: () => void) => {
    setData(update);
    if (update.busyText === '正在本地解析…' && update.hasFile) rendered = callback!;
    else callback?.();
  };
  const task = page.chooseFile();
  await waitFor(() => !!rendered, 'Loading view should be submitted');
  assert.equal(parses, 0);
  rendered();
  assert.equal(parses, 0);
  ticks.shift()!();
  await task;
  assert.equal(parses, 1);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.busyHint, '');
  assert.equal(page.data.previewAtOriginalSize, true);
});

test('return during initial parsing cancels immediately and serializes the next preparation', async () => {
  let finish!: (value: typeof preview) => void;
  let preparations = 0;
  const { page, updates, cleanups } = loadPage({ preparePreview: () => {
    preparations++;
    return preparations === 1 ? new Promise<typeof preview>(resolve => { finish = resolve; }) : Promise.resolve(preview);
  } });
  const first = page.chooseFile();
  await waitFor(() => preparations === 1, 'First prepare starts');
  page.backToHome();
  assert.equal(page.data.busy, false);
  assert.equal(page.data.hasFile, false);
  const second = page.chooseFile();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preparations, 1, 'The same Canvas must not be owned by two prepares');
  const before = updates.length;
  finish({ ...preview, previewPath: '/local/stale.png' });
  await Promise.all([first, second]);
  assert.equal(preparations, 2);
  assert.ok(cleanups() >= 4);
  assert.equal(updates.slice(before).some((value: any) => value.previewPath === '/local/stale.png'), false);
  assert.equal(page.data.previewPath, preview.previewPath);
  assert.equal(page.data.busy, false);
});

test('file selection completion leaves the picker state while older native work settles', async () => {
  let finish!: () => void;
  const { page } = loadPage();
  page.nativeTask = new Promise<void>(resolve => { finish = resolve; });
  const selecting = page.chooseFile();
  await waitFor(() => page.data.busyText === '正在准备文件…', 'Picker completion must be visible before waiting for prior work');
  assert.equal(page.data.busy, true);
  finish(); await selecting;
  assert.equal(page.data.previewPath, preview.previewPath); assert.equal(page.data.busy, false);
});

test('a cancelled direct import cannot block the next file while the old prepare settles', async () => {
  let picks = 0, preparations = 0, finish!: (value: typeof preview) => void;
  const { page } = loadPage({ chooseDesignFile: async () => { picks++; return selected; },
    preparePreview: () => ++preparations === 1 ? new Promise<typeof preview>(resolve => { finish = resolve; }) : Promise.resolve(preview) });
  const first = page.chooseChatFile(); await waitFor(() => preparations === 1, 'First import preparation');
  page.backToHome(); const second = page.chooseChatFile();
  await waitFor(() => picks === 2, 'A cancelled preparation must not block the next picker');
  assert.equal(preparations, 1);
  finish(preview); await Promise.all([first, second]);
  assert.equal(preparations, 2); assert.equal(page.data.busy, false);
});

test('a native viewport query that never calls back cannot block selecting the next file', async () => {
  const control = controlledDetail();
  const { page } = loadPage({ preparePreview: async () => detailedPreview(control.detail) });
  await page.chooseChatFile();
  let late!: (bounds: unknown[]) => void;
  page.createSelectorQuery = () => {
    const query: Record<string, any> = { select: () => query, boundingClientRect: () => query,
      exec: (done: typeof late) => { late = done; } }; return query;
  };
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } }); clearTimeout(page.detailTimer); page.refreshDetail();
  const waiting = page.detailTask; assert.equal(typeof late, 'function');
  page.backToHome(); const second = page.chooseChatFile();
  await waitFor(() => page.data.hasFile && !page.data.busy, 'Old bounds query must be cancellable when its view is gone');
  await Promise.all([waiting, second]);
  late([{ left: 0, top: 0, width: 300, height: 200 }, { left: 0, top: 0, width: 600, height: 400 }]);
  assert.equal(control.calls.length, 0); assert.equal(page.data.detailPath, '');
  assert.equal(page.data.previewPath, preview.previewPath); assert.equal(page.cancelDetailBounds, undefined);
});

test('HD loading follows the active version, clears on hide and reuses stable foreground results', async () => {
  const control = controlledDetail();
  const { page, updates } = loadPage({ preparePreview: async () => detailedPreview(control.detail) },
    { getSystemInfoSync: () => ({ pixelRatio: 2 }) });
  const geometry = detailGeometry(page);
  await page.chooseFile();
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  await waitFor(() => control.calls.length === 1, 'Initial request starts');
  assert.equal(page.data.detailLoading, true);
  assert.equal(page.data.previewPath, preview.previewPath);
  page.onHide();
  assert.equal(page.data.detailLoading, false);
  assert.equal(control.calls[0].isCurrent(), false);
  control.calls[0].finish('/local/hidden-stale.png');
  await page.detailTask;
  assert.deepEqual(control.released, ['/local/hidden-stale.png']);
  page.onShow();
  await waitFor(() => control.calls.length === 2, 'Foreground resumes current geometry');
  assert.equal(page.data.detailLoading, true);
  control.calls[1].finish('/local/foreground.png');
  await page.detailTask;
  assert.equal(page.data.detailLoading, false);
  const before = updates.length, queries = geometry.queries();
  page.scheduleDetail();
  await waitFor(() => geometry.queries() > queries, 'Stable geometry is rechecked');
  await page.detailTask;
  assert.equal(control.calls.length, 2);
  assert.equal(updates.slice(before).some((value: any) => value.detailLoading === true), false);
  assert.equal(page.data.detailPath, '/local/foreground.png');
  page.backToHome();
  assert.equal(page.data.detailLoading, false);
});

test('late native save/document callbacks cannot change the next file loading state', async () => {
  for (const action of ['saveImage', 'openDocument']) {
    let fail!: (error: Error) => void;
    let finish!: (value: typeof preview) => void;
    let preparations = 0, nativeCalls = 0;
    const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
    const { page, toasts } = loadPage({
      preparePreview: () => ++preparations === 1 ? Promise.resolve(preview)
        : new Promise<typeof preview>(resolve => { finish = resolve; }),
      savePng: () => { nativeCalls++; return pending; }, openAiDocument: () => { nativeCalls++; return pending; },
    });
    await page.chooseFile();
    page.documentPath = '/local/old.pdf';
    const old = page[action]();
    await waitFor(() => nativeCalls === 1, 'The old native operation has actually started');
    page.backToHome();
    const next = page.chooseFile();
    await waitFor(() => preparations === 2, 'Next parse is loading');
    fail(new Error('Old native failure'));
    await old;
    assert.equal(page.data.busy, true);
    assert.equal(page.data.errorMessage, '');
    assert.equal(toasts.length, 0);
    finish(preview);
    await next;
    assert.equal(page.data.busy, false);
  }
});

test('PDF sharing is available separately from PNG saving and the AI viewer remains available', async () => {
  const { page, opened } = loadPage();
  assert.equal(typeof page.shareDocument, 'function'); assert.equal(page.deliverNative, undefined);
  assert.match(readFileSync('src/pages/index/index.wxml', 'utf8'), /分享 PDF 到聊天/);
  assert.doesNotMatch(readFileSync('src/pages/index/index.wxml', 'utf8'), /分享原尺寸|data-share/);
  page.documentPath = '/local/copy.pdf'; await page.openDocument();
  assert.deepEqual(opened, ['/local/copy.pdf']);
});

test('HQ saving waits for the old HD Canvas task; returning and replacing a file waits for cancelled HQ work', async () => {
  const control = controlledDetail(); let finish!: (path: string) => void, exportCurrent!: () => boolean;
  let preparations = 0, exports = 0;
  const { page, saved } = loadPage({ preparePreview: async () => ++preparations === 1
    ? { ...detailedPreview(control.detail), prepareExport: (isCurrent: () => boolean) => {
      exports++; exportCurrent = isCurrent; assert.equal(control.active(), 0);
      return new Promise<string>(resolve => { finish = resolve; });
    } } : preview }, { getSystemInfoSync: () => ({ pixelRatio: 2 }) });
  detailGeometry(page); await page.chooseFile();
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  await waitFor(() => control.calls.length === 1, 'HD owns Canvas');
  const saving = page.saveImage(); assert.equal(control.calls[0].isCurrent(), false); assert.equal(exports, 0);
  control.calls[0].finish('/local/old-detail.png');
  await waitFor(() => exports === 1, 'HQ takes ownership after HD releases Canvas');
  assert.equal(page.data.previewPath, preview.previewPath); assert.equal(exportCurrent(), true);
  page.backToHome(); assert.equal(exportCurrent(), false);
  const selecting = page.chooseFile(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(preparations, 1);
  finish('/local/stale-hq.png'); await Promise.all([saving, selecting]);
  assert.equal(preparations, 2); assert.deepEqual(saved, []); assert.equal(page.exportPath, preview.exportPath);
  assert.equal(page.data.busy, false); assert.equal(page.data.detailLoading, false);
});

test('HQ preview PNG replaces only the export URI and subsequent saves reuse it', async () => {
  let exports = 0;
  const { page, saved } = loadPage({ preparePreview: async () => ({ ...preview,
    exportSize: { width: 1365, height: 911 }, prepareExport: async () => { exports++; return '/local/hq-full.png'; } }) });
  await page.chooseFile(); const displayed = page.data.previewPath;
  await page.saveImage(); await page.saveImage();
  assert.equal(exports, 1); assert.equal(page.data.previewPath, displayed);
  assert.equal(page.exportPath, '/local/hq-full.png'); assert.equal(page.data.previewAtOriginalSize, false);
  assert.deepEqual(saved, ['/local/hq-full.png', '/local/hq-full.png']);
});

test('native export keeps preview and HQ cache, reports rows and delivers only the native path', async () => {
  const calls: unknown[][] = [];
  const native = { ...preview, prepareNative: async (current: () => boolean, progress: (rows: number) => void) => {
    assert.ok(current()); progress(1); progress(3); return '/owned/original.png';
  } };
  const { page } = loadPage({ preparePreview: async () => native,
    saveNativePng: async (...args: unknown[]) => { calls.push(args); } },
    { canIUse: () => true });
  await page.chooseFile();
  const overview = page.data.previewPath, cached = page.exportPath;
  await page.exportNative();
  assert.equal(page.data.nativeState, 'READY'); assert.equal(page.data.nativeProgress, 100);
  assert.equal(page.data.previewPath, overview); assert.equal(page.exportPath, cached);
  assert.equal(calls.length, 1, 'The initial export automatically saves without another tap');
  assert.equal(calls[0][0], '/owned/original.png'); assert.equal(typeof calls[0][1], 'function');
  assert.equal(page.data.nativeState, 'READY'); assert.equal(page.data.busy, false);
});

test('native cancellation waits for in-flight cleanup and preserves existing preview saving', async () => {
  let finish!: () => void, current!: () => boolean;
  const { page, saved } = loadPage({ preparePreview: async () => ({ ...preview,
    prepareNative: async (check: () => boolean) => { current = check; await new Promise<void>(r => { finish = r; });
      if (!check()) throw new Error('cancelled'); return '/owned/original.png'; } }) }, { canIUse: () => true });
  await page.chooseFile();
  const task = page.exportNative();
  await waitFor(() => !!finish, 'native export started');
  page.cancelNative(); assert.equal(current(), false); assert.equal(page.data.busy, true);
  assert.equal(page.data.nativeState, 'CANCELLED');
  finish(); await task;
  assert.equal(page.data.nativeState, 'CANCELLED'); assert.equal(page.data.errorMessage, '');
  assert.equal(page.nativePath, ''); assert.equal(page.data.busy, false);
  await page.saveImage(); assert.deepEqual(saved, [preview.exportPath]);
});

test('return during native export prevents stale READY and new selection waits for the old task', async () => {
  let finish!: () => void, count = 0;
  const { page } = loadPage({ preparePreview: async () => { count++; return { ...preview,
    prepareNative: async () => new Promise<string>(resolve => { finish = () => resolve('/owned/old.png'); }) }; } }, { canIUse: () => true });
  await page.chooseFile(); const exporting = page.exportNative();
  await waitFor(() => !!finish, 'native export started');
  page.backToHome(); const selecting = page.chooseFile();
  await new Promise(r => setTimeout(r, 10)); assert.equal(count, 1);
  finish(); await Promise.all([exporting, selecting]);
  assert.equal(count, 2); assert.equal(page.data.nativeState, 'IDLE'); assert.equal(page.nativePath, '');
});

test('background cancels generation but not native delivery, whose old callback cannot change home', async () => {
  let finish!: () => void;
  const { page } = loadPage({ preparePreview: async () => ({ ...preview, prepareNative: async () => '/owned/native.png' }),
    saveNativePng: async () => new Promise<void>(r => { finish = r; }) }, { canIUse: () => true });
  await page.chooseFile(); const task = page.exportNative();
  await waitFor(() => !!finish, 'Delivery starts after its overlay is rendered');
  assert.equal(page.data.exportMode, 'delivery');
  page.onHide(); assert.equal(page.data.nativeState, 'DELIVERING');
  assert.equal(page.data.exportMode, 'delivery');
  page.backToHome(); finish(); await task;
  assert.equal(page.data.hasFile, false); assert.equal(page.data.nativeState, 'IDLE');
});

test('native export failure leaves the preview available and exposes a retry', async () => {
  const { page } = loadPage({ preparePreview: async () => ({ ...preview, prepareNative: async () => { throw new Error('disk full'); } }) }, { canIUse: () => true });
  await page.chooseFile(); await page.exportNative();
  assert.equal(page.data.nativeState, 'FAILED'); assert.equal(page.data.errorMessage, 'disk full');
  assert.equal(page.data.previewPath, preview.previewPath); assert.equal(page.exportPath, preview.exportPath);
  assert.equal(page.data.canSave, true); assert.equal(page.data.canNative, true);
});

test('preview export renders its centered overlay before HQ or album work and clears it on failure', async () => {
  let generated = 0, saves = 0, fail!: (error: Error) => void, rendered!: () => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const { page } = loadPage({ preparePreview: async () => ({ ...preview, prepareExport: async () => { generated++; return '/local/hq.png'; } }),
    savePng: () => { saves++; return pending; } });
  await page.chooseFile();
  const setData = page.setData;
  page.setData = (update: Record<string, unknown>, callback?: () => void) => {
    setData(update); if (update.exportMode === 'preview') rendered = callback!; else callback?.();
  };
  const task = page.saveImage();
  assert.equal(page.data.exportMode, 'preview'); assert.equal(page.data.busy, true);
  assert.equal(generated, 0); assert.equal(saves, 0); assert.equal(page.data.nativeProgress, 0);
  rendered(); await waitFor(() => saves === 1, 'HQ and album work start after the export frame');
  assert.equal(generated, 1); assert.equal(page.data.exportMode, 'preview');
  assert.equal(page.data.nativeProgress, 0, 'No fabricated preview percentage');
  fail(new Error('相册权限被拒绝')); await task;
  assert.equal(page.data.exportMode, ''); assert.equal(page.data.busy, false);
  assert.equal(page.data.errorMessage, '相册权限被拒绝'); assert.equal(page.data.previewPath, preview.previewPath);
});

test('centered original export tracks real row percentages and waits at 99 until file completion', async () => {
  let progress!: (rows: number) => void, finish!: (path: string) => void;
  const { page } = loadPage({ preparePreview: async () => ({ ...preview, info: { ...preview.info, height: 100 },
    prepareNative: async (_current: () => boolean, onProgress: (rows: number) => void) => {
      progress = onProgress; return new Promise<string>(resolve => { finish = resolve; });
    } }) }, { canIUse: () => true });
  await page.chooseFile(); const task = page.exportNative();
  assert.equal(page.data.exportMode, 'native'); assert.equal(page.data.nativeProgress, 0);
  await waitFor(() => !!progress, 'Native generation starts after the export frame');
  progress(25); assert.equal(page.data.nativeProgress, 25);
  progress(100); assert.equal(page.data.nativeProgress, 99); assert.equal(page.data.exportMode, 'native');
  finish('/owned/full.png'); await task;
  assert.equal(page.data.nativeProgress, 100); assert.equal(page.data.nativeState, 'READY'); assert.equal(page.data.exportMode, '');
});

test('returning before the export overlay frame prevents stale saving and leaves the next file untouched', async () => {
  let rendered!: () => void, saves = 0;
  const { page } = loadPage({ savePng: async () => { saves++; } });
  await page.chooseFile(); const setData = page.setData;
  page.setData = (update: Record<string, unknown>, callback?: () => void) => {
    setData(update); if (update.exportMode === 'preview') rendered = callback!; else callback?.();
  };
  const task = page.saveImage(); page.backToHome();
  assert.equal(page.data.exportMode, '');
  await page.chooseFile(); const next = JSON.stringify(page.data);
  rendered(); await task;
  assert.equal(saves, 0); assert.equal(JSON.stringify(page.data), next); assert.equal(page.data.exportMode, '');
});

test('one tap generates, validates and starts album saving before reporting success', async () => {
  let generated = 0, saves = 0, finish!: () => void;
  const { page, toasts } = loadPage({ preparePreview: async () => ({ ...preview,
    prepareNative: async () => { generated++; return '/owned/full.png'; } }),
    saveNativePng: async (path: string, current: () => boolean) => {
      assert.equal(path, '/owned/full.png'); assert.ok(current()); saves++;
      await new Promise<void>(resolve => { finish = resolve; });
    } }, { canIUse: () => true });
  await page.chooseFile(); const saving = page.exportNative();
  await waitFor(() => saves === 1, 'One export tap must reach the album API');
  assert.equal(generated, 1); assert.equal(page.data.busy, true);
  assert.equal(page.data.nativeProgress, 100); assert.equal(page.data.nativeState, 'DELIVERING');
  assert.equal(page.data.exportMode, 'delivery'); assert.equal(toasts.length, 0);
  await page.exportNative(); assert.equal(saves, 1, 'Repeat taps cannot launch another save');
  finish(); await saving;
  assert.equal(page.data.nativeState, 'READY'); assert.equal(page.data.busy, false);
  assert.equal(page.data.exportMode, ''); assert.equal(toasts.length, 1); assert.equal(toasts[0].title, '已保存到相册');
});

test('failed automatic album save keeps the generated PNG and retry does not decode it again', async () => {
  let generated = 0, saves = 0;
  const { page, toasts } = loadPage({ preparePreview: async () => ({ ...preview,
    prepareNative: async () => { generated++; return '/owned/cached.png'; } }),
    saveNativePng: async () => {
      saves++; if (saves === 1) throw Object.assign(new Error('相册权限被拒绝'), { code: 'ALBUM_PERMISSION' });
    } }, { canIUse: () => true });
  await page.chooseFile(); const previewPath = page.data.previewPath;
  await page.exportNative();
  assert.equal(generated, 1); assert.equal(saves, 1); assert.equal(page.nativePath, '/owned/cached.png');
  assert.equal(page.data.nativeState, 'READY'); assert.equal(page.data.errorMessage, '相册权限被拒绝');
  assert.equal(toasts.length, 0); assert.equal(page.data.exportMode, '');
  await page.exportNative();
  assert.equal(generated, 1); assert.equal(saves, 2); assert.equal(toasts.length, 1);
  assert.equal(page.data.errorMessage, ''); assert.equal(page.data.previewPath, previewPath);
});

test('an environment without album saving does not offer original export or a sharing fallback', async () => {
  let generated = 0;
  const { page } = loadPage({ preparePreview: async () => ({ ...preview,
    prepareNative: async () => { generated++; return '/owned/full.png'; } }) },
    { canIUse: (name: string) => name !== 'saveImageToPhotosAlbum', shareFileMessage: () => { assert.fail('Sharing was removed'); } });
  await page.chooseFile(); assert.equal(page.data.canNative, false);
  await page.exportNative(); assert.equal(generated, 0); assert.equal(page.data.exportMode, '');
  assert.equal(page.data.canSave, true);
});

test('document share calls the platform in the tap stack before any loading update and ignores stale completion', async () => {
  let finish!: () => void, calls = 0;
  const events: string[] = [];
  const doc = { ...preview, info: { ...preview.info, format: 'AI', exportSupported: false },
    previewPath: undefined, exportPath: undefined, documentPath: '/owned/document.pdf' };
  const { page } = loadPage({ preparePreview: async () => doc,
    sharePdfDocument: (path: string, name: string, current: () => boolean) => {
      calls++; events.push('native-share'); assert.equal(path, doc.documentPath); assert.ok(current());
      return new Promise<void>(resolve => { finish = resolve; });
    } }, { canIUse: () => true, shareFileMessage: () => {} });
  await page.chooseFile(); assert.equal(page.data.format, 'AI'); assert.equal(page.data.canShareDocument, true);
  const setData = page.setData; page.setData = (update: Record<string, unknown>, callback?: () => void) => {
    events.push('setData'); setData(update, callback);
  };
  const sharing = page.shareDocument();
  assert.equal(events[0], 'native-share'); assert.equal(calls, 1); assert.equal(page.data.busy, true);
  await page.shareDocument(); assert.equal(calls, 1);
  page.backToHome(); await page.chooseFile(); const next = JSON.stringify(page.data);
  finish(); await sharing; assert.equal(JSON.stringify(page.data), next);
});

test('document sharing cancellation is quiet and real native errors remain visible', async () => {
  for (const code of ['SHARE_CANCELLED', 'PLATFORM_ERROR']) {
    const { page } = loadPage({ sharePdfDocument: () => Promise.reject(Object.assign(new Error('native failure'), { code })) });
    page.documentPath = '/owned/document.pdf'; page.data.canShareDocument = true;
    await page.shareDocument(); assert.equal(page.data.busy, false);
    assert.equal(page.data.errorMessage, code === 'SHARE_CANCELLED' ? '' : 'native failure');
  }
});

test('AI PDF-compatible preview does not imply PNG raster export and unavailable sharing has no entry', async () => {
  const doc = { ...preview, info: { ...preview.info, format: 'AI', exportSupported: false },
    previewPath: undefined, exportPath: undefined, documentPath: '/owned/plain.pdf' };
  const { page, opened } = loadPage({ preparePreview: async () => doc });
  await page.chooseFile(); assert.equal(page.data.isDocument, true); assert.equal(page.data.canSave, false);
  assert.equal(page.data.canNative, false); assert.equal(page.data.canShareDocument, false);
  await page.shareDocument(); assert.equal(page.data.busy, false);
  assert.deepEqual(opened, [doc.documentPath]);
});

test('TIFF original image action saves only the native PNG when the preview is reduced', async () => {
  const { page, saved, nativeSaved } = loadPage({ preparePreview: async () => ({ ...preview,
    info: { ...preview.info, format: 'TIFF', width: 4000, height: 3000 },
    exportSize: { width: 1365, height: 1024 },
    prepareNative: async (_current: () => boolean, progress: (rows: number) => void) => {
      progress(3000); return '/local/original.png';
    },
  }) }, { canIUse: () => true });
  await page.chooseFile();
  assert.equal(page.data.canSave, true);
  assert.equal(page.data.canNative, true);
  assert.equal(page.data.previewAtOriginalSize, false);
  await page.saveOriginalImage();
  assert.deepEqual(saved, []);
  assert.deepEqual(nativeSaved, ['/local/original.png']);
  assert.equal(page.data.busy, false);
});

test('the single image save action only delivers full-size PNG for PSD, PSB and SVG', async () => {
  for (const format of ['PSD', 'PSB', 'SVG']) {
    for (const exact of [true, false]) {
      const result = { ...preview, info: { ...preview.info, format },
        exportSize: { width: exact ? 2 : 1, height: 3 } };
      const { page, saved } = loadPage({ preparePreview: async () => result });
      await page.chooseFile(); await page.saveOriginalImage();
      assert.deepEqual(saved, exact ? [result.exportPath] : [], format);
    }
  }
  const wxml = readFileSync('src/pages/index/index.wxml', 'utf8');
  assert.equal(wxml.match(/bindtap="saveOriginalImage"/g)?.length, 1);
  assert.doesNotMatch(wxml, /bindtap="(?:saveImage|exportNative|saveCameraJpeg)"/);
});

test('RAW original-pixel zoom is based on the real sensor and keeps each detail output pixel at source resolution', () => {
  for (const area of [{ left: 0, top: 0, width: 400, height: 500 }, { left: 10, top: 20, width: 1700, height: 1000 }]) {
    const source = { width: 7952, height: 5304, previewWidth: 1365 };
    const zoom = rawPixelZoom(source, area, 2)!;
    const moved = { left: area.left + area.width * (1 - zoom) / 2, top: area.top + area.height * (1 - zoom) / 2,
      width: area.width * zoom, height: area.height * zoom };
    const geometry = photoshopViewport(source, area, moved, 2)!;
    assert.equal(geometry.output.width, geometry.rect.width); assert.equal(geometry.output.height, geometry.rect.height);
    assert.ok(geometry.output.width <= 1365 && geometry.output.height <= 1365);
  }
  assert.equal(rawPixelZoom({ width: 0, height: 5 }, { left: 0, top: 0, width: 100, height: 100 }, 1), undefined);
});

test('RAW original-pixel button requests the proper native zoom and stale/unsupported calls are ignored', async () => {
  const control = { width: 7952, height: 5304, previewWidth: 1365, render: async () => '/local/detail.png', release: async () => {} };
  const { page } = loadPage({}, { getSystemInfoSync: () => ({ pixelRatio: 1 }) }); page.detail = control;
  page.setData({ format: 'RAW', canRawPixels: true, zoomMax: 64 });
  let scheduled = 0; page.scheduleDetail = () => { scheduled++; };
  page.createSelectorQuery = () => ({ select: () => ({ boundingClientRect: () => ({ exec: (done: (v: unknown[]) => void) => done([{ left: 0, top: 0, width: 400, height: 500 }]) }) }) });
  await page.viewRawPixels(); assert.ok(page.data.zoom > 1); assert.equal(page.data.zoomCommand, page.data.zoom); assert.equal(scheduled, 1);
  page.setData({ format: 'TIFF' }); await page.viewRawPixels(); assert.equal(scheduled, 1);
});

test('RAW auto preview toggles cached original/auto paths without decoding or changing zoom or exports', async () => {
  let prepared = 0;
  const raw = { ...preview, info: { ...preview.info, format: 'RAW', exportSupported: false },
    exportPath: undefined, previewPath: '/local/auto.png', rawOriginalPath: '/local/original.jpg', rawAutoPath: '/local/auto.png' };
  const { page, saved } = loadPage({ preparePreview: async () => { prepared++; return raw; } });
  await page.chooseFile();
  assert.equal(page.data.rawAutoAvailable, true); assert.equal(page.data.rawAutoEnabled, true);
  page.viewportZoom = 3; page.publishZoom();
  page.toggleRawAuto(); assert.equal(page.data.previewPath, '/local/original.jpg'); assert.equal(page.data.rawAutoEnabled, false);
  page.toggleRawAuto(); assert.equal(page.data.previewPath, '/local/auto.png'); assert.equal(prepared, 1);
  assert.equal(page.data.zoom, 3); assert.equal(page.viewportZoom, 3); assert.equal(page.data.canSave, false);
  assert.equal(saved.length, 0);
  page.backToHome(); assert.equal(page.data.rawAutoAvailable, false); assert.equal(page.rawOriginalPath, '');
});

test('a native RAW auto image display failure falls back to the original and ignores obsolete events', async () => {
  const raw = { ...preview, info: { ...preview.info, format: 'RAW', exportSupported: false },
    previewPath: '/local/auto.png', rawOriginalPath: '/local/original.jpg', rawAutoPath: '/local/auto.png' };
  const { page } = loadPage({ preparePreview: async () => raw });
  await page.chooseFile();
  page.onPreviewError({ currentTarget: { dataset: { path: '/old.png' } }, detail: {} });
  assert.equal(page.data.previewPath, '/local/auto.png');
  page.onPreviewError({ currentTarget: { dataset: { path: '/local/auto.png' } }, detail: {} });
  assert.equal(page.data.previewPath, '/local/original.jpg'); assert.equal(page.data.rawAutoAvailable, false);
});

test('home lists TIFF below PSD/PSB and keeps AI PDF viewing and sharing', () => {
  const wxml = readFileSync('src/pages/index/index.wxml', 'utf8');
  assert.deepEqual([...wxml.matchAll(/class="format-tag">([^<]+)</g)].map(match => match[1]), ['RAW', 'PSD', 'PSB', 'TIFF', 'AI', 'SVG']);
  assert.match(wxml, /bindtap="openDocument"/); assert.match(wxml, /bindtap="shareDocument"/);
});

test('primary file import invokes the picker directly in the tap stack without passing the event as source', async () => {
  let tapping = true, picks = 0, menus = 0;
  const { page } = loadPage({ chooseDesignFile: (source: unknown) => {
      assert.equal(tapping, true); assert.equal(source, 'chat-all'); picks++;
      return Promise.resolve(selected);
    } }, { showActionSheet: () => { menus++; } });
  const opening = page.chooseChatFile({ type: 'tap' }); tapping = false;
  await page.chooseChatFile(); await opening;
  assert.equal(picks, 1); assert.equal(menus, 0); assert.equal(page.data.busy, false);
  const wxml = readFileSync('src/pages/index/index.wxml', 'utf8');
  assert.match(wxml, /class="primary choose" bindtap="chooseChatFile"/);
  assert.match(wxml, /class="choose-hint" bindtap="chooseAlbum"/);
});

test('album button opens the album directly and cancellation preserves the current preview', async () => {
  let source = '', calls = 0, tapping = true, menus = 0;
  const { page } = loadPage({ chooseDesignFile: async (value: string) => { assert.equal(tapping,true);source = value; calls++; return selected; } },
    { showActionSheet: () => { menus++; } });
  const selecting=page.chooseAlbum();tapping=false;await selecting;
  assert.equal(source, 'album'); assert.equal(calls, 1); assert.equal(menus,0);
  const cancelled = loadPage({ chooseDesignFile: async () => { throw new Error('已取消选择'); } });
  cancelled.page.setData({ previewPath: '/current.png', hasFile: true });
  await cancelled.page.chooseAlbum(); assert.equal(cancelled.page.data.previewPath, '/current.png');
  assert.equal(cancelled.cleanups(), 0); assert.equal(cancelled.page.data.errorMessage, '');
});

test('repeated picker taps and callbacks after unload never create extra previews', async () => {
  let finish!: (value: typeof selected) => void, picks = 0, parses = 0;
  const waiting = new Promise<typeof selected>(done => { finish = done; });
  const { page } = loadPage({ chooseDesignFile: () => { picks++;return waiting; }, preparePreview: async () => { parses++;return preview; } });
  const task = page.chooseAlbum(); await page.chooseChatFile(); page.onUnload(); finish(selected);
  await task; await page.chooseAlbum(); assert.equal(picks, 1); assert.equal(parses, 0);
});

test('returned JPEG uses truthful labels and the original save path without enabling RAW features', async () => {
  const jpeg = { ...preview, info: { ...preview.info, format: 'JPEG', warnings: ['原始 RAW 不可用'] },
    originalImage: 'JPEG', previewPath: '/selected/image.jpg', exportPath: '/selected/image.jpg', exportSize: { width: 2, height: 3 } };
  const { page, saved } = loadPage({ preparePreview: async () => jpeg });
  await page.chooseFile('chat-image');
  assert.equal(page.data.originalImage, 'JPEG'); assert.equal(page.data.dimensions, '2 × 3 px');
  assert.equal(page.data.canRawPixels, false); assert.equal(page.data.rawAutoAvailable, false); assert.equal(page.data.canNative, false);
  await page.saveOriginalImage(); assert.deepEqual(saved, ['/selected/image.jpg']);
  page.backToHome(); assert.equal(page.data.previewAtOriginalSize, false); assert.equal(page.data.originalImage, '');
});

test('RAW without sensor export routes the HD button to JPEG and keeps overview PNG separate', async () => {
  const raw = { ...preview, info: { ...preview.info, format: 'RAW' },
    exportSize: { width: 2, height: 3 },
    rawJpeg: { path: '/owned/camera.jpg', width: 6000, height: 4000 } };
  let viewed = '';
  const { page, saved } = loadPage({ preparePreview: async () => raw, previewRawJpeg: async (path: string) => { viewed = path; } },
    { canIUse: () => true, previewImage: () => {} });
  await page.chooseFile(); assert.equal(page.data.canRawJpeg, true); assert.equal(page.data.rawJpegSize, '6000 × 4000 px');
  assert.equal(page.data.previewPath, '/owned/camera.jpg'); assert.equal(page.data.rawJpegInline, true);
  await page.viewCameraJpeg(); assert.equal(viewed, '/owned/camera.jpg');
  await page.saveOriginalImage(); assert.deepEqual(saved, ['/owned/camera.jpg']);
  await page.saveImage(); assert.deepEqual(saved, ['/owned/camera.jpg', '/local/preview.png']);
  page.backToHome(); assert.equal(page.data.canRawJpeg, false); assert.equal(page.rawJpegPath, '');
  assert.equal(page.data.rawJpegInline, false); assert.equal(page.rawInlinePath, '');
});

test('RAW saves the matching cached PNG after each mode switch even after a first save', async () => {
  let enabled = true, preparations = 0;
  const raw = { ...preview, info: { ...preview.info, format: 'RAW', width: 6720, height: 4480 },
    previewPath: '/local/auto.png', rawOriginalPath: '/local/160.jpg', rawAutoPath: '/local/auto.png',
    rawJpeg: { path: '/owned/6720.jpg', width: 6720, height: 4480 }, exportSize: { width: 160, height: 120 },
    setRawAuto: (value: boolean) => { enabled = value; },
    prepareExport: async () => enabled ? '/local/auto.png' : '/local/base.png' };
  const { page, saved } = loadPage({ preparePreview: async () => { preparations++; return raw; } }, { canIUse: () => true });
  await page.chooseFile();
  assert.equal(page.data.previewPath, raw.rawJpeg.path); assert.equal(page.data.rawAutoEnabled, false); assert.equal(enabled, false);
  assert.equal(page.data.rawJpegInline, true); assert.equal(page.data.previewAtOriginalSize, false);
  await page.saveImage();
  page.viewportZoom = 4.33; page.publishZoom();
  page.toggleRawAuto(); assert.equal(page.data.previewPath, raw.rawAutoPath); assert.equal(enabled, true); assert.equal(page.data.rawJpegInline, false);
  await page.saveImage();
  await page.saveOriginalImage();
  page.toggleRawAuto(); assert.equal(page.data.previewPath, raw.rawJpeg.path); assert.equal(enabled, false); assert.equal(page.data.rawJpegInline, true);
  assert.equal(page.data.zoom, 4.33); assert.equal(page.viewportZoom, 4.33); assert.equal(preparations, 1);
  await page.saveImage(); assert.deepEqual(saved, ['/local/base.png', '/local/auto.png', raw.rawJpeg.path, '/local/base.png']);
});

test('RAW HD prioritizes sensor PNG and a failed generation leaves JPEG available by explicit action', async () => {
  let generations = 0, nativeAttempts = 0;
  const raw = { ...preview, info: { ...preview.info, format: 'RAW', width: 7952, height: 5304 },
    exportSize: { width: 1365, height: 910 }, rawJpeg: { path: '/owned/camera.jpg', width: 1616, height: 1080 },
    prepareNative: async () => {
      if (++generations === 1) throw new Error('生成失败');
      return '/owned/sensor.png';
    } };
  const { page, saved, toasts } = loadPage({ preparePreview: async () => raw,
    saveNativePng: async (path: string, _current: () => boolean, quietCancel: boolean) => {
      assert.equal(path, '/owned/sensor.png'); assert.equal(quietCancel, true);
      if (++nativeAttempts === 1) throw Object.assign(new Error('已取消保存'), { code: 'CANCELLED' });
    } }, { canIUse: () => true });
  await page.chooseFile();
  await page.saveOriginalImage(); assert.equal(page.data.nativeState, 'FAILED');
  assert.equal(generations, 1); assert.deepEqual(saved, []); assert.equal(nativeAttempts, 0); assert.equal(toasts.length, 0);
  assert.equal(page.data.canRawJpeg, true);
  await page.saveCameraJpeg(); await page.saveImage(); await page.saveOriginalImage();
  assert.equal(page.data.errorMessage, ''); assert.equal(page.data.nativeState, 'READY'); assert.equal(toasts.length, 2);
  await page.saveOriginalImage(); assert.equal(toasts.length, 3);
  assert.deepEqual(saved, [raw.rawJpeg.path, raw.exportPath]);
  assert.equal(nativeAttempts, 2); assert.equal(generations, 2);
});

test('an expired RAW PNG disables only that mode and a late image error does not change the saving mode', async () => {
  let optimized = true, finish!: () => void;
  const raw = { ...preview, info: { ...preview.info, format: 'RAW', width: 7952, height: 5304 },
    exportSize: { width: 1365, height: 910 }, previewPath: '/local/auto.png',
    rawOriginalPath: '/local/base.png', rawAutoPath: '/local/auto.png',
    setRawAuto: (enabled: boolean) => { optimized = enabled; },
    prepareExport: async () => optimized ? '/local/auto.png' : '/local/base.png' };
  const { page, toasts } = loadPage({ preparePreview: async () => raw, savePng: (path: string) => {
    if (path === raw.rawAutoPath) throw Object.assign(new Error('已失效'), { code: 'FILE_EXPIRED' });
    return new Promise<void>(resolve => { finish = resolve; });
  } });
  await page.chooseFile(); await page.saveImage();
  assert.equal(page.data.canSave, false); assert.equal(toasts.length, 0);
  page.toggleRawAuto(); assert.equal(page.data.canSave, true);
  page.toggleRawAuto(); assert.equal(page.data.canSave, false);
  page.toggleRawAuto(); const saving = page.saveImage();
  await waitFor(() => !!finish, 'Base PNG reaches the album');
  page.onPreviewError({ currentTarget: { dataset: { path: raw.rawOriginalPath } } });
  assert.equal(page.data.rawAutoEnabled, false); assert.equal(page.data.canSave, true);
  finish(); await saving; assert.equal(toasts.length, 1);
});

test('a failed inline camera JPEG falls back once, preserves HD saving and ignores stale events', async () => {
  const raw = { ...preview, info: { ...preview.info, format: 'RAW' },
    rawOriginalPath: '/local/base.jpg', rawAutoPath: '/local/auto.png',
    rawJpeg: { path: '/owned/camera.jpg', width: 6720, height: 4480 } };
  const { page, saved } = loadPage({ preparePreview: async () => raw }, { canIUse: () => true });
  await page.chooseFile();
  const error = (path: string) => page.onPreviewError({ currentTarget: { dataset: { path } }, detail: {} });
  error('/old.jpg'); assert.equal(page.data.previewPath, raw.rawJpeg.path);
  error(raw.rawJpeg.path); assert.equal(page.data.previewPath, raw.rawOriginalPath); assert.equal(page.rawInlinePath, '');
  assert.equal(page.data.rawJpegInline, false); assert.equal(page.data.canRawJpeg, true);
  page.toggleRawAuto(); page.toggleRawAuto(); assert.equal(page.data.previewPath, raw.rawOriginalPath);
  await page.saveCameraJpeg(); assert.deepEqual(saved, [raw.rawJpeg.path]);
  page.backToHome(); error(raw.rawJpeg.path); assert.equal(page.data.previewPath, '');
});

test('native camera JPEG display without a safe Canvas overview never enables preview PNG export', async () => {
  const raw = { info: { ...preview.info, format: 'RAW', previewAvailable: false, exportSupported: false },
    rawJpeg: { path: '/owned/large.jpg', width: 6000, height: 4000 } };
  const { page } = loadPage({ preparePreview: async () => raw }, { canIUse: () => true });
  await page.chooseFile(); assert.equal(page.data.previewPath, raw.rawJpeg.path); assert.equal(page.data.canSave, false);
  page.onPreviewError({ currentTarget: { dataset: { path: raw.rawJpeg.path } }, detail: {} });
  assert.equal(page.data.previewPath, ''); assert.equal(page.data.rawJpegInline, false);
});

test('camera JPEG does not replace a genuine RAW sensor detail preview', async () => {
  const control = controlledDetail();
  const raw = { ...detailedPreview(control.detail), info: { ...preview.info, format: 'RAW' },
    rawJpeg: { path: '/owned/camera.jpg', width: 1616, height: 1080 } };
  const { page } = loadPage({ preparePreview: async () => raw }, { canIUse: () => true });
  await page.chooseFile(); assert.equal(page.data.previewPath, raw.previewPath);
  assert.equal(page.data.rawJpegInline, false); assert.equal(page.data.canRawPixels, true); assert.equal(page.detail, control.detail);
});

test('early camera overview appears before sensor preparation finishes and stale callbacks are ignored', async () => {
  let finish!: (value: unknown) => void, stage!: (value: string, preview?: { path: string }) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const { page } = loadPage({ preparePreview: (_file: unknown, _canvas: unknown, progress: typeof stage) => { stage = progress; return pending; } });
  const task = page.chooseFile(); await waitFor(() => !!stage, 'metadata callback');
  stage('preview', { path: '/owned/camera.jpg' }); assert.equal(page.data.previewPath, '/owned/camera.jpg'); assert.equal(page.data.busy, true);
  page.backToHome(); stage('preview', { path: '/stale.jpg' }); assert.equal(page.data.previewPath, '');
  finish(preview); await task; assert.equal(page.data.hasFile, false);
});

test('memory pressure cancels stale detail work before releasing its tile and Canvas, then unregisters the listener', async () => {
  const control = controlledDetail();
  let listener!: () => void, removed: unknown;
  const { page } = loadPage({ preparePreview: async () => detailedPreview(control.detail) }, {
    onMemoryWarning: (callback: () => void) => { listener = callback; },
    offMemoryWarning: (callback: unknown) => { removed = callback; },
    getWindowInfo: () => ({ pixelRatio: 2 }),
  });
  page.onLoad(); detailGeometry(page); await page.chooseFile();
  const canvas = { width: 1365, height: 910 }; page.canvas = canvas;
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  await waitFor(() => control.calls.length === 1, 'Detail render starts before the warning');
  listener(); const recovery = page.memoryRecovery;
  listener(); assert.equal(page.memoryRecovery, recovery);
  assert.equal(control.calls[0].isCurrent(), false);
  assert.equal(canvas.width, 1365);
  control.calls[0].finish('/local/stale-after-warning.png');
  await recovery;
  assert.deepEqual(control.released, ['/local/stale-after-warning.png']);
  assert.equal(canvas.width, 1); assert.equal(canvas.height, 1);
  assert.equal(page.data.previewPath, preview.previewPath);
  assert.equal(page.data.canSave, true); assert.equal(page.viewportZoom, 1);
  const count = control.calls.length;
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } }); page.settleZoom();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(control.calls.length, count);
  assert.equal(page.data.errorCode, 'MEMORY_WARNING');
  page.onUnload(); assert.equal(removed, listener);
});

test('a memory warning during original PNG generation waits for cancelled I/O and preserves retry capability', async () => {
  let finish!: () => void, current!: () => boolean, attempts = 0;
  const { page, nativeSaved } = loadPage({ preparePreview: async () => ({ ...preview,
    prepareNative: async (isCurrent: () => boolean) => {
      attempts++; current = isCurrent;
      await new Promise<void>(resolve => { finish = resolve; });
      if (!isCurrent()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      return '/local/original.png';
    } }) });
  await page.chooseFile();
  const canvas = { width: 1365, height: 910 }; page.canvas = canvas;
  const saving = page.saveOriginalImage();
  await waitFor(() => attempts === 1, 'Original PNG generation begins');
  const recovery = page.handleMemoryWarning();
  assert.equal(current(), false); assert.equal(page.data.nativeState, 'CANCELLED');
  assert.equal(canvas.width, 1365); assert.equal(page.data.busy, true);
  finish(); await Promise.all([saving, recovery]);
  assert.equal(canvas.width, 1); assert.equal(page.data.busy, false);
  assert.equal(page.data.canNative, true); assert.deepEqual(nativeSaved, []);
  assert.equal(page.data.errorMessage, '');
  await page.chooseFile(); assert.equal(page.detailSuspended, false); assert.equal(page.data.memoryNotice, '');
});

test('memory recovery and foreground changes preserve a completed PNG during album delivery', async () => {
  let finish!: () => void, generated = 0;
  const screen: boolean[] = [], removed: string[] = [];
  const { page, toasts } = loadPage({ preparePreview: async () => ({ ...preview,
    prepareNative: async () => { generated++; return '/local/original.png'; } }),
    saveNativePng: () => new Promise<void>(resolve => { finish = resolve; }),
    discardGeneratedPng: async (path: string) => { removed.push(path); },
  }, { setKeepScreenOn: (options: { keepScreenOn: boolean }) => { screen.push(options.keepScreenOn); } });
  await page.chooseFile();
  const saving = page.saveOriginalImage();
  await waitFor(() => !!finish, 'Album receives the completed PNG');
  page.onHide(); assert.equal(page.data.nativeState, 'DELIVERING');
  page.onShow(); await page.handleMemoryWarning();
  assert.equal(page.nativePath, '/local/original.png');
  assert.equal(page.data.nativeState, 'DELIVERING'); assert.deepEqual(removed, []);
  finish(); await saving;
  assert.equal(page.data.nativeState, 'READY'); assert.equal(toasts.length, 1);
  assert.deepEqual(screen, [true, false, true, false]);
  const retry = page.saveOriginalImage();
  await waitFor(() => page.data.busy, 'Cached save begins');
  await new Promise(resolve => setImmediate(resolve));
  finish(); await retry;
  assert.equal(generated, 1);
});

test('screen locking failure does not block an export or leave the page busy', async () => {
  const { page, nativeSaved } = loadPage({ preparePreview: async () => ({ ...preview,
    prepareNative: async () => '/local/original.png' }) },
  { setKeepScreenOn: () => { throw new Error('Unsupported'); } });
  await page.chooseFile(); await page.saveOriginalImage();
  assert.deepEqual(nativeSaved, ['/local/original.png']); assert.equal(page.data.busy, false);
  assert.equal(page.screenAwake, false);
});

test('a new original save waits for memory recovery before opening another generation session', async () => {
  const control = controlledDetail(), canvas = { width: 1365, height: 910 };
  let generated = 0;
  const { page, nativeSaved } = loadPage({ preparePreview: async () => ({ ...detailedPreview(control.detail),
    prepareNative: async () => {
      assert.equal(canvas.width, 1); generated++; return '/local/after-recovery.png';
    } }) }, { getWindowInfo: () => ({ pixelRatio: 2 }) });
  detailGeometry(page); await page.chooseFile(); page.canvas = canvas;
  page.onScale({ detail: { scale: 2, x: 0, y: 0 } });
  await waitFor(() => control.calls.length === 1, 'A shared Canvas task is active');
  const recovery = page.handleMemoryWarning(), saving = page.saveOriginalImage();
  assert.equal(generated, 0);
  control.calls[0].finish('/local/stale-before-save.png');
  await Promise.all([recovery, saving]);
  assert.equal(generated, 1); assert.deepEqual(nativeSaved, ['/local/after-recovery.png']);
});

test('the GitHub entry copies the public repository URL and reports the clipboard result', () => {
  let copied = '';
  const success = loadPage({}, { setClipboardData: (options: WechatMiniprogram.SetClipboardDataOption) => {
    copied = options.data;
    options.success?.({ errMsg: 'setClipboardData:ok' });
  } });
  success.page.copyGitHubLink();
  assert.equal(copied, 'https://github.com/zhuhhz/jianzhong-guanxiang-public');
  assert.equal(success.toasts[0].title, '链接已复制');

  const failure = loadPage({}, { setClipboardData: (options: WechatMiniprogram.SetClipboardDataOption) => {
    options.fail?.({ errMsg: 'setClipboardData:fail' });
  } });
  failure.page.copyGitHubLink();
  assert.equal(failure.toasts[0].title, '复制失败，请重试');

  const unsupported = loadPage();
  unsupported.page.copyGitHubLink();
  assert.equal(unsupported.toasts[0].title, '当前微信不支持复制');
});

test('diagnostics copy only bounded codes and versions after a user action, excluding private error text', () => {
  let copied = '', writes = 0;
  const { page } = loadPage({}, { getAccountInfoSync: () => ({ miniProgram: { version: '1.2.3' } }),
    getAppBaseInfo: () => ({ SDKVersion: '3.16.4', version: '8.0.80' }),
    setClipboardData: (options: { data: string; success: () => void }) => { copied = options.data; writes++; options.success(); } });
  page.onLoad(); page.setData({ format: 'RAW', filename: 'private.ARW' });
  page.reportError(Object.assign(new Error('D:/私人照片/private.ARW GPS=123 EXIF'), { code: 'INVALID_RAW' }));
  assert.equal(writes, 0);
  page.copyDiagnostic();
  assert.match(copied, /1\.2\.3/); assert.match(copied, /INVALID_RAW/); assert.match(copied, /RAW/);
  assert.doesNotMatch(copied, /私人|private|GPS|EXIF|D:\//);
  page.reportError(Object.assign(new Error('private path'), { code: 'C:/private/path' }));
  page.copyDiagnostic(); assert.match(copied, /UNEXPECTED_ERROR/); assert.doesNotMatch(copied, /private/);
});

test('an empty all-types chat result offers an explicit file-only retry and copies safe callback structure', async () => {
  const sources: string[] = []; let copied = '', tapping = false;
  const shape = 'source=chat-all;list=array;count=0;path=missing;tempFilePath=missing';
  const { page } = loadPage({ chooseDesignFile: async (source: string) => {
    sources.push(source);
    if (source === 'chat-all') throw Object.assign(new Error('微信选择器返回的文件条目为空。'), { code: 'NO_FILE_EMPTY_LIST', pickerDiagnostic: shape });
    assert.equal(tapping, true); return selected;
  } }, { getAccountInfoSync: () => ({ miniProgram: { version: '', envVersion: 'trial' } }),
    setClipboardData: (options: { data: string; success: () => void }) => { copied = options.data; options.success(); } });
  page.onLoad(); await page.chooseChatFile();
  assert.deepEqual(sources, ['chat-all']); assert.equal(page.data.canRetryChatFile, true);
  assert.equal(page.data.errorCode, 'NO_FILE_EMPTY_LIST'); assert.equal(page.data.format, '');
  assert.equal(page.data.canRestartPicker, false);
  assert.match(page.data.errorMessage, /右上角「…」选择「重新进入小程序」/);
  page.copyDiagnostic(); assert.match(copied, /运行版本 体验版/); assert.ok(copied.includes(shape));
  tapping = true; const retry = page.retryChatFile(); tapping = false;
  assert.deepEqual(sources, ['chat-all', 'chat-file']); await retry;
  assert.equal(page.data.format, 'PSD'); assert.equal(page.data.pickerDiagnostic, ''); assert.equal(page.data.canRetryChatFile, false);
  page.backToHome();
});

test('both empty chat picker modes prompt for restart and show manual recovery on failure', async () => {
  const restarts: WechatMiniprogram.RestartMiniProgramOption[] = [];
  const { page, modals } = loadPage({ chooseDesignFile: async (source: string) => {
    throw Object.assign(new Error('empty result'), { code: 'NO_FILE_EMPTY_LIST',
      pickerDiagnostic: `source=${source};list=array;count=0;path=missing;tempFilePath=missing` });
  } }, { restartMiniProgram: (options: WechatMiniprogram.RestartMiniProgramOption) => restarts.push(options) });
  const choosing = page.chooseChatFile();
  page.onHide();
  await choosing;
  assert.equal(page.data.canRestartPicker, true);
  assert.equal(modals.length, 0);
  page.onShow();
  assert.equal(modals[0]?.confirmText, '重新进入');
  modals[0].success?.({ confirm: false, cancel: true, content: '', errMsg: 'showModal:ok' });
  await page.retryChatFile();
  assert.equal(page.data.canRetryChatFile, false);
  assert.equal(page.data.canRestartPicker, true);
  assert.equal(restarts.length, 0);
  assert.equal(modals[1]?.confirmText, '重新进入');
  modals[1].success?.({ confirm: true, cancel: false, content: '', errMsg: 'showModal:ok' });
  page.restartAfterEmptyPicker();
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].path, 'pages/index/index');
  restarts[0].fail?.({ errMsg: 'restartMiniProgram:fail' });
  assert.match(page.data.errorMessage, /右上角「…」选择「重新进入小程序」/);
  assert.equal(modals[2]?.content, page.data.errorMessage);
  assert.equal(modals[2]?.showCancel, false);
  assert.equal(page.data.errorCode, 'NO_FILE_EMPTY_LIST');
  await page.chooseAlbum();
  assert.equal(page.data.canRestartPicker, false);
  assert.equal(page.data.errorMessage, 'empty result');
});

test('picker structure is fully whitelisted and file-only retry is not offered for other import sources', () => {
  let copied = '';
  const { page } = loadPage({}, { setClipboardData: (options: { data: string; success: () => void }) => { copied = options.data; options.success(); } });
  page.onLoad();
  const valid = 'source=chat-all;list=array;count=1;path=missing;tempFilePath=string';
  for (const shape of [valid + '\n', valid + ';name=private.ARW', '/private/photo.ARW', valid.replace('string', '/private/photo.jpg')]) {
    page.reportError(Object.assign(new Error('private name'), { code: 'NO_FILE_PATH_MISSING', pickerDiagnostic: shape }));
    assert.equal(page.data.pickerDiagnostic, ''); assert.equal(page.data.canRetryChatFile, false);
    page.copyDiagnostic(); assert.doesNotMatch(copied, /选择器|private|photo/);
  }
  for (const source of ['album', 'chat-file', 'chat-image']) {
    page.reportError(Object.assign(new Error('private name'), { code: 'NO_FILE_PATH_MISSING', pickerDiagnostic: valid.replace('chat-all', source) }));
    assert.equal(page.data.canRetryChatFile, false); assert.equal(page.retryChatFile(), undefined);
  }
  page.reportError(Object.assign(new Error('private name'), { code: 'INVALID_RAW', pickerDiagnostic: valid }));
  assert.equal(page.data.pickerDiagnostic, ''); page.copyDiagnostic(); assert.doesNotMatch(copied, /选择器|private/);
});

test('compact JPG and PNG labels agree with the actual available save route across supported formats', async () => {
  const wxml = readFileSync('src/pages/index/index.wxml', 'utf8');
  const label = wxml.match(/bindtap="saveOriginalImage"[^>]*>{{([\s\S]*?)}}<\/button>/)![1];
  const visible = wxml.match(/<button wx:if="{{([^\"]+)}}" class="primary save-button" bindtap="saveOriginalImage"/)![1];
  for (const [format, native, original, jpeg, expected] of [
    ['PSD', true, '', false, 'PNG'], ['PSB', true, '', false, 'PNG'], ['TIFF', true, '', false, 'PNG'],
    ['RAW', true, '', true, 'PNG'], ['RAW', false, '', true, 'JPG'],
    ['JPEG', false, 'JPEG', false, 'JPG'], ['PNG', false, 'PNG', false, 'PNG'], ['SVG', false, '', false, 'PNG'],
  ] as const) {
    const result = { ...preview, info: { ...preview.info, format }, exportSize: { width: 2, height: 3 }, originalImage: original,
      prepareNative: native ? async () => '/local/original.png' : undefined,
      rawJpeg: jpeg ? { path: '/local/camera.jpg', width: 6720, height: 4480 } : undefined };
    const { page, saved, nativeSaved } = loadPage({ preparePreview: async () => result });
    await page.chooseFile();
    assert.equal(runInNewContext(visible, page.data), true, format);
    assert.equal(runInNewContext(label, page.data), `保存 ${expected} 到相册`, format);
    await page.saveOriginalImage();
    assert.deepEqual(nativeSaved, native ? ['/local/original.png'] : []);
    assert.deepEqual(saved, native ? [] : jpeg ? ['/local/camera.jpg'] : [preview.exportPath]);
    page.backToHome();
  }
  for (const format of ['SVG', 'AI']) {
    const { page } = loadPage({ preparePreview: async () => ({ ...preview,
      info: { ...preview.info, format, exportSupported: false }, exportPath: undefined,
      documentPath: format === 'AI' ? '/local/checked.pdf' : undefined }) });
    await page.chooseFile(); assert.equal(runInNewContext(visible, page.data), false);
  }
});

test('details and compact tools only change display state, retaining the viewport, files and export caches', async () => {
  const control = controlledDetail();
  const { page } = loadPage({ preparePreview: async () => detailedPreview(control.detail) });
  await page.chooseFile();
  page.viewportZoom = 3.25; page.publishZoom(true);
  page.nativePath = '/local/cached-native.png'; page.detailKey = 'current-source-region';
  const before = { data: JSON.stringify(page.data), jobId: page.jobId, nativeVersion: page.nativeVersion,
    detailVersion: page.detailVersion, nativePath: page.nativePath, exportPath: page.exportPath, detail: page.detail, detailKey: page.detailKey };
  page.togglePreviewTools(); assert.equal(page.data.previewToolsOpen, true);
  page.togglePreviewDetails(); assert.equal(page.data.previewDetailsOpen, true); assert.equal(page.data.previewToolsOpen, false);
  assert.equal(page.data.filename, preview.info.filename);
  page.closePreviewDetails(); page.togglePreviewTools(); page.closePreviewTools();
  assert.equal(JSON.stringify(page.data), before.data);
  for (const key of ['jobId', 'nativeVersion', 'detailVersion', 'nativePath', 'exportPath', 'detail', 'detailKey'] as const) {
    assert.equal(page[key], before[key]);
  }
  assert.deepEqual(control.released, []);
  page.togglePreviewDetails(); await page.chooseFile(); assert.equal(page.data.previewDetailsOpen, false);
  page.togglePreviewTools(); page.backToHome(); assert.equal(page.data.previewToolsOpen, false);
});

test('file diagnostics move to details while unknown, color and decode risks remain visible', async () => {
  const diagnostics = ['来源：聊天文件；实际格式 ARW；实际大小 85840896 字节。',
    '预算内最高有效 JPEG：1616 × 1080 px；并非传感器 RAW 原尺寸。',
    '传感器显影概览：910 × 1365 px；按实际像素读取。',
    '原尺寸 PNG 为有效画面 5304 × 7952 px、8 位 RGB，不保留14位数据。',
    '降采样概览：1365 × 910 px。', '已核实 sRGB 矩阵/TRC，保留原颜色。'];
  const risks = ['未应用 ICC 色彩管理，颜色可能与 Photoshop 不同。',
    '全分辨率显影暂不可用：引擎不支持此文件。', '低分辨率预览：文件只含缩略图。', '未知的文件兼容风险'];
  const warnings = [...diagnostics, ...risks, risks[0]];
  const { page } = loadPage({ preparePreview: async () => ({ ...preview, info: { ...preview.info, warnings } }) });
  await page.chooseFile();
  assert.deepEqual([...page.data.warnings], warnings);
  assert.deepEqual([...page.data.importantWarnings], risks);
  page.togglePreviewDetails(); assert.deepEqual([...page.data.warnings], warnings);
  page.backToHome(); assert.deepEqual([...page.data.importantWarnings], []);
});

test('the existing full-screen camera JPEG fallback remains reachable when no inline preview survives', async () => {
  let viewed = '';
  const { page } = loadPage({ preparePreview: async () => ({ ...preview,
    info: { ...preview.info, format: 'RAW', exportSupported: false }, previewPath: undefined, exportPath: undefined,
    rawJpeg: { path: '/local/camera.jpg', width: 6720, height: 4480 } }),
    previewRawJpeg: async (path: string) => { viewed = path; } }, { previewImage: () => {} });
  await page.chooseFile();
  page.handlePreviewFailure(page.data.previewPath);
  assert.equal(page.data.previewPath, ''); assert.equal(page.data.canViewRawJpeg, true);
  const wxml = readFileSync('src/pages/index/index.wxml', 'utf8');
  const placeholder = wxml.slice(wxml.indexOf('<view class="stage-message">'), wxml.indexOf('</scroll-view>'));
  assert.match(placeholder, /<button wx:if="{{canViewRawJpeg}}"[^>]+bindtap="viewCameraJpeg"/);
  await page.viewCameraJpeg(); assert.equal(viewed, '/local/camera.jpg');
});

const finger = (x = 100, y = 100, identifier = 1) => ({ clientX: x, clientY: y, identifier });
const touchEvent = (timeStamp: number, touches: unknown[], changedTouches = touches) => ({ timeStamp, touches, changedTouches });
function tapPreview(page: Record<string, any>, time: number, x = 100, y = 100) {
  const point = finger(x, y);
  page.onPreviewTouchStart(touchEvent(time, [point]));
  page.onPreviewTouchEnd(touchEvent(time + 40, [], [point]));
}

test('double taps cycle through fit, 2x and a real source-pixel level without altering saved files', async () => {
  const control = controlledDetail();
  const { page, saved, nativeSaved } = loadPage({ preparePreview: async () => detailedPreview(control.detail) },
    { getWindowInfo: () => ({ pixelRatio: 2 }) });
  await page.chooseFile(); page.scheduleDetail = () => {};
  page.createSelectorQuery = () => ({ select: () => ({ boundingClientRect: () => ({ exec: (done: (value: unknown[]) => void) =>
    done([{ left: 0, top: 0, width: 300, height: 200 }]) }) }) });
  tapPreview(page, 0); tapPreview(page, 100);
  assert.equal(page.data.zoomCommand, 2);
  tapPreview(page, 500); tapPreview(page, 600);
  const pixels = rawPixelZoom(control.detail, { left: 0, top: 0, width: 300, height: 200 }, 2)!;
  await waitFor(() => page.data.zoomCommand === pixels, 'Second double tap selects real source pixels');
  assert.ok(pixels > 2);
  tapPreview(page, 1000); tapPreview(page, 1100);
  await waitFor(() => page.data.zoomCommand === 1, 'Third double tap returns to fit');
  assert.equal(page.exportPath, preview.exportPath); assert.equal(page.data.canSave, true);
  assert.deepEqual(saved, []); assert.deepEqual(nativeSaved, []); assert.deepEqual(control.released, []);
});

test('dragging, multi-touch, long presses and cancellations do not become double taps', async () => {
  for (const action of ['drag', 'multitouch', 'cancel', 'longpress', 'identifier', 'scale', 'far', 'late']) {
    const { page } = loadPage(); await page.chooseFile(); page.scheduleDetail = () => {};
    tapPreview(page, 0);
    const point = finger(); page.onPreviewTouchStart(touchEvent(100, [point]));
    let endTime = 140, end = point;
    if (action === 'drag') { end = finger(130); page.onPreviewTouchMove(touchEvent(120, [end])); }
    if (action === 'multitouch') page.onPreviewTouchMove(touchEvent(120, [point, finger(140, 140, 2)]));
    if (action === 'cancel') page.onPreviewTouchCancel(touchEvent(120, [], [point]));
    if (action === 'longpress') endTime = 400;
    if (action === 'identifier') end = finger(100, 100, 2);
    if (action === 'scale') page.onScale({ detail: { scale: 1.5, x: 0, y: 0 } });
    if (action === 'far') end = finger(160);
    if (action === 'late') endTime = 600;
    page.onPreviewTouchEnd(touchEvent(endTime, [], [end]));
    assert.equal(page.viewportZoom, action === 'scale' ? 1.5 : 1, action);
    page.backToHome();
  }
});

test('double taps skip an unavailable or suspended pixel decoder instead of enlarging cached RAW thumbnails', async () => {
  for (const suspended of [false, true]) {
    const { page } = loadPage(); await page.chooseFile(); page.scheduleDetail = () => {};
    if (suspended) { page.detail = controlledDetail().detail; page.detailSuspended = true; }
    tapPreview(page, 0); tapPreview(page, 100); assert.equal(page.data.zoomCommand, 2);
    tapPreview(page, 500); tapPreview(page, 600);
    await waitFor(() => page.data.zoomCommand === 1, 'No active source decoder skips the pixel level');
  }
});

test('late pixel-zoom measurements cannot overwrite a newer touch, a resized view or a different file', async () => {
  for (const action of ['touch', 'resize', 'file', 'decoder-error', 'memory']) {
    const control = controlledDetail(); let finish!: (value: unknown[]) => void;
    const { page } = loadPage({ preparePreview: async () => detailedPreview(control.detail) });
    await page.chooseFile(); page.scheduleDetail = () => {};
    page.createSelectorQuery = () => ({ select: () => ({ boundingClientRect: () => ({ exec: (done: typeof finish) => { finish = done; } }) }) });
    tapPreview(page, 0); tapPreview(page, 100); tapPreview(page, 500); tapPreview(page, 600);
    assert.equal(typeof finish, 'function');
    if (action === 'touch') page.onPreviewTouchStart(touchEvent(700, [finger()]));
    if (action === 'resize') { page.setData({ previewToolsOpen: true }); page.onResize(); assert.equal(page.data.previewToolsOpen, false); }
    if (action === 'file') { page.getCanvas = async () => ({}); await page.chooseFile(); }
    if (action === 'decoder-error') page.detail = undefined;
    if (action === 'memory') page.detailSuspended = true;
    finish([{ left: 0, top: 0, width: 300, height: 200 }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.zoomCommand, action === 'file' ? 1 : 2, action);
    page.backToHome();
  }
});

test('a missing native bounds callback times out the optional pixel step without blocking file selection', async () => {
  const { page } = loadPage({ preparePreview: async () => detailedPreview(controlledDetail().detail) });
  await page.chooseFile(); page.scheduleDetail = () => {};
  page.viewportZoom = 2; page.publishZoom(true);
  page.createSelectorQuery = () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }) });
  await page.doubleTapZoom(page.tapVersion);
  assert.equal(page.data.zoomCommand, 1); assert.equal(page.data.busy, false);
  page.backToHome();
});

test('tiny Canvas double taps ignore duplicate parent events, mixed coordinate systems and native dragging', async () => {
  const { page } = loadPage(); await page.chooseFile(); page.scheduleDetail = () => {};
  page.setData({ pixelPreview: true });
  const point = { x: 50, y: 50, identifier: 1 };
  for (const time of [0, 100]) {
    const start = touchEvent(time, [point]), end = touchEvent(time + 40, [], [point]);
    page.onPixelTouchStart(start); page.onPreviewTouchStart(start);
    page.onPixelTouchEnd(end); page.onPreviewTouchEnd(end);
  }
  assert.equal(page.data.zoomCommand, 2);
  page.fitToScreen();
  page.onPixelTouchStart(touchEvent(500, [point]));
  page.onMove({ detail: { source: 'touch', x: 40, y: 0 } });
  page.onPixelTouchEnd(touchEvent(540, [], [point]));
  page.onPixelTouchStart(touchEvent(600, [point])); page.onPixelTouchEnd(touchEvent(640, [], [point]));
  assert.equal(page.data.zoomCommand, 1);
  page.resetPreviewTap();
  page.onPixelTouchStart(touchEvent(800, [finger(50, 50)]));
  page.onPixelTouchEnd(touchEvent(840, [], [point]));
  page.onPixelTouchStart(touchEvent(900, [point])); page.onPixelTouchEnd(touchEvent(940, [], [point]));
  assert.equal(page.data.zoomCommand, 1);
  page.resetPreviewTap();
  page.onPixelTouchStart(touchEvent(1000, [finger(50, 50)]));
  page.setData({ pixelPreview: false });
  page.onPreviewTouchEnd(touchEvent(1040, [], [finger(50, 50)]));
  tapPreview(page, 1100, 50, 50); assert.equal(page.data.zoomCommand, 1);
});

test('fitted frames use the loaded image ratio within the measured budget and leave saved files unchanged', async () => {
  const { page, saved } = loadPage();
  await page.chooseFile();
  const body = { left: 0, top: 60, width: 351, height: 600 };
  const stage = { left: 0, top: 60, width: 351, height: 448 };
  const toolbar = { left: 0, top: 516, width: 351, height: 44 };
  const actions = { height: 100, 'min-height': '100px' };
  let measurements = 0;
  page.createSelectorQuery = () => {
    const selectors: string[] = [];
    const query = { select: (name: string) => { selectors.push(name); return query; }, boundingClientRect: () => query, fields: () => query,
      exec: (done: (value: unknown[]) => void) => {
        assert.deepEqual(selectors, ['.preview-body', '.toolbar', '.stage', '.preview-actions']); measurements++;
        done([body, toolbar, stage, actions]);
      } };
    return query;
  };
  const load = (width: number, height: number, path = page.data.previewPath) =>
    page.onPreviewLoad({ detail: { width, height }, currentTarget: { dataset: { path } } });
  load(6000, 4000);
  assert.match(page.data.stageStyle, /width:351\.000px;height:234\.000px/);
  actions.height = 250; page.fitPreviewFrame();
  assert.match(page.data.stageStyle, /width:351\.000px;height:234\.000px/); // Expanded notes cannot consume the image budget twice.
  load(4000, 6000);
  assert.match(page.data.stageStyle, /width:298\.667px;height:448\.000px/);
  load(100, 100);
  assert.match(page.data.stageStyle, /width:351\.000px;height:351\.000px/);
  const previous = page.data.stageStyle, count = measurements;
  for (const [width, height] of [[NaN, 200], [0, 10], [-1, 200], [100, Infinity]]) load(width, height);
  load(4000, 6000, '/local/old-file.png');
  assert.equal(page.data.stageStyle, previous); assert.equal(measurements, count);
  Object.assign(body, { width: 700, height: 252 }); Object.assign(stage, { height: 100 });
  Object.assign(toolbar, { top: 168 }); // 8px gap after stage at top 60.
  page.onResize();
  assert.match(page.data.stageStyle, /width:100\.000px;height:100\.000px/);
  Object.assign(body, { width: 351, height: 600 });
  page.onResize(); assert.match(page.data.stageStyle, /width:351\.000px;height:351\.000px/);
  actions['min-height'] = 'auto'; load(4000, 6000);
  assert.match(page.data.stageStyle, /width:332\.000px;height:498\.000px/);
  actions['min-height'] = '100px'; page.onResize();
  assert.match(page.data.stageStyle, /width:298\.667px;height:448\.000px/);
  await page.saveImage(); assert.deepEqual(saved, ['/local/preview.png']);
  page.backToHome(); assert.equal(page.data.stageStyle, ''); assert.equal(page.previewFrame, undefined);
});

test('late frame measurements cannot overwrite a mode switch, resize, hidden page or new file', async () => {
  for (const action of ['mode', 'resize', 'hide', 'back']) {
    const { page } = loadPage(); await page.chooseFile();
    const callbacks: ((value: unknown[]) => void)[] = [];
    page.createSelectorQuery = () => {
      const query = { select: () => query, boundingClientRect: () => query, fields: () => query,
        exec: (done: (value: unknown[]) => void) => callbacks.push(done) }; return query;
    };
    page.setPreviewFrame(page.data.previewPath, 6000, 4000);
    if (action === 'mode') page.setData({ previewPath: '/local/other-mode.png' });
    if (action === 'resize') page.onResize();
    if (action === 'hide') page.onHide();
    if (action === 'back') page.backToHome();
    const previous = page.data.stageStyle;
    callbacks[0]([{ width: 351, height: 600 }, { top: 456, height: 44 }, { top: 0, height: 448 }, { height: 100, 'min-height': '100px' }]);
    assert.equal(page.data.stageStyle, previous, action);
    if (page.data.hasFile) page.backToHome();
  }
});

test('frame resizing invalidates and releases the old HD overlay without changing the decoder', async () => {
  const control = controlledDetail();
  const { page } = loadPage({ preparePreview: async () => detailedPreview(control.detail) });
  await page.chooseFile();
  page.setData({ detailPath: '/local/old-hd.png', detailStyle: 'left:0px;' });
  let refreshes = 0; page.scheduleDetail = () => { refreshes++; };
  page.createSelectorQuery = () => {
    const query = { select: () => query, boundingClientRect: () => query, fields: () => query,
      exec: (done: (value: unknown[]) => void) => done([
        { width: 351, height: 600 }, { top: 456, height: 44 }, { top: 0, height: 448 }, { height: 100, 'min-height': '100px' }]) };
    return query;
  };
  page.setPreviewFrame(page.data.previewPath, 6000, 4000);
  assert.equal(page.detail, control.detail); assert.equal(page.data.detailPath, '');
  assert.deepEqual(control.released, ['/local/old-hd.png']); assert.equal(refreshes, 1);
  const version = page.detailVersion;
  page.fitPreviewFrame(); assert.equal(page.detailVersion, version); // Same layout is not exported or rendered twice.
  page.backToHome();
});

test('native preview return consumes one session and uses the existing cancellation and cleanup path', async () => {
  const { page, cleanups } = loadPage(); page.onLoad(); await page.chooseFile();
  assert.equal(page.data.canGuardPreview, true); assert.equal(page.data.previewBackSessions.length, 1);
  const session = page.data.previewBackSessions[0], job = page.jobId, count = cleanups();
  const back = { currentTarget: { dataset: { session } } };
  page.onPreviewBack(back);
  assert.equal(page.data.hasFile, false); assert.equal(page.data.previewBackSessions.length, 0);
  assert.equal(page.jobId, job + 1); assert.equal(cleanups(), count + 1);
  page.onPreviewBack(back); assert.equal(page.jobId, job + 1); assert.equal(cleanups(), count + 1);
  await page.chooseFile(); const nextSession = page.data.previewBackSessions[0];
  assert.notEqual(nextSession, session);
  page.onPreviewBack(back); assert.equal(page.data.hasFile, true);
  page.onPreviewBack({ currentTarget: { dataset: { session: 'invalid' } } }); assert.equal(page.data.hasFile, true);
  page.onPreviewBack({ currentTarget: { dataset: { session: String(nextSession) } } }); assert.equal(page.data.hasFile, false);
});

test('page-button return and unsupported native clients do not create a fake exit promise', async () => {
  const { page } = loadPage(); page.onLoad(); await page.chooseFile();
  const session = page.data.previewBackSessions[0]; page.backToHome(); const job = page.jobId;
  page.onPreviewBack({ currentTarget: { dataset: { session } } }); assert.equal(page.jobId, job);
  for (const canIUse of [() => false, () => { throw new Error('Unsupported'); }]) {
    const older = loadPage({}, { canIUse }).page;
    older.onLoad(); await older.chooseFile();
    assert.equal(older.data.canGuardPreview, false);
    older.onPreviewBack({ currentTarget: { dataset: { session: older.data.previewBackSessions[0] } } });
    assert.equal(older.data.hasFile, true); // Only the visible back button is available on these clients.
    older.backToHome(); assert.equal(older.data.hasFile, false);
  }
});

test('native return during parsing invalidates a late result without reopening the preview', async () => {
  let finish!: (value: typeof preview) => void;
  const { page } = loadPage({ preparePreview: () => new Promise<typeof preview>(done => { finish = done; }) });
  page.onLoad(); const task = page.chooseFile();
  await waitFor(() => !!finish, 'Parsing starts');
  const session = page.data.previewBackSessions[0];
  page.onPreviewBack({ currentTarget: { dataset: { session } } });
  finish(preview); await task;
  assert.equal(page.data.hasFile, false); assert.equal(page.data.busy, false); assert.equal(page.data.previewPath, '');
});

test('file details reuse actual parsed metadata and distinguish a RAW thumbnail from its camera JPEG', async () => {
  let preparations = 0;
  const { page } = loadPage({ chooseDesignFile: async () => ({ ...selected, source: 'album' }),
    preparePreview: async () => { preparations++; return { ...preview,
      info: { ...preview.info, format: 'RAW', filename: 'converted-name.CR2', filesize: 33900585, width: 6720, height: 4480 },
      exportSize: { width: 160, height: 120 }, rawJpeg: { path: '/local/private-camera.jpg', width: 6720, height: 4480 } }; } });
  await page.chooseFile();
  const facts = () => Object.fromEntries(page.data.fileFacts.map((row: { label: string; value: string }) => [row.label, row.value]));
  assert.equal(facts()['识别格式'], 'RAW'); assert.equal(facts()['导入来源'], '相册');
  assert.equal(facts()['文件体积'], '32.3 MiB · 33900585 字节');
  assert.equal(facts()['概览 PNG'], '160 × 120 px'); assert.equal(facts()['相机内嵌 JPG'], '6720 × 4480 px');
  assert.equal(facts()['传感器有效画面'], undefined);
  assert.doesNotMatch(JSON.stringify(page.data.fileFacts), /\/local\/|\/chat\/|GPS|72 DPI|300 DPI/);
  for (let i = 0; i < 6; i++) page.togglePreviewDetails();
  assert.equal(preparations, 1); page.backToHome(); assert.equal(page.data.fileFacts.length, 0);
});

test('sensor detail dimensions are labelled separately and converted photos keep their actual type', async () => {
  for (const sensor of [true, false]) {
    const { page } = loadPage({ preparePreview: async () => ({ ...preview,
      info: { ...preview.info, format: sensor ? 'RAW' : 'JPEG', width: 5304, height: 7952, colorMode: 'RGB', bitDepth: sensor ? 14 : 8 },
      ...(sensor ? { detail: controlledDetail().detail, rawJpeg: { path: '/local/camera.jpg', width: 1080, height: 1616 } } : { originalImage: 'JPEG' }) }) });
    await page.chooseFile();
    const facts = Object.fromEntries(page.data.fileFacts.map((row: { label: string; value: string }) => [row.label, row.value]));
    assert.equal(facts[sensor ? '传感器有效画面' : '图像画布'], '5304 × 7952 px');
    assert.equal(facts['识别格式'], sensor ? 'RAW' : 'JPEG'); assert.equal(facts['颜色与位深'], sensor ? 'RGB · 14 位' : 'RGB · 8 位');
    assert.equal(facts['相机内嵌 JPG'], sensor ? '1080 × 1616 px' : undefined);
    page.backToHome();
  }
});

test('rotation refreshes tiny Canvas aspect fit and ignores an older image load', async () => {
  let defer = false; const ticks: (() => void)[] = [];
  const { page, saved } = loadPage({}, { nextTick: (done: () => void) => { if (defer) ticks.push(done); else done(); } });
  const draws: unknown[][] = [], images: { onload: () => void; onerror: () => void; src?: string }[] = [];
  let portrait = false;
  const display = { width: 0, height: 0,
    getContext: () => ({ imageSmoothingEnabled: true, drawImage: (...args: unknown[]) => { draws.push(args); } }),
    createImage: () => { const image = { onload: () => {}, onerror: () => {} }; images.push(image); return image; } };
  page.getCanvas = async () => ({});
  page.createSelectorQuery = () => ({ select: () => ({ fields: () => ({ exec: (done: (value: unknown[]) => void) =>
    done([{ node: display, width: portrait ? 200 : 300, height: portrait ? 300 : 200 }]) }) }) });
  await page.chooseFile(); assert.equal(images.length, 1); assert.equal(page.data.pixelPreview, true);
  portrait = true; defer = true; page.onResize(); assert.equal(images.length, 1);
  images[0].onload(); assert.equal(draws.length, 0);
  while (ticks.length) ticks.shift()!(); assert.equal(images.length, 2);
  images[0].onload(); assert.equal(draws.length, 0);
  images[1].onload(); assert.equal(draws.length, 1);
  assert.ok(Math.abs(Number(draws[0][3]) / Number(draws[0][4]) - 2 / 3) < 1e-8);
  assert.deepEqual([display.width, display.height], [910, 1365]);
  page.onResize(); page.setData({ pixelPreview: false }); ticks.shift()!(); assert.equal(images.length, 2);
  defer = false;
  await page.saveImage(); assert.deepEqual(saved, [preview.exportPath]);
});
