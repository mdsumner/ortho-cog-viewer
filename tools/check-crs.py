#!/usr/bin/env python3
"""
Check the viewer's CRS definitions against PROJ's own EPSG database.

PROJ (via pyproj) is the oracle. An "engine" is anything that can project
lon/lat with a definition the viewer hands it; proj4js is the built-in one.
Each engine is asked to project the same points twice:

  by code        using "EPSG:NNNN", resolved through crs.ts
  by definition  using the string crs.ts hands out for that code

and both are compared with PROJ. The second is the one that matters for
sharing definitions with another implementation: it is exactly what the warp
engine would be given. If by-code and by-definition disagree, the handoff is
lossy and nothing downstream can be trusted.

  pip install pyproj
  python3 tools/check-crs.py
  python3 tools/check-crs.py --engine 'node tools/proj-wasm-engine.mjs'
  python3 tools/check-crs.py --engine './my-engine'    # see CONTRACT below

The second form drives PROJ itself, in wasm, exactly as the viewer ships it
(pnpm run check-crs). That is the third implementation in play: PROJ resolves
codes the table does not know, proj4js executes for the mesh, and rwarp's
engine executes for the warp.

CONTRACT for an external engine (for example a proj4rs binary, to compare
the wasm warp engine's transforms with these): read a JSON array of jobs on
stdin and write a JSON array of results on stdout.

  in   [{"code": 28355, "def": "+proj=utm +zone=55 +south ...",
         "points": [[lon, lat], ...]}, ...]
  out  [{"code": 28355, "ok": true,
         "xy":    [[x, y], ...],     # projected using the code
         "xyDef": [[x, y], ...]}]    # projected using "def"

The result is read from the LAST line of stdout, so an engine whose workers
chatter on stdout (PROJ's own log lines, from a worker thread) still works
as long as the JSON comes last, on a line of its own.

Angular units are degrees in this contract. proj4rs works in radians
internally, so an engine wrapping it has to convert - which is the sort of
thing this check exists to catch.
"""
import argparse, json, math, pathlib, re, shlex, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src' / 'core' / 'crs.ts'
TOL_M = 5.0          # identity datum shifts cost a metre or two
TOL_EXACT_M = 0.01   # same-datum definitions should be exact
TOL_HANDOFF_M = 1e-6 # by-code vs by-definition: the same numbers or a bug


def codes_from_source():
    text = SRC.read_text()
    named = [int(m) for m in re.findall(r"'EPSG:(\d+)':", text)]
    zoned = []
    for lo, hi, _base in re.findall(r'lo:\s*(\d+),\s*hi:\s*(\d+),\s*base:\s*(\d+)', text):
        zoned.extend(range(int(lo), int(hi) + 1))
    return sorted(set(named)), sorted(set(zoned))


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
            pts.append((round(lon - 360.0 if lon > 180.0 else lon, 6), round(lat, 6)))
    return pts


NODE_HARNESS = r'''
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
  const def = ok ? crs.crsDefinition(code) : null;
  const project = (target) => {
    const t = proj4('EPSG:4326', target);
    return j.points.map((p) => { try { const r = t.forward(p); return [r[0], r[1]]; }
                                 catch (e) { return [NaN, NaN]; } });
  };
  out.push({ code: j.code, ok, def,
             xy: ok ? project(code) : [],
             xyDef: ok && def ? project(def) : [] });
}
process.stdout.write(JSON.stringify(out));
'''


def run_node_engine(jobs):
    """The built-in engine: proj4js, driven through the real crs.ts."""
    esbuild = ROOT / 'node_modules' / '.pnpm' / 'node_modules' / '.bin' / 'esbuild'
    if not esbuild.exists():
        esbuild = ROOT / 'node_modules' / '.bin' / 'esbuild'
    # One entry point so the bundle and the harness share a single proj4
    # instance; two copies would not see each other's registrations.
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
        print(res.stderr[-2000:])
        sys.exit(1)
    return json.loads(res.stdout)


def run_external_engine(command, jobs):
    res = subprocess.run(shlex.split(command), input=json.dumps(jobs),
                         capture_output=True, text=True, cwd=ROOT)
    if res.returncode != 0:
        print(f'engine {command!r} failed:\n{res.stderr[-2000:]}')
        sys.exit(1)
    lines = [l for l in res.stdout.splitlines() if l.strip()]
    if not lines:
        print(f'engine {command!r} wrote nothing to stdout')
        sys.exit(1)
    return json.loads(lines[-1])


