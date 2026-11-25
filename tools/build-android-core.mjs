import { build } from 'esbuild';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = 'android/app/src/main/assets';
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: ['src/platform/android-runtime.ts'],
  outfile: path.join(out, 'core.js'),
  bundle: true, platform: 'browser', format: 'iife', target: 'es2018',
  minify: true, legalComments: 'eof', metafile: true,
});
if (Object.values(result.metafile.outputs).some(file => file.imports.some(item => item.external))) {
  throw new Error('Android core must not have external runtime dependencies');
}
await writeFile(path.join(out, 'core.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' file:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'"><script src="core.js"></script>\n');
await mkdir(path.join(out, 'licenses'), { recursive: true });
for (const file of await readdir('licenses')) await copyFile(path.join('licenses', file), path.join(out, 'licenses', file));
await copyFile('LICENSE', path.join(out, 'LICENSE.txt'));
await copyFile('THIRD_PARTY_NOTICES.md', path.join(out, 'THIRD_PARTY_NOTICES.md'));
console.log('Bundled existing TypeScript decoders for offline Android; no external imports.');
