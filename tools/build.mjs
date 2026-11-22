import { build } from 'esbuild';
import { mkdir, readdir, copyFile, writeFile, unlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, 'dist');
await mkdir(out, { recursive: true });
// Only known build outputs are overwritten. No recursive delete of user files.
async function copyAssets(dir) {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const source = path.join(dir, file.name);
    if (file.isDirectory()) await copyAssets(source);
    else if (/\.(json|wxml|wxss)$/.test(file.name) || source === path.join(root, 'src', 'assets', 'share-cover.png')
      || source === path.join(root, 'src', 'raw-engine', 'flashraw.wasm.br')
      || source === path.join(root, 'src', 'raw-engine', 'entry.js')) {
      const target = path.join(out, path.relative(path.join(root, 'src'), source));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
}
await copyAssets(path.join(root, 'src'));
// Remove only the known obsolete build output; keep unexpected user files intact.
const legacyWasm = path.join(out, 'raw-engine', 'flashraw.wasm');
try {
  if (createHash('sha256').update(await readFile(legacyWasm)).digest('hex') !== '45a7f332c880fa012d152f8c744ac40f82e99a52a5ccf0fa37b347f84d1109de') {
    throw new Error('Unexpected legacy RAW binary in dist; not removed');
  }
  await unlink(legacyWasm);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.join(out, 'licenses'), { recursive: true });
for (const file of await readdir(path.join(root, 'licenses'))) {
  await copyFile(path.join(root, 'licenses', file), path.join(out, 'licenses', file));
}
await copyFile(path.join(root, 'LICENSE'), path.join(out, 'LICENSE.txt'));
const result = await build({
  entryPoints: ['src/app.ts', 'src/pages/index/index.ts'],
  outdir: out, outbase: 'src', bundle: true, platform: 'neutral', format: 'cjs',
  mainFields: ['module', 'main'], target: 'es2018', minify: true,
  legalComments: 'eof', metafile: true,
  plugins: [{
    name: 'tiff-numeric-io',
    setup(plugin) {
      // TIFF's allow-listed numeric raster tags never use iobuffer text I/O.
      // Avoid its eager TextEncoder constructor, unavailable in WeChat JS.
      plugin.onLoad({ filter: /[\\/]iobuffer[\\/]lib[\\/]text\.js$/ }, () => ({
        contents: 'export function encode() { throw new Error("TIFF text I/O is disabled"); } export const decode = encode;',
        loader: 'js',
      }));
    },
  }],
});
// Generate a readable inventory without shipping build tooling into the Mini Program.
await mkdir(path.join(root, 'test-results'), { recursive: true });
await writeFile(path.join(root, 'test-results', 'build-meta.json'), JSON.stringify(result.metafile, null, 2));
// Smoke-test module initialization without DOM, Buffer, Node require, network, or wx APIs.
// This checks packaging only; WXML compilation and native rendering need WeChat DevTools.
for (const [file, api] of [['app.js', 'App'], ['pages/index/index.js', 'Page']]) {
  let registered = false;
  runInNewContext(await readFile(path.join(out, file), 'utf8'), {
    [api]: definition => { if (!definition || typeof definition !== 'object') throw new Error(`Invalid ${api}`); registered = true; },
    console,
  }, { timeout: 3000 });
  if (!registered) throw new Error(`${api} was not registered`);
}
if (Object.values(result.metafile.outputs).some(output => output.imports.some(item => item.external))) throw new Error('Unexpected external runtime module');
// Inspect actual package files, including stale outputs, before handing dist to DevTools.
async function packageBytes(dir, excluded = []) {
  let bytes = 0;
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, file.name);
    if (!excluded.includes(target)) bytes += file.isDirectory() ? await packageBytes(target) : (await stat(target)).size;
  }
  return bytes;
}
const app = JSON.parse(await readFile(path.join(out, 'app.json'), 'utf8'));
const subpackages = (app.subpackages || []).map(item => path.join(out, item.root));
let totalPackageBytes = 0;
for (const [name, dir, excluded] of [['main', out, subpackages], ...subpackages.map(dir => [path.basename(dir), dir, []])]) {
  const bytes = await packageBytes(dir, excluded);
  if (bytes > 2 * 1024 * 1024) throw new Error(`Code package ${name} exceeds 2 MiB: ${bytes} bytes`);
  console.log(`Code package ${name}: ${bytes} bytes (within 2 MiB)`);
  totalPackageBytes += bytes;
}
console.log(`All code packages: ${totalPackageBytes} bytes`);
console.log('Native Mini Program built in dist/; package initialization PASS (not WeChat compilation)');
