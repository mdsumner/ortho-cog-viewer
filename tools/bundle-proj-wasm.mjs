// Bundle proj-wasm into a self-contained folder the viewer can load by URL.
//
// proj-wasm (PROJ 9 compiled to wasm, with the real EPSG database) is not
// something to put through the main bundle: it is 15 MB, it spawns module
// workers that dynamic-import their own handler files, and every one of
// those files finds its neighbours relative to import.meta.url. So it is
// laid out flat in public/proj-wasm/, each entry bundled on its own, and
// src/core/projwasm.ts imports proj.mjs from that folder on the first CRS
// miss. Nothing here touches the page until that moment.
//
// Runs before dev and build (see package.json). Output is not committed.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'public', 'proj-wasm');
const dist = dirname(require.resolve('proj-wasm'));   // .../proj-wasm/dist/proj.mjs
const pkg = dirname(dist);
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;

const stamp = join(out, 'VERSION');
if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === version) {
  process.exit(0);
}
mkdirSync(out, { recursive: true });

// The node-only branches import these lazily; the browser never reaches them.
const nodeOnly = ['fs', 'path', 'url', 'module', 'worker_threads', 'node:*', 'comlink/dist/esm/node-adapter.mjs'];

async function bundle(entry, file) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: join(out, file),
    external: nodeOnly,
    logLevel: 'error'
  });
}

// Main-thread API. Its worker bootstrap and comlink are located with
// import.meta.resolve() of bare names, which needs an import map in the page;
// point them at the files beside it instead so the folder stands alone.
await bundle(join(dist, 'proj.mjs'), 'proj.mjs');
{
  const f = join(out, 'proj.mjs');
  let s = readFileSync(f, 'utf8');
  const swaps = [
    ['import.meta.resolve("worker-router/worker-bootstrap")', 'new URL("./worker-bootstrap.mjs", import.meta.url).href'],
    ['import.meta.resolve("comlink")', 'new URL("./comlink.mjs", import.meta.url).href']
  ];
  for (const [from, to] of swaps) {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`bundle-proj-wasm: expected exactly one ${from}, found ${n}; proj-wasm ${version} has changed shape`);
    s = s.replace(from, to);
  }
  writeFileSync(f, s);
}

// Worker side: the bootstrap (plain module, no imports), comlink for it to
// import, and the PROJ handler with its runtime folded in.
copyFileSync(join(dist, 'worker-bootstrap.mjs'), join(out, 'worker-bootstrap.mjs'));
// comlink is worker-router's dependency; let esbuild resolve it from
// proj-wasm's own position, as the worker-router bundle inside proj.mjs did.
await build({
  stdin: { contents: 'export * from "comlink";', resolveDir: dist, loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  outfile: join(out, 'comlink.mjs'), logLevel: 'error'
});
await bundle(join(dist, 'proj-handler.mjs'), 'proj-handler.mjs');

// The emscripten glue, the wasm, and the database it opens.
for (const f of ['proj-emscripten.js', 'proj-emscripten.wasm', 'proj.db', 'proj.ini']) {
  copyFileSync(join(dist, f), join(out, f));
}
copyFileSync(join(pkg, 'LICENSE'), join(out, 'LICENSE'));
writeFileSync(stamp, version + '\n');
console.log(`proj-wasm ${version} bundled into public/proj-wasm/`);
