/**
 * Warping: a real resample of a source raster onto the display grid.
 *
 * The mesh engine never resamples; it lets the GPU interpolate a texture
 * across triangles whose corners were placed exactly. A warp does what
 * gdalwarp does: for every destination pixel, find the source pixel and
 * resample. Exact, and the output is a raster in the display CRS that could
 * be written out - at the cost of work per view change rather than per
 * pan. The two engines share everything above this interface.
 *
 * Two backends implement it:
 *
 *   rwarp       Michael Sumner's GDAL-warp-pipeline in Rust, built to wasm
 *               (hypertidy/rwarp, rwarp-wasm). Approximate transformer,
 *               nearest / bilinear / cubic / lanczos kernels, values or RGBA.
 *               Its CRS backend is proj4rs, so it parses a subset of what
 *               proj4js or PROJ do; it says so, and the reference takes over.
 *   reference   Plain JavaScript: every destination pixel inverse-projected
 *               through the viewer's own GeoTransform, nearest neighbour.
 *               Slow and simple. It runs on every CRS the viewer can
 *               execute, and it is the oracle rwarp is checked against.
 *
 * Both are handed CRSs as the definition strings crsDefinition() gives out,
 * never codes. Geotransforms are GDAL order [x0, dx, rx, y0, ry, dy].
 */
import proj4 from 'proj4';
import { geoTransform, forProj4js } from './transform';

export type ResampleAlg = 'nearest' | 'bilinear' | 'cubic' | 'lanczos';
/**
 * rwarp+proj4js is rwarp's kernels with the page's proj4js doing the
 * projecting (Warper.withTransforms), for CRSs proj4rs does not parse.
 */
export type WarpBackendName = 'rwarp' | 'rwarp+proj4js' | 'reference';

export interface WarpJob {
  srcCrs: string;
  srcGt: Float64Array;
  srcW: number;
  srcH: number;
  dstCrs: string;
  dstGt: Float64Array;
  dstW: number;
  dstH: number;
  alg: ResampleAlg;
  /**
   * Approximate-transformer threshold in source pixels (GDAL's default is
   * 0.125); 0 transforms every pixel exactly, several times slower.
   */
  maxError?: number;
  /** exactly one of these */
  rgba?: Uint8ClampedArray | Uint8Array;
  float?: Float32Array;
  nodata: number | null;
}

export interface WarpResult {
  backend: WarpBackendName;
  ms: number;
  rgba?: Uint8ClampedArray;
  float?: Float32Array;
}

export interface WarpBackend {
  readonly name: WarpBackendName;
  /** Can this backend take the CRS pair? A reason when not. */
  accepts(srcCrs: string, dstCrs: string): Promise<string | null>;
  warp(job: WarpJob): Promise<WarpResult>;
}

// ---------------------------------------------------------------------------
// rwarp

interface RwarpWarper {
  warp_rgba(src: Uint8Array, w: number, h: number, xoff: number, yoff: number, dstW: number, dstH: number, alg: string): Uint8Array;
  warp_f32(src: Float32Array, w: number, h: number, xoff: number, yoff: number, dstW: number, dstH: number, nodata: number, alg: string): Float32Array;
  free(): void;
}
type PointFn = (x: number, y: number, out: Float64Array) => boolean;
interface RwarpModule {
  default(input?: unknown): Promise<unknown>;
  Warper: (new (srcCrs: string, srcGt: Float64Array, dstCrs: string, dstGt: Float64Array, maxError: number) => RwarpWarper) & {
    /** Present from rwarp-wasm 0.1.1: CRS transforms as JavaScript functions. */
    withTransforms?(srcGt: Float64Array, dstGt: Float64Array, dstToSrc: PointFn, srcToDst: PointFn, maxError: number): RwarpWarper;
  };
}

/**
 * proj4js as a pair of point functions for Warper.withTransforms, or null
 * if proj4js cannot execute either CRS. Synchronous by necessity: the
 * callback happens inside rwarp's transform loop. That is why PROJ-only
 * CRSs cannot take this route yet - PROJ in wasm answers asynchronously.
 */
function proj4jsPointFns(srcCrs: string, dstCrs: string): [PointFn, PointFn] | null {
  let d2s: { forward(p: number[]): number[] }, s2d: { forward(p: number[]): number[] };
  try {
    const s = forProj4js(srcCrs), d = forProj4js(dstCrs);
    d2s = proj4(d, s);
    s2d = proj4(s, d);
  } catch {
    return null;
  }
  const call = (t: { forward(p: number[]): number[] }): PointFn => (x, y, out) => {
    try {
      const r = t.forward([x, y]);
      out[0] = r[0];
      out[1] = r[1];
      return isFinite(r[0]) && isFinite(r[1]);
    } catch {
      return false;
    }
  };
  return [call(d2s), call(s2d)];
}



/**
 * Load rwarp from a folder served flat (rwarp_wasm.js beside its wasm),
 * the same arrangement as proj-wasm. The URL is given because a worker's
 * own location is its script, not the site.
 */
export async function loadRwarp(folderURL: string): Promise<WarpBackend> {
  const mod = (await import(/* @vite-ignore */ folderURL + 'rwarp_wasm.js')) as RwarpModule;
  await mod.default({ module_or_path: folderURL + 'rwarp_wasm_bg.wasm' });
  return rwarpBackend(mod);
}

