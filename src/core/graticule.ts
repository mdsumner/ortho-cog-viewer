/**
 * Graticule: lon/lat lines projected into the current display CRS.
 *
 * Built on the CPU each time the display CRS changes (every frame in centred
 * mode). Lines are sampled densely in lon/lat, every sample is validated
 * with the same round-trip test the mesh uses, and any segment that is
 * wildly longer than its neighbours (a projection cut, e.g. the antimeridian
 * in Mercator or omerc) is dropped rather than drawn across the map.
 *
 * All the samples go through the display transform as one batch, so the
 * same code runs on proj4js (synchronously) and on PROJ in wasm (one worker
 * round trip each way).
 */

import { WrapSpec } from './wrap';
import { GeoTransform, geoTransform } from './transform';

export interface GraticuleGeometry {
  /** xyz pairs for gl.LINES */
  minor: Float32Array;
  /** equator and prime meridian, drawn brighter */
  major: Float32Array;
}

export interface GraticuleOptions {
  stepDeg?: number;     // spacing between lines
  sampleDeg?: number;   // spacing between samples along a line
  tolerance?: number;   // round-trip tolerance in display units
  /** Repeat the lines for copies kMin..kMax of the world along wrap. */
  wrap?: WrapSpec | null;
  kMin?: number;
  kMax?: number;
}

interface Line { start: number; count: number; major: boolean; }

/** Every sample of every line, in one array, with where each line starts. */
function sampleLines(step: number, sample: number): { lonlat: Float64Array; lines: Line[] } {
  const pts: number[] = [];
  const lines: Line[] = [];
  for (let lon = -180; lon < 180; lon += step) {
    const start = pts.length / 2;
    for (let lat = -90; lat <= 90 + 1e-9; lat += sample) {
      pts.push(lon, Math.min(90, lat));
    }
    lines.push({ start, count: pts.length / 2 - start, major: lon === 0 });
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const start = pts.length / 2;
    for (let lon = -180; lon <= 180 + 1e-9; lon += sample) {
      pts.push(Math.min(180, lon), lat);
    }
    lines.push({ start, count: pts.length / 2 - start, major: lat === 0 });
  }
  return { lonlat: Float64Array.from(pts), lines };
}

function assemble(
  lines: Line[],
  xy: Float64Array,
  back: Float64Array,
  opts: GraticuleOptions
): GraticuleGeometry {
  const tol = opts.tolerance ?? 1;
  const tol2 = tol * tol;
  const minor: number[] = [];
  const major: number[] = [];

  // A sample survives if it projected and its round trip came home.
  const ok = (i: number): boolean => {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (!isFinite(x) || !isFinite(y)) return false;
    const ex = back[i * 2] - x, ey = back[i * 2 + 1] - y;
    return isFinite(ex) && isFinite(ey) && ex * ex + ey * ey <= tol2;
  };

  for (const line of lines) {
    const segs: number[][] = [];
    const lens: number[] = [];
    for (let i = line.start + 1; i < line.start + line.count; i++) {
      if (!ok(i - 1) || !ok(i)) continue;
      const ax = xy[(i - 1) * 2], ay = xy[(i - 1) * 2 + 1];
      const bx = xy[i * 2], by = xy[i * 2 + 1];
      segs.push([ax, ay, bx, by]);
      lens.push(Math.hypot(bx - ax, by - ay));
    }
    if (segs.length === 0) continue;
    const sorted = [...lens].sort((p, q) => p - q);
    const median = sorted[Math.floor(sorted.length / 2)];
    const limit = median * 8;
    const out = line.major ? major : minor;
    for (let i = 0; i < segs.length; i++) {
      if (lens[i] > limit) continue;  // a cut
      const s = segs[i];
      out.push(s[0], s[1], 0, s[2], s[3], 0);
    }
  }

  const w = opts.wrap;
  const kMin = opts.kMin ?? 0, kMax = opts.kMax ?? 0;
  if (w && kMin <= kMax && !(kMin === 0 && kMax === 0)) {
    const copies = (src: number[]): Float32Array => {
      const out = new Float32Array(src.length * (kMax - kMin + 1));
      let n = 0;
      for (let k = kMin; k <= kMax; k++) {
        for (let i = 0; i < src.length; i += 3) {
          out[n++] = src[i] + k * w.tx;
          out[n++] = src[i + 1] + k * w.ty;
          out[n++] = src[i + 2];
        }
      }
      return out;
    };
    return { minor: copies(minor), major: copies(major) };
  }
  return { minor: new Float32Array(minor), major: new Float32Array(major) };
}

/** Synchronous: the display CRS must be one proj4js executes. */
export function buildGraticule(displayCRS: string, opts: GraticuleOptions = {}): GraticuleGeometry {
  const geo = geoTransform(displayCRS);
  if (!geo.fromGeoSync || !geo.toGeoSync) {
    throw new Error(`${displayCRS} needs the PROJ executor; use buildGraticuleAsync`);
  }
  const { lonlat, lines } = sampleLines(opts.stepDeg ?? 10, opts.sampleDeg ?? 1);
  const xy = geo.fromGeoSync(lonlat);
  const back = geo.fromGeoSync(geo.toGeoSync(xy));
  return assemble(lines, xy, back, opts);
}

/** Any executor: three batches through the display transform. */
export async function buildGraticuleAsync(geo: GeoTransform, opts: GraticuleOptions = {}): Promise<GraticuleGeometry> {
  const { lonlat, lines } = sampleLines(opts.stepDeg ?? 10, opts.sampleDeg ?? 1);
  const xy = await geo.fromGeo(lonlat);
  const back = await geo.fromGeo(await geo.toGeo(xy));
  return assemble(lines, xy, back, opts);
}
