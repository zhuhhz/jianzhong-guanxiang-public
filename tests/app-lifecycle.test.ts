import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const code = transformSync(readFileSync('src/app.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
function appHarness() {
  let app: Record<string, any> = {}, ready!: () => void, applied = 0;
  let pages: { data: { hasFile: boolean; busy: boolean } }[] = [];
  const dialogs: { success: (result: { confirm: boolean }) => void }[] = [];
  runInNewContext(code, { App: (value: typeof app) => { app = value; },
    getCurrentPages: () => pages,
    wx: { getUpdateManager: () => ({ onUpdateReady: (callback: () => void) => { ready = callback; }, applyUpdate: () => { applied++; } }),
      showModal: (options: typeof dialogs[number]) => dialogs.push(options) } });
  return { app, ready: () => ready(), dialogs, applied: () => applied, pages: (value: typeof pages) => { pages = value; } };
}

test('chat PSD launch provides one local file and cannot interrupt import with an update prompt', () => {
  const h = appHarness(); h.app.onLaunch(); h.ready(); h.pages([{ data: { hasFile: false, busy: false } }]);
  const material = { name: 'sample.PSD', path: 'wxfile://tmp_sample', size: 58, type: 'application/x-photoshop' };
  h.app.onShow({ scene: 1173, forwardMaterials: [material] });
  assert.equal(h.dialogs.length, 0);
  assert.deepEqual({ ...h.app.takeChatPsd() }, { name: material.name, path: material.path, size: material.size, source: 'chat-open' });
  assert.equal(h.app.takeChatPsd(), undefined);
  h.app.onShow({ scene: 1001, forwardMaterials: [material] });
  assert.equal(h.app.takeChatPsd(), undefined);
  h.app.onShow({ scene: 1173, query: { forwardMaterials: [material] } });
  assert.equal(h.app.takeChatPsd(), 'unavailable');
  for (const invalid of [{ ...material, path: 'https://example.org/sample.psd' }, { ...material, name: 'sample.pdf' }]) {
    h.app.onShow({ scene: 1173, forwardMaterials: [invalid] });
    assert.equal(h.app.takeChatPsd(), 'unavailable');
  }
});

test('a ready update waits for a foreground idle home page and prompts once', () => {
  const h = appHarness(); h.app.onLaunch(); h.ready();
  h.app.onShow(); assert.equal(h.dialogs.length, 0);
  h.pages([{ data: { hasFile: true, busy: false } }]);
  h.app.offerUpdate(); assert.equal(h.dialogs.length, 0);
  h.pages([{ data: { hasFile: false, busy: true } }]);
  h.app.offerUpdate(); assert.equal(h.dialogs.length, 0);
  h.pages([{ data: { hasFile: false, busy: false } }]);
  h.app.offerUpdate(); assert.equal(h.dialogs.length, 1);
  h.dialogs[0].success({ confirm: false }); h.app.onShow();
  assert.equal(h.applied(), 0); assert.equal(h.dialogs.length, 1);
});

test('confirming an update rechecks foreground and file activity before restarting', () => {
  for (const interruption of ['none', 'file', 'busy', 'hide', 'closing-export']) {
    const h = appHarness(); h.app.onLaunch();
    h.pages([{ data: { hasFile: false, busy: false } }]); h.app.onShow(); h.ready();
    assert.equal(h.dialogs.length, 1);
    if (interruption === 'file') h.pages([{ data: { hasFile: true, busy: false } }]);
    if (interruption === 'busy') h.pages([{ data: { hasFile: false, busy: true } }]);
    if (interruption === 'hide') h.app.onHide();
    if (interruption === 'closing-export') h.pages([Object.assign({ data: { hasFile: false, busy: false } }, { nativeTask: Promise.resolve() })]);
    h.dialogs[0].success({ confirm: true });
    assert.equal(h.applied(), interruption === 'none' ? 1 : 0);
  }
});

test('unsupported update APIs are optional and runtime errors retain only a constant local flag', () => {
  let app: Record<string, any> = {};
  runInNewContext(code, { App: (value: typeof app) => { app = value; }, wx: {} });
  assert.doesNotThrow(() => { app.onLaunch(); app.onShow(); });
  app.onError('private filename, path, GPS and stack text');
  assert.equal(app.globalData.runtimeError, true);
  assert.equal(JSON.stringify(app.globalData).includes('private'), false);
});