export function rwarpBackend(mod: RwarpModule): WarpBackend {
  const unit = new Float64Array([0, 1, 0, 0, 0, -1]);
  // Which route a CRS pair takes, remembered per pair.
  const routes = new Map<string, 'proj4rs' | 'proj4js' | string>();
  const route = (srcCrs: string, dstCrs: string): 'proj4rs' | 'proj4js' | string => {
    const key = srcCrs + '\u0000' + dstCrs;
    const hit = routes.get(key);
    if (hit) return hit;
    let r: string;
    try {
      new mod.Warper(srcCrs, unit, dstCrs, unit, 0.125).free();
      r = 'proj4rs';
    } catch (err) {
      const m = String((err as Error).message ?? err);
      const why = m.length > 160 ? m.slice(0, 157) + '...' : m;
      // proj4rs declined: can proj4js do the projecting for rwarp?
      r = mod.Warper.withTransforms && proj4jsPointFns(srcCrs, dstCrs) ? 'proj4js' : why;
    }
    routes.set(key, r);
    return r;
  };
  const build = (job: WarpJob): { w: RwarpWarper; name: WarpBackendName } => {
    const r = route(job.srcCrs, job.dstCrs);
    if (r === 'proj4rs') {
      return { w: new mod.Warper(job.srcCrs, job.srcGt, job.dstCrs, job.dstGt, job.maxError ?? 0.125), name: 'rwarp' };
    }
    if (r === 'proj4js') {
      const [d2s, s2d] = proj4jsPointFns(job.srcCrs, job.dstCrs)!;
      return { w: mod.Warper.withTransforms!(job.srcGt, job.dstGt, d2s, s2d, job.maxError ?? 0.125), name: 'rwarp+proj4js' };
    }
    throw new Error(r);
  };
  return {
    name: 'rwarp',
    async accepts(srcCrs, dstCrs) {
      const r = route(srcCrs, dstCrs);
      return r === 'proj4rs' || r === 'proj4js' ? null : r;
    },
    async warp(job) {
      const t0 = performance.now();
      const { w, name } = build(job);
      try {
        if (job.float) {
          const out = w.warp_f32(job.float, job.srcW, job.srcH, 0, 0, job.dstW, job.dstH,
            job.nodata === null ? NaN : job.nodata, job.alg);
          return { backend: name, ms: performance.now() - t0, float: out };
        }
        const src = job.rgba instanceof Uint8Array ? job.rgba : new Uint8Array(job.rgba!.buffer, job.rgba!.byteOffset, job.rgba!.byteLength);
        const out = w.warp_rgba(src, job.srcW, job.srcH, 0, 0, job.dstW, job.dstH, job.alg);
        return { backend: name, ms: performance.now() - t0, rgba: new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength) };
      } finally {
        w.free();
      }
    }
  };
}

// ---------------------------------------------------------------------------
// reference

export const referenceBackend: WarpBackend = {
  name: 'reference',
  async accepts(srcCrs, dstCrs) {
    try {
      proj4('EPSG:4326', srcCrs);
    } catch {
      return `reference warp: proj4js cannot execute the source CRS`;
    }
    try {
      geoTransform(dstCrs);
      return null;
    } catch (err) {
      return `reference warp: ${String((err as Error).message ?? err)}`;
    }
  },
  async warp(job) {
    const t0 = performance.now();
    const { dstW: W, dstH: H, dstGt: d, srcGt: s, srcW, srcH } = job;
    // Destination pixel centres in display space, one batch to lon/lat.
    const xy = new Float64Array(W * H * 2);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = (r * W + c) * 2;
        xy[i] = d[0] + (c + 0.5) * d[1] + (r + 0.5) * d[2];
        xy[i + 1] = d[3] + (c + 0.5) * d[4] + (r + 0.5) * d[5];
      }
    }
    const geo = geoTransform(job.dstCrs);
    const ll = await geo.toGeo(xy);
    // Round trip, as the mesh does: an inverse that does not come home is a
    // point off the map (beyond a horizon, outside an ellipse) that the
    // projection clamped or guessed rather than refused.
    const back = await geo.fromGeo(ll);
    const tol2 = d[1] * d[1];   // one destination pixel
    const toSrc = proj4('EPSG:4326', job.srcCrs);
    // Source is axis-aligned (rx = ry = 0), as everything the viewer fetches is.
    const inv = (sx: number, sy: number): [number, number] =>
      [(sx - s[0]) / s[1], (sy - s[3]) / s[5]];
    const n = W * H;
    let rgba: Uint8ClampedArray | undefined;
    let float: Float32Array | undefined;
    if (job.float) {
      float = new Float32Array(n).fill(job.nodata === null ? NaN : job.nodata);
    } else {
      rgba = new Uint8ClampedArray(n * 4);
    }
    for (let i = 0; i < n; i++) {
      const lon = ll[i * 2], lat = ll[i * 2 + 1];
      if (!isFinite(lon) || !isFinite(lat)) continue;
      const ex = back[i * 2] - xy[i * 2], ey = back[i * 2 + 1] - xy[i * 2 + 1];
      if (!(ex * ex + ey * ey <= tol2)) continue;
      let sx: number, sy: number;
      try {
        [sx, sy] = toSrc.forward([lon, lat]);
      } catch {
        continue;
      }
      if (!isFinite(sx) || !isFinite(sy)) continue;
      const [pc, pr] = inv(sx, sy);
      const c = Math.floor(pc), r = Math.floor(pr);
      if (c < 0 || r < 0 || c >= srcW || r >= srcH) continue;
      const si = r * srcW + c;
      if (float) {
        float[i] = job.float![si];
      } else {
        const src = job.rgba!;
        rgba![i * 4] = src[si * 4];
        rgba![i * 4 + 1] = src[si * 4 + 1];
        rgba![i * 4 + 2] = src[si * 4 + 2];
        rgba![i * 4 + 3] = src[si * 4 + 3];
      }
    }
    return { backend: 'reference', ms: performance.now() - t0, rgba, float };
  }
};
