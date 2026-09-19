// Lay rwarp-wasm out in public/rwarp/ so the warp worker can import it by
// URL: rwarp_wasm.js beside rwarp_wasm_bg.wasm, the same flat-folder
// arrangement as proj-wasm. Looked for, in order:
//   1. node_modules/rwarp-wasm        (the npm package, once published)
//   2. $RWARP_PKG                     (a local wasm-pack build: .../rwarp-wasm/pkg)
//   3. vendor/rwarp-wasm              (the interim copy committed here)
// Runs before dev and build; output is not committed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'public', 'rwarp');
const files = ['rwarp_wasm.js', 'rwarp_wasm_bg.wasm'];

const candidates = [
  join(root, 'node_modules', 'rwarp-wasm'),
  process.env.RWARP_PKG ?? '',
  join(root, 'vendor', 'rwarp-wasm')
].filter(Boolean);
const src = candidates.find((d) => files.every((f) => existsSync(join(d, f))));
if (!src) {
  console.warn('bundle-rwarp: no rwarp-wasm found (looked in ' + candidates.join(', ') + '); the warp engine will use the reference backend only');
  process.exit(0);
}
mkdirSync(out, { recursive: true });
const stamp = join(out, 'SOURCE');
const tag = src + ':' + files.map((f) => readFileSync(join(src, f)).length).join(',');
if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === tag) process.exit(0);
for (const f of files) copyFileSync(join(src, f), join(out, f));
writeFileSync(stamp, tag + '\n');
console.log(`rwarp-wasm from ${src} laid out in public/rwarp/`);
