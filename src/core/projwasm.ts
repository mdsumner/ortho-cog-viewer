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

interface ProjModule {
  init(opts?: Record<string, unknown>): Promise<unknown>;
  contextCreate(opts?: { network?: boolean }): Promise<unknown>;
  projCreate(opts: { context: unknown; definition: string }): Promise<unknown>;
  projAsProjString(opts: { context: unknown; pj: unknown; type: number }): Promise<string>;
  PJ_PROJ_4: number;
}

interface Engine {
  mod: ProjModule;
  ctx: unknown;
}

let engine: Promise<Engine> | null = null;

/** Where the bundled folder lives, relative to the page. */
function folderURL(): string {
  return new URL('proj-wasm/', document.baseURI).href;
}

async function load(): Promise<Engine> {
  const base = folderURL();
  const t0 = performance.now();
  // Loaded by URL on purpose: the folder is served as-is, outside the bundle.
  const mod = (await import(/* @vite-ignore */ base + 'proj.mjs')) as ProjModule;
  await mod.init({ bootstrap: base + 'worker-bootstrap.mjs', size: 1 });
  const ctx = await mod.contextCreate({ network: false });
  console.log(`PROJ (wasm) ready in ${Math.round(performance.now() - t0)} ms`);
  return { mod, ctx };
}

/**
 * The provider. Resolution failures (a code PROJ does not know) return null;
 * a failure to load PROJ at all is remembered so the page does not retry the
 * download for every subsequent miss.
 */
export const projWasmProvider: DefinitionProvider = async (code) => {
  if (!engine) {
    engine = load().catch((err) => {
      console.warn('PROJ (wasm) could not be loaded; falling back to epsg.io:', err);
      throw err;
    });
  }
  let e: Engine;
  try {
    e = await engine;
  } catch {
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
