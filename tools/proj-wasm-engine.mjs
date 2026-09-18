// An engine for tools/check-crs.py: PROJ itself, in wasm, as the viewer
// ships it. Reads jobs on stdin, writes results on stdout (contract at the
// top of check-crs.py). Angles are degrees, lon/lat order.
//
//   python3 tools/check-crs.py --engine 'node tools/proj-wasm-engine.mjs'
//
// Each code is projected twice: through the code as PROJ knows it, and
// through the definition string crs.ts handed out for it. The first checks
// proj-wasm against pyproj (the same library, so it should be exact); the
// second is the handoff: does PROJ executing our string land where PROJ
// executing the code does?
import * as proj from 'proj-wasm';

const jobs = JSON.parse(await new Promise((resolve) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { s += c; });
  process.stdin.on('end', () => resolve(s));
}));

// PROJ's log lines arrive on stdout from the worker thread, where they
// cannot be redirected from here; the JSON goes last, on its own line, and
// check-crs.py reads the last line.
const realLog = console.log;
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');

await proj.init({ size: 1 });
const ctx = await proj.contextCreate({ network: false });
const CRS84 = 'OGC:CRS84';   // WGS84 in lon/lat order, so no axis surprises

async function project(target, points) {
  const t = await proj.projCreateCrsToCrs({ context: ctx, source_crs: CRS84, target_crs: target });
  const ca = await proj.coordArray(points.length);
  await proj.setCoords(ca, points.map(([lon, lat]) => [lon, lat, 0, 0]));
  await proj.projTransArray({ p: t, direction: proj.PJ_FWD, n: points.length, coord: ca });
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const c = await proj.getCoords(ca, i);
    out.push([c[0], c[1]]);
  }
  return out;
}

const out = [];
for (const j of jobs) {
  const code = 'EPSG:' + j.code;
  const r = { code: j.code, ok: false, xy: [], xyDef: [] };
  try {
    r.xy = await project(code, j.points);
    r.ok = true;
    if (j.def) r.xyDef = await project(j.def, j.points);
  } catch (err) {
    process.stderr.write(`${code}: ${String(err).split('\n')[0]}\n`);
  }
  out.push(r);
}
await proj.shutdown();
realLog('\n' + JSON.stringify(out));
