// Hold rwarp to the reference warp on synthetic data.
//
// A Web Mercator source with a colour gradient is warped by both backends
// onto the same destination grid in several CRSs, nearest neighbour, and
// compared pixel by pixel where both produced a value. Two independent
// implementations - rwarp's Rust transformer over proj4rs, and the
// viewer's own proj4js path - should agree to within the rounding of
// nearest neighbour at pixel edges. If they drift apart, one of the CRS
// executors has changed its mind about where a point is.
//
//   node tools/check-warp.mjs
import { build } from 'esbuild';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// The viewer's core, bundled for node in one go so crs.ts and warp.ts share one proj4.
const entry = join(root, '.warp-entry.ts');
const bundle = join(root, '.warp-check.cjs');
writeFileSync(entry, "export * from './src/core/warp';\nexport * from './src/core/crs';\n");
await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, logLevel: 'error' });
const core = require(bundle);
unlinkSync(entry); unlinkSync(bundle);
core.registerProjections();

// rwarp from wherever bundle-rwarp.mjs would take it.
const pkgDir = [join(root, 'node_modules', 'rwarp-wasm'), process.env.RWARP_PKG ?? '', join(root, 'vendor', 'rwarp-wasm')]
  .filter(Boolean).find((d) => { try { readFileSync(join(d, 'rwarp_wasm_bg.wasm')); return true; } catch { return false; } });
if (!pkgDir) { console.error('no rwarp-wasm package found'); process.exit(2); }
const mod = await import(pathToFileURL(join(pkgDir, 'rwarp_wasm.js')).href);
await mod.default({ module_or_path: readFileSync(join(pkgDir, 'rwarp_wasm_bg.wasm')) });
const rwarp = core.rwarpBackend(mod);

// Source: Web Mercator zoom 4, R = column, G = row, B = 128.
const HALF = 20037508.342789244;
const n = 256 << 4, px = 2 * HALF / n;
const srcGt = new Float64Array([-HALF, px, 0, HALF, 0, -px]);
const src = new Uint8ClampedArray(n * n * 4);
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  const i = (r * n + c) * 4;
  src[i] = c * 255 / n; src[i + 1] = r * 255 / n; src[i + 2] = 128; src[i + 3] = 255;
}
const srcCrs = core.crsDefinition('EPSG:3857');

const targets = {
  'laea Tasmania': ['+proj=laea +lat_0=-42 +lon_0=147 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs', 400000],
  'stere south (EPSG:3031)': [core.crsDefinition('EPSG:3031'), 6000000],
  'utm 55S': [core.crsDefinition('EPSG:32755'), 800000],
  'merc': [core.crsDefinition('EPSG:3857'), 10000000],
  'moll lon_0=147': ['+proj=moll +lon_0=147 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs', 30000000],
  'lcc Australia (EPSG:3112)': [core.crsDefinition('EPSG:3112'), 5000000]
};

let failed = false;
for (const [name, [dstCrs, extent]] of Object.entries(targets)) {
  const W = 300, H = 200, res = extent / W;
  const dstGt = new Float64Array([-extent / 2, res, 0, extent / 2 * H / W, 0, -res]);
  const job = { srcCrs, srcGt, srcW: n, srcH: n, dstCrs, dstGt, dstW: W, dstH: H, alg: 'nearest', nodata: null };
  const why = await rwarp.accepts(srcCrs, dstCrs);
  if (why) { console.log(`skip ${name}: ${why}`); continue; }
  const ref = await core.referenceBackend.warp({ ...job, rgba: src.slice() });
  // Exact (max_error 0) is the contract: it must agree with the reference.
  // The approximate transformer is what the viewer runs by default, so its
  // agreement is reported too; where it drops pixels the exact one keeps,
  // that is rwarp's approximation to look at, not a CRS disagreement.
  for (const maxError of [0, 0.125]) {
    const a = await rwarp.warp({ ...job, rgba: src.slice(), maxError });
    let both = 0, onlyA = 0, onlyB = 0, close = 0, worst = 0;
    for (let i = 0; i < W * H; i++) {
      const va = a.rgba[i * 4 + 3] > 0, vb = ref.rgba[i * 4 + 3] > 0;
      if (va && vb) {
        both++;
        const d = Math.max(Math.abs(a.rgba[i * 4] - ref.rgba[i * 4]), Math.abs(a.rgba[i * 4 + 1] - ref.rgba[i * 4 + 1]));
        if (d <= 2) close++;       // one source pixel = 255/4096 of a channel; 2 covers an edge
        if (d > worst) worst = d;
      } else if (va) onlyA++; else if (vb) onlyB++;
    }
    const agree = both ? close / both : 0;
    const cover = (onlyA + onlyB) / Math.max(1, both);
    const ok = both > 0 && agree >= 0.98 && cover < 0.02;
    const exact = maxError === 0;
    if (exact) failed ||= !ok;
    const tag = exact ? (ok ? 'ok  ' : 'FAIL') : (ok ? 'ok  ' : 'note');
    console.log(`${tag} ${name.padEnd(26)} ${exact ? 'exact ' : 'approx'}  both ${both.toString().padStart(6)}  agree ${(100 * agree).toFixed(2)}%  worst ${String(worst).padStart(3)}  ` +
                `only-rwarp ${String(onlyA).padStart(5)}  only-ref ${String(onlyB).padStart(5)}  (${Math.round(a.ms)} ms vs ref ${Math.round(ref.ms)} ms)`);
  }
}
if (failed) console.log('\nFAIL: exact rwarp and the reference disagree');
else console.log('\nOK: exact rwarp agrees with the reference on every CRS it accepts; "note" lines are the approximate transformer dropping pixels the exact one keeps');
process.exit(failed ? 1 : 0);
