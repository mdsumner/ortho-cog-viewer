#!/usr/bin/env python3
"""
Check the projections added in src/core/projections.ts against PROJ.

For each definition, a global grid of lon/lat points is projected forward by
proj4js (through the real crs.ts, with the extra projections registered) and
by pyproj, and compared in metres. proj4js's inverse is then applied to its
own forward and compared with the input, in degrees. Points PROJ refuses
(inside an interruption, say) are skipped for the forward comparison and
must come back NaN from the inverse.

  pip install pyproj
  python3 tools/check-projections.py
"""
import json, math, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOL_FWD_M = 0.01      # same closed forms, same radius: millimetres
TOL_INV_DEG = 1e-7    # inverse of own forward, in degrees (~1 cm)

DEFS = [
    '+proj=eck4 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    '+proj=eck4 +lon_0=147 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    '+proj=natearth +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    '+proj=natearth +lon_0=-100 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    '+proj=hammer +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    '+proj=hammer +lon_0=60 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    # lat_1 written out: PROJ's CRS path fills a missing lat_1 with 0, its
    # pipeline path with acos(2/pi). See the note in projections.ts.
    '+proj=wintri +lat_1=50.46697 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    '+proj=wintri +lat_1=40 +lon_0=-30 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    '+proj=igh +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    '+proj=igh +lon_0=11 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
]


def grid():
    pts = []
    for lat in range(-88, 89, 4):
        for lon in range(-178, 179, 4):
            pts.append((lon + 0.5, lat + 0.5))   # off the lobe edges and poles
    return pts


NODE_HARNESS = r'''
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
const crs = require('%s');
const proj4 = crs.proj4;
crs.registerProjections();
const jobs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = [];
for (const j of jobs) {
  const t = proj4('EPSG:4326', j.def);
  const xy = [], back = [];
  for (const p of j.points) {
    let f = [NaN, NaN], b = [NaN, NaN];
    try { f = t.forward(p); } catch (e) {}
    try { b = t.inverse([f[0], f[1]]); } catch (e) {}
    xy.push([f[0], f[1]]); back.push([b[0], b[1]]);
  }
  out.push({ def: j.def, xy, back });
}
process.stdout.write(JSON.stringify(out));
'''


def run_node(jobs):
    esbuild = ROOT / 'node_modules' / '.pnpm' / 'node_modules' / '.bin' / 'esbuild'
    if not esbuild.exists():
        esbuild = ROOT / 'node_modules' / '.bin' / 'esbuild'
    entry = ROOT / '.crs-entry.ts'
    entry.write_text("export * from './src/core/crs';\nexport { default as proj4 } from 'proj4';\n")
    bundle = ROOT / '.crs-check.cjs'
    harness = ROOT / '.crs-harness.cjs'
    try:
        subprocess.run([str(esbuild), str(entry), '--bundle', '--format=cjs',
                        '--platform=node', f'--outfile={bundle}', '--log-level=error'],
                       cwd=ROOT, check=True)
        harness.write_text(NODE_HARNESS % bundle)
        res = subprocess.run(['node', str(harness)], input=json.dumps(jobs),
                             capture_output=True, text=True, cwd=ROOT)
    finally:
        for f in (entry, bundle, harness):
            f.unlink(missing_ok=True)
    if res.returncode != 0:
        print(res.stderr[-2000:]); sys.exit(1)
    return json.loads(res.stdout)


def main():
    from pyproj import Transformer
    pts = grid()
    results = run_node([{'def': d, 'points': pts} for d in DEFS])
    failed = False
    for r in results:
        tr = Transformer.from_crs('OGC:CRS84', r['def'], always_xy=True)
        worst_f, worst_i, n_cmp, n_skip, bad_nan = 0.0, 0.0, 0, 0, 0
        for (lon, lat), got, back in zip(pts, r['xy'], r['back']):
            ex, ey = tr.transform(lon, lat)
            if not (math.isfinite(ex) and math.isfinite(ey)):
                n_skip += 1
                continue
            if not (got[0] is not None and math.isfinite(got[0]) and math.isfinite(got[1])):
                worst_f = float('inf'); continue
            n_cmp += 1
            worst_f = max(worst_f, math.hypot(got[0] - ex, got[1] - ey))
            if back[0] is None or not math.isfinite(back[0]):
                bad_nan += 1
                continue
            dlon = abs((back[0] - lon + 180) % 360 - 180)
            worst_i = max(worst_i, dlon, abs(back[1] - lat))
        ok = worst_f <= TOL_FWD_M and worst_i <= TOL_INV_DEG and bad_nan == 0
        failed |= not ok
        name = r['def'].split()[0][6:] + ' ' + r['def'].split()[1]
        print(f"{'ok  ' if ok else 'FAIL'} {name:<22} forward {worst_f:10.5f} m   "
              f"inverse {worst_i:.2e} deg   ({n_cmp} points, {n_skip} outside per PROJ, "
              f"{bad_nan} inverse NaN)")
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
