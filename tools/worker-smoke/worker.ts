// A Web Worker that exercises core/ with no DOM in sight: opens a COG and a
// tile pyramid, fetches a window from each, resolves a CRS, and reports.
// Bundled by tools/check-worker-core.mjs and run in a real browser.
import { COGSource } from '../../src/core/cogSource';
import { XYZSource } from '../../src/core/xyzSource';
import { registerProjections, resolveCRS, crsDefinition, setDefinitionProvider } from '../../src/core/crs';
import { projWasmProvider, setProjWasmBase } from '../../src/core/projwasm';
import { detectWrap } from '../../src/core/wrap';
import { buildGraticule } from '../../src/core/graticule';

interface Job { cog: string; tiles: string; projWasmBase: string; }

self.onmessage = async (e: MessageEvent<Job>) => {
  const out: Record<string, unknown> = {};
  try {
    registerProjections();
    setProjWasmBase(e.data.projWasmBase);
    setDefinitionProvider(projWasmProvider);

    const cog = await COGSource.open(e.data.cog);
    const lvl = cog.levels[cog.levels.length - 1];
    const tex = await cog.fetch(lvl.index, cog.bounds, 512);
    out.cog = { crs: cog.crs, numeric: cog.numeric,
      rgba: tex.rgba ? [tex.rgba.width, tex.rgba.height, tex.rgba.data.length] : null,
      float: tex.float ? [tex.float.width, tex.float.height] : null };

    const xyz = XYZSource.fromTemplate(e.data.tiles);
    const t2 = await xyz.fetch(2, xyz.bounds, 1024);
    out.xyz = { crs: xyz.crs, rgba: t2.rgba ? [t2.rgba.width, t2.rgba.height] : null,
      nonZero: t2.rgba ? Array.from(t2.rgba.data).some(v => v !== 0) : false };

    out.crs = { known: await resolveCRS('EPSG:28355'), def: crsDefinition('EPSG:28355'),
      unknownViaProj: await resolveCRS('EPSG:31287'), def31287: crsDefinition('EPSG:31287') };
    out.wrap = detectWrap('+proj=moll +lon_0=0 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs');
    out.graticule = buildGraticule('EPSG:3031', { tolerance: 100 }).minor.length;
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.error = String((err as Error).stack ?? err);
  }
  (self as unknown as Worker).postMessage(out);
};
