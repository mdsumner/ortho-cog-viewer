/**
 * PROJ itself, in wasm, as the definition provider of last resort.
 *
 * proj-wasm (Will Cohen's build of PROJ 9 for the JS ecosystem) carries the
 * real EPSG database, so it can say what any code means without anyone
 * transcribing a definition by hand. It is also 15 MB and spawns workers, so
 * it is not part of the page: tools/bundle-proj-wasm.mjs lays it out flat in
 * public/proj-wasm/, and this module imports it from there by URL the first
 * time a CRS misses the table, zone arithmetic and proj4js's own list. A
 * session that never hits an unknown code never pays for it.
 *
 * What comes back is a PROJ.4 string, which proj4js executes for the mesh
 * and crsDefinition() hands on unchanged to any other engine. PROJ resolves;
 * proj4js (and rwarp) execute. One authority.
 */
import type { DefinitionProvider } from './crs';

interface CoordArray { buffer: Float64Array; numCoords: number; }

interface ProjModule {
  init(opts?: Record<string, unknown>): Promise<unknown>;
  contextCreate(opts?: { network?: boolean }): Promise<unknown>;
  projCreate(opts: { context: unknown; definition: string }): Promise<unknown>;
  projCreateCrsToCrs(opts: { context: unknown; source_crs: string; target_crs: string }): Promise<unknown>;
  projAsProjString(opts: { context: unknown; pj: unknown; type: number }): Promise<string>;
  coordArray(n: number): Promise<CoordArray>;
  projTransArray(opts: { p: unknown; direction: number; n: number; coord: CoordArray }): Promise<unknown>;
  PJ_PROJ_4: number;
  PJ_FWD: number;
  PJ_INV: number;
}

interface Engine {
  mod: ProjModule;
  ctx: unknown;
  /** crs-to-crs transformers from lon/lat (CRS84) to a definition, by definition */
  transformers: Map<string, Promise<unknown>>;
}

let engine: Promise<Engine> | null = null;

let configuredBase: string | null = null;

/**
 * Where the bundled folder lives. On the main thread it defaults to
 * proj-wasm/ next to the page; a worker has no page, so whoever spawns it
 * says (a worker's own location is its script, not the site).
 */
export function setProjWasmBase(url: string): void {
  configuredBase = url;
  engine = null;
}

function folderURL(): string {
  if (configuredBase) return configuredBase;
  if (typeof document !== 'undefined') return new URL('proj-wasm/', document.baseURI).href;
  throw new Error('proj-wasm folder not configured: call setProjWasmBase() in a worker');
}

async function load(): Promise<Engine> {
  const base = folderURL();
  const t0 = performance.now();
  // Loaded by URL on purpose: the folder is served as-is, outside the bundle.
  const mod = (await import(/* @vite-ignore */ base + 'proj.mjs')) as ProjModule;
  await mod.init({ bootstrap: base + 'worker-bootstrap.mjs', size: 1 });
  const ctx = await mod.contextCreate({ network: false });
  console.log(`PROJ (wasm) ready in ${Math.round(performance.now() - t0)} ms`);
  return { mod, ctx, transformers: new Map() };
}

/** Is PROJ loaded (or loading)? Nothing here triggers the download. */
export function projWasmStarted(): boolean {
  return engine !== null;
}

async function ready(): Promise<Engine> {
  if (!engine) engine = load();
  return engine;
}

/**
 * PROJ's own idea of a CRS for a definition string: a bare +proj string is
 * an operation to proj_create_crs_to_crs unless it says +type=crs.
 */
function asCRS(def: string): string {
  const d = def.trim();
  return d.startsWith('+') && !/\+type=crs\b/.test(d) ? d + ' +type=crs' : d;
}

async function transformerFor(e: Engine, def: string): Promise<unknown> {
  let t = e.transformers.get(def);
  if (!t) {
    t = e.mod.projCreateCrsToCrs({ context: e.ctx, source_crs: 'OGC:CRS84', target_crs: asCRS(def) });
    e.transformers.set(def, t);
  }
  return t;
}

/**
 * Transform a batch of points between lon/lat (degrees) and a CRS given by
 * its definition string, in PROJ. xy is interleaved [x0, y0, x1, y1, ...]
 * and the result has the same layout; points PROJ cannot transform come
 * back NaN rather than throwing. One worker round trip for the whole batch.
 */
export async function projTransformBatch(def: string, xy: Float64Array, direction: 'fromGeo' | 'toGeo'): Promise<Float64Array> {
  const e = await ready();
  const n = xy.length / 2;
  const out = new Float64Array(xy.length);
  if (n === 0) return out;
  const t = await transformerFor(e, def);
  const ca = await e.mod.coordArray(n);
  const b = ca.buffer;
  for (let i = 0; i < n; i++) {
    b[i * 4] = xy[i * 2];
    b[i * 4 + 1] = xy[i * 2 + 1];
    b[i * 4 + 2] = 0;
    b[i * 4 + 3] = 0;
  }
  await e.mod.projTransArray({ p: t, direction: direction === 'fromGeo' ? e.mod.PJ_FWD : e.mod.PJ_INV, n, coord: ca });
  for (let i = 0; i < n; i++) {
    const x = b[i * 4], y = b[i * 4 + 1];
    // PROJ marks failures with HUGE_VAL
    out[i * 2] = Math.abs(x) > 1e300 ? NaN : x;
    out[i * 2 + 1] = Math.abs(y) > 1e300 ? NaN : y;
  }
  return out;
}

/**
 * The provider. Resolution failures (a code PROJ does not know) return null;
 * a failure to load PROJ at all is remembered so the page does not retry the
 * download for every subsequent miss.
 */
export const projWasmProvider: DefinitionProvider = async (code) => {
  let e: Engine;
  try {
    e = await ready();
  } catch (err) {
    console.warn('PROJ (wasm) could not be loaded; falling back to epsg.io:', err);
    return null;
  }
  try {
    const pj = await e.mod.projCreate({ context: e.ctx, definition: code });
    const s = await e.mod.projAsProjString({ context: e.ctx, pj, type: e.mod.PJ_PROJ_4 });
    // "+type=crs" is PROJ's marker that the string denotes a CRS rather than
    // an operation; proj4js accepts it, but it means nothing to the others.
    return s.replace(/\s*\+type=crs\b/, '').trim() || null;
  } catch (err) {
    console.log(`PROJ (wasm) does not know ${code}:`, (err as Error).message?.split('\n')[0]);
    return null;
  }
};
