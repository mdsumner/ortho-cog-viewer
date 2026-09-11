#!/usr/bin/env python3
"""
Check src/crs.ts definitions against PROJ's EPSG database.

Bundles the real crs.ts with esbuild, drives it from node to project sample
points with proj4js, and compares with pyproj over the same points. Sample
points come from each CRS's own area of use, so every definition is exercised
where it is meant to be used.

  pip install pyproj && python3 tools/check-crs.py
"""
import json, re, subprocess, sys, math, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src' / 'crs.ts'
TOL_M = 5.0          # identity datum shifts cost a metre or two
TOL_EXACT_M = 0.01   # same-datum definitions should be exact

def codes_from_source():
    text = SRC.read_text()
    named = [int(m) for m in re.findall(r"'EPSG:(\d+)':", text)]
    families = []
    for lo, hi, base in re.findall(r'lo:\s*(\d+),\s*hi:\s*(\d+),\s*base:\s*(\d+)', text):
        families.append((int(lo), int(hi), int(base)))
    zoned = []
    for lo, hi, _base in families:
        zoned.extend(range(lo, hi + 1))
    return sorted(set(named)), sorted(set(zoned)), families

def sample_points(crs):
    """A few lon/lat points inside the CRS's area of use."""
    a = crs.area_of_use
    if a is None:
        return [(0.0, 0.0)]
    w, s, e, n = a.west, a.south, a.east, a.north
    if e < w:      # crosses the antimeridian
        e += 360.0
    pts = []
    for fx in (0.25, 0.5, 0.75):
        for fy in (0.25, 0.5, 0.75):
            lon = w + (e - w) * fx
            lat = s + (n - s) * fy
            if lon > 180.0:
                lon -= 360.0
            pts.append((round(lon, 6), round(lat, 6)))
    return pts

def main():
    from pyproj import CRS, Transformer

    named, zoned, families = codes_from_source()
    all_codes = sorted(set(named + zoned))

    jobs = []
    for code in all_codes:
        try:
            crs = CRS.from_epsg(code)
        except Exception as e:
            print(f'  EPSG:{code}: not in the PROJ database ({e})')
            continue
        jobs.append({'code': code, 'name': crs.name,
                     'geographic': crs.is_geographic,
                     'points': sample_points(crs)})

    # proj4js side, through the actual crs.ts
    # One entry point so the bundle and the harness share a single proj4
    # instance; two copies would not see each other's registrations.
    entry = ROOT / '.crs-entry.ts'
    entry.write_text("export * from './src/crs';\nexport { default as proj4 } from 'proj4';\n")
    bundle = str(ROOT / '.crs-check.cjs')
    esbuild = ROOT / 'node_modules' / '.pnpm' / 'node_modules' / '.bin' / 'esbuild'
    if not esbuild.exists():
        esbuild = 'npx esbuild'.split()[-1]   # fall back to a global install
    subprocess.run([str(esbuild), str(entry), '--bundle', '--format=cjs',
                    '--platform=node', f'--outfile={bundle}', '--log-level=error'],
                   cwd=ROOT, check=True)
    harness = r'''
// crs.ts logs when it synthesises a definition; keep stdout pure JSON.
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
const crs = require('%s');
const proj4 = crs.proj4;
crs.registerProjections();
const jobs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = [];
for (const j of jobs) {
  const code = 'EPSG:' + j.code;
  const ok = crs.ensureCRS(code);
  const xy = [];
  if (ok) {
    const t = proj4('EPSG:4326', code);
    for (const p of j.points) {
      try { const r = t.forward(p); xy.push([r[0], r[1]]); }
      catch (e) { xy.push([NaN, NaN]); }
    }
  }
  out.push({ code: j.code, ok, xy, def: ok ? JSON.stringify(proj4.defs(code)) : null });
}
process.stdout.write(JSON.stringify(out));
''' % bundle
    harness_path = ROOT / '.crs-harness.cjs'
    harness_path.write_text(harness)
    try:
        res = subprocess.run(['node', str(harness_path)], input=json.dumps(jobs),
                             capture_output=True, text=True, cwd=ROOT)
    finally:
        harness_path.unlink(missing_ok=True)
        pathlib.Path(bundle).unlink(missing_ok=True)
        entry.unlink(missing_ok=True)
    if res.returncode != 0:
        print(res.stderr[-2000:]); sys.exit(1)
    js = {r['code']: r for r in json.loads(res.stdout)}

    bad, missing, worst = [], [], []
    for j in jobs:
        r = js.get(j['code'])
        if not r or not r['ok']:
            missing.append(f"EPSG:{j['code']} ({j['name']})")
            continue
        tr = Transformer.from_crs('EPSG:4326', f"EPSG:{j['code']}", always_xy=True)
        err = 0.0
        for (lon, lat), got in zip(j['points'], r['xy']):
            ex, ey = tr.transform(lon, lat)
            if not all(map(math.isfinite, (ex, ey, got[0], got[1]))):
                err = float('inf'); break
            d = math.hypot(got[0] - ex, got[1] - ey)
            if j['geographic']:
                d *= 111320.0     # degrees -> metres, roughly
            err = max(err, d)
        worst.append((err, j['code'], j['name']))
        if err > TOL_M:
            bad.append((err, j['code'], j['name']))

    worst.sort(reverse=True)
    print(f'{len(jobs)} codes checked against PROJ {__import__("pyproj").proj_version_str}')
    print('\nLargest disagreement (metres at the sample points):')
    for err, code, name in worst[:12]:
        flag = '  <-- CHECK' if err > TOL_M else ('' if err > TOL_EXACT_M else '  (exact)')
        print(f'  {err:12.4f}  EPSG:{code:<6} {name}{flag}')
    if missing:
        print('\nNot resolved by crs.ts:')
        for m in missing:
            print('  ' + m)
    if bad:
        print(f'\nFAIL: {len(bad)} definition(s) disagree with PROJ by more than {TOL_M} m')
        sys.exit(1)
    print(f'\nOK: every definition agrees with PROJ to within {TOL_M} m')

if __name__ == '__main__':
    main()