def error_m(got, expected, geographic):
    """Distance between two projected points, in metres."""
    if not all(map(math.isfinite, (*got, *expected))):
        return float('inf')
    d = math.hypot(got[0] - expected[0], got[1] - expected[1])
    return d * 111320.0 if geographic else d      # degrees -> metres, roughly


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--engine', default=None,
                    help='external engine command (default: built-in proj4js)')
    args = ap.parse_args()

    from pyproj import CRS, Transformer
    import pyproj

    named, zoned = codes_from_source()
    jobs, meta = [], {}
    for code in sorted(set(named + zoned)):
        try:
            crs = CRS.from_epsg(code)
        except Exception as e:
            print(f'  EPSG:{code}: not in the PROJ database ({e})')
            continue
        pts = sample_points(crs)
        meta[code] = (crs.name, crs.is_geographic, pts)
        jobs.append({'code': code, 'points': pts})

    # crs.ts supplies the definition strings, so the engine is asked for them
    # first and then handed them back: that is the handoff being tested.
    engine = run_node_engine(jobs)
    by_code = {r['code']: r for r in engine}
    if args.engine:
        for j in jobs:
            j['def'] = by_code.get(j['code'], {}).get('def')
        external = {r['code']: r for r in run_external_engine(args.engine, jobs)}
    else:
        external = None

    worst, bad, missing, handoff_bad = [], [], [], []
    for code, (name, geographic, pts) in meta.items():
        r = by_code.get(code)
        if not r or not r['ok']:
            missing.append(f'EPSG:{code} ({name})')
            continue
        tr = Transformer.from_crs('EPSG:4326', f'EPSG:{code}', always_xy=True)
        expected = [tr.transform(lon, lat) for lon, lat in pts]

        err = max(error_m(g, e, geographic) for g, e in zip(r['xy'], expected))
        hand = max(error_m(g, e, geographic) for g, e in zip(r['xyDef'], r['xy'])) \
            if r['xyDef'] else float('inf')
        worst.append((err, code, name))
        if err > TOL_M:
            bad.append((err, code, name))
        if hand > TOL_HANDOFF_M:
            handoff_bad.append((hand, code, name))

    worst.sort(reverse=True)
    print(f'{len(meta)} codes checked against PROJ {pyproj.proj_version_str}')
    print('\nLargest disagreement with PROJ (metres at the sample points):')
    for err, code, name in worst[:10]:
        flag = '  <-- CHECK' if err > TOL_M else ('' if err > TOL_EXACT_M else '  (exact)')
        print(f'  {err:12.4f}  EPSG:{code:<6} {name}{flag}')

    if handoff_bad:
        print(f'\nFAIL: {len(handoff_bad)} code(s) project differently through the definition '
              f'string crs.ts hands out than through the code itself:')
        for err, code, name in handoff_bad[:10]:
            print(f'  {err:12.4f} m  EPSG:{code}  {name}')
    else:
        print(f'\nHandoff: every definition string reproduces its code exactly '
              f'(within {TOL_HANDOFF_M} m), so sharing definitions with another '
              f'implementation loses nothing.')

    if external is not None:
        diffs = []
        for code, (name, geographic, pts) in meta.items():
            r, x = by_code.get(code), external.get(code)
            if not r or not r['ok'] or not x or not x.get('ok'):
                continue
            tr = Transformer.from_crs('EPSG:4326', f'EPSG:{code}', always_xy=True)
            expected = [tr.transform(lon, lat) for lon, lat in pts]
            e_err = max(error_m(g, e, geographic) for g, e in zip(x.get('xyDef') or x['xy'], expected))
            diffs.append((e_err, code, name))
        diffs.sort(reverse=True)
        print(f'\nExternal engine {args.engine!r} against PROJ, worst first:')
        for err, code, name in diffs[:10]:
            print(f'  {err:12.4f}  EPSG:{code:<6} {name}')

    if missing:
        print('\nNot resolved by crs.ts:')
        for m in missing:
            print('  ' + m)
    if bad or handoff_bad:
        sys.exit(1)
    print(f'\nOK: every definition agrees with PROJ to within {TOL_M} m')


if __name__ == '__main__':
    main()
