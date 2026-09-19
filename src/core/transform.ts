/**
 * Display <-> lon/lat, by whichever executor can do it.
 *
 * proj4js runs synchronously on the calling thread and covers most of what
 * anyone types; PROJ in wasm covers everything else at the cost of a worker
 * round trip per batch (a few milliseconds for a mesh's worth of points).
 * Code that transforms points asks for a GeoTransform and uses the batch
 * methods, which are async in both cases; when it must be synchronous (the
 * per-frame hot path), it checks `executor` and takes the sync methods,
 * which exist only for proj4js.
 *
 * Only the display side is handled here: a source CRS still has to be
 * something proj4js executes, since UVs are computed per vertex on the
 * main thread and a source in an exotic CRS is rare in practice.
 */
import proj4 from 'proj4';
import { Executor, executorFor, crsDefinition } from './crs';
import { projTransformBatch } from './projwasm';

export interface GeoTransform {
  readonly crs: string;
  readonly executor: Executor;
  /** display -> lon/lat in degrees, interleaved [x0,y0,x1,y1,...] in, same out; NaN for failures */
  toGeo(xy: Float64Array): Promise<Float64Array>;
  /** lon/lat -> display, same layout */
  fromGeo(ll: Float64Array): Promise<Float64Array>;
  /** Synchronous forms; only present when executor is proj4js. */
  toGeoSync?(xy: Float64Array): Float64Array;
  fromGeoSync?(ll: Float64Array): Float64Array;
}

function runProj4(t: { forward(p: number[]): number[] }, xy: Float64Array): Float64Array {
  const out = new Float64Array(xy.length);
  for (let i = 0; i < xy.length; i += 2) {
    try {
      const r = t.forward([xy[i], xy[i + 1]]);
      out[i] = isFinite(r[0]) ? r[0] : NaN;
      out[i + 1] = isFinite(r[1]) ? r[1] : NaN;
    } catch {
      out[i] = NaN;
      out[i + 1] = NaN;
    }
  }
  return out;
}

const cache = new Map<string, GeoTransform>();

/**
 * proj4js returns NaN from several projections (laea among them) when a
 * +proj string has no +x_0 / +y_0, because it reads undefined false
 * origins as numbers. PROJ treats them as zero. Give proj4js the zeros;
 * crsDefinition() still hands out the string as given.
 */
export function forProj4js(crs: string): string {
  if (!crs.startsWith('+')) return crs;
  let s = crs;
  if (!/\+x_0=/.test(s)) s += ' +x_0=0';
  if (!/\+y_0=/.test(s)) s += ' +y_0=0';
  return s;
}

export function geoTransform(crs: string): GeoTransform {
  const key = crs.trim();
  const hit = cache.get(key);
  if (hit) return hit;
  let g: GeoTransform;
  if (executorFor(key) === 'proj') {
    const def = crsDefinition(key) ?? key;
    g = {
      crs: key,
      executor: 'proj',
      toGeo: (xy) => projTransformBatch(def, xy, 'toGeo'),
      fromGeo: (ll) => projTransformBatch(def, ll, 'fromGeo')
    };
  } else {
    const p4 = forProj4js(key);
    const inv = proj4(p4, 'EPSG:4326');
    const fwd = proj4('EPSG:4326', p4);
    const toGeoSync = (xy: Float64Array) => runProj4(inv, xy);
    const fromGeoSync = (ll: Float64Array) => runProj4(fwd, ll);
    g = {
      crs: key,
      executor: 'proj4js',
      toGeo: async (xy) => toGeoSync(xy),
      fromGeo: async (ll) => fromGeoSync(ll),
      toGeoSync,
      fromGeoSync
    };
  }
  // Cache only the PROJ ones: proj4js transforms are cheap to make and a
  // centred template produces a new CRS string every pan.
  if (g.executor === 'proj') cache.set(key, g);
  return g;
}

/** Convenience for one point. */
export async function toGeoPoint(g: GeoTransform, x: number, y: number): Promise<[number, number]> {
  const r = await g.toGeo(new Float64Array([x, y]));
  return [r[0], r[1]];
}
export async function fromGeoPoint(g: GeoTransform, lon: number, lat: number): Promise<[number, number]> {
  const r = await g.fromGeo(new Float64Array([lon, lat]));
  return [r[0], r[1]];
}
