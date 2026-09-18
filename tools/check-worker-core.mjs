// Prove core/ runs in a Web Worker: no document, no window, no Image.
//
// Bundles tools/worker-smoke/worker.ts and a page that spawns it into
// public/worker-smoke/, to be served alongside the site. Open the page (or
// let tools/check-worker-core.py drive it in headless Chromium) and it
// reports what the worker managed. A grep for DOM globals in core/ runs
// first, because that catches the regression without a browser at all.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'public', 'worker-smoke');

// 1. Static: nothing in core/ may name a DOM global. wmts.ts is the one
//    exception (DOMParser for GetCapabilities) and is main-thread only.
//    Uses of the globals, not mentions of the words: a geotiff "window" or
//    an HTMLCanvasElement in a type position are fine.
const banned = /\bdocument\.|\bwindow\.|\bnew Image\(|\balert\(|\blocalStorage\b|\bnavigator\./;
const guarded = /typeof document !== 'undefined'|typeof OffscreenCanvas !== 'undefined'/;
const allowed = new Set(['wmts.ts']);
let bad = 0;
for (const f of readdirSync(join(root, 'src', 'core'))) {
  if (allowed.has(f)) continue;
  const lines = readFileSync(join(root, 'src', 'core', f), 'utf8').split('\n');
  let guardedBlock = false;
  lines.forEach((l, i) => {
    const s = l.trim();
    if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*')) return;
    const code = l.replace(/\/\/.*$/, '');
    // A DOM call on the line after a typeof guard is the fallback branch.
    if (guarded.test(code)) { guardedBlock = true; return; }
    if (banned.test(code) && !guardedBlock) {
      console.error(`core/${f}:${i + 1}: ${s}`);
      bad++;
    }
    if (/^\s*}/.test(l) || /return/.test(code)) guardedBlock = false;
  });
}
if (bad) {
  console.error(`${bad} DOM reference(s) in src/core - core must stay worker-safe`);
  process.exit(1);
}

// 2. Bundle the worker and a page that drives it.
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'tools', 'worker-smoke', 'worker.ts')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  outfile: join(out, 'worker.js'), logLevel: 'error'
});
writeFileSync(join(out, 'index.html'), `<!doctype html>
<meta charset="utf-8"><title>core in a worker</title>
<pre id="out">starting worker...</pre>
<script type="module">
  const q = new URLSearchParams(location.search);
  const w = new Worker('./worker.js', { type: 'module' });
  w.onmessage = (e) => {
    document.getElementById('out').textContent = JSON.stringify(e.data, null, 2);
    window.__result = e.data;
  };
  w.onerror = (e) => { document.getElementById('out').textContent = 'worker error: ' + e.message; window.__result = { ok: false, error: e.message }; };
  w.postMessage({
    cog: q.get('cog') ?? 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/EN/2024/12/S2A_55GEN_20241204_0_L2A/TCI.tif',
    tiles: q.get('tiles') ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    projWasmBase: new URL('../proj-wasm/', location.href).href
  });
</script>`);
console.log('worker smoke test built into public/worker-smoke/ (serve the site and open /worker-smoke/)');
