/**
 * Repeating the world sideways: when, and by how much.
 *
 * Some projections can show more than one copy of the globe. Which ones, and
 * in what direction, is decided here without any table of projection names:
 * the vector across the base world at latitude phi,
 *
 *     T(phi) = fwd(lon_0 + 180, phi) - fwd(lon_0 - 180, phi)
 *
 * is a translational period exactly when it is finite, non-zero at the
 * equator, and parallel at every latitude. That single test sorts them:
 *
 *   merc, eqc, cea        T constant: copies tile the plane exactly
 *   sinu, moll, robin,    T parallel but shrinking with latitude: copies
 *   eck4, natearth, igh,  touch at the equator with lens-shaped gaps
 *   hammer, wintri        between, like the interruptions of a homolosine
 *   laea, aeqd            both edges land on the antipode: T = 0, no wrap
 *   ortho, gnom, stere    edges are off the map or at infinity: no wrap
 *   lcc, aea              edges related by a rotation, not parallel: no wrap
 *   tmerc, omerc          both edges are the same meridian: T = 0 (their
 *                         repeat runs along y or u, a separate matter)
 *
 * The mesh then reduces every display vertex into the base copy (p - kT),
 * projects it there, and keeps it if the round trip holds. Points in the
 * gaps fail the round trip and are dropped by the ordinary validity mask.
 * Note that +over is a different thing: it continues the projection's
 * formula past 180 degrees, which for a pseudocylindrical is a shear, not a
 * copy. This is the copy.
 */
import { crsDefinition } from './crs';
import { GeoTransform, geoTransform } from './transform';

export interface WrapSpec {
  /** Translation between adjacent copies, display units. */
  tx: number;
  ty: number;
  /** A point in the base copy: the projected (lon_0, 0). */
  ax: number;
  ay: number;
}

function centralMeridian(crs: string): number {
  const def = crsDefinition(crs) ?? crs;
  const m = /\+lon_?[0c]=(-?[\d.]+)/.exec(def);
  return m ? parseFloat(m[1]) : 0;
}

/** The copy index of a display point, given a wrap. */
export function copyIndex(w: WrapSpec, x: number, y: number): number {
  const len2 = w.tx * w.tx + w.ty * w.ty;
  return Math.round(((x - w.ax) * w.tx + (y - w.ay) * w.ty) / len2);
}

const PHIS = [0, -80, -70, -60, -50, -40, -30, -20, -10, 10, 20, 30, 40, 50, 60, 70, 80];

/** The lon/lat probe points: (lon_0, 0), then the two edges at each latitude. */
function probes(lon0: number): Float64Array {
  const eps = 1e-7;
  const pts: number[] = [lon0, 0];
  for (const phi of PHIS) pts.push(lon0 - 180 + eps, phi, lon0 + 180 - eps, phi);
  return Float64Array.from(pts);
}

/** Decide from the projected probes. */
function decide(xy: Float64Array): WrapSpec | null {
  const ax = xy[0], ay = xy[1];
  if (!isFinite(ax) || !isFinite(ay)) return null;
  const across = (i: number): [number, number] | null => {
    const o = 2 + i * 4;
    const t: [number, number] = [xy[o + 2] - xy[o], xy[o + 3] - xy[o + 1]];
    return isFinite(t[0]) && isFinite(t[1]) ? t : null;
  };
  const t0 = across(0);
  if (!t0) return null;
  const len0 = Math.hypot(t0[0], t0[1]);
  // A world is never narrower than its planet's radius; anything much
  // smaller is two edges landing on (nearly) the same point.
  if (!(len0 > 1e-3 * 6.378e6)) return null;

  for (let i = 1; i < PHIS.length; i++) {
    const t = across(i);
    if (!t) return null;
    const len = Math.hypot(t[0], t[1]);
    if (len === 0) continue;                       // a pole-like pinch is fine
    if (len > len0 * (1 + 1e-6)) return null;      // wider than the equator: not a world map
    const cross = t0[0] * t[1] - t0[1] * t[0];
    const dot = t0[0] * t[0] + t0[1] * t[1];
    if (Math.abs(cross) > 1e-6 * len0 * len || dot <= 0) return null;
  }
  return { tx: t0[0], ty: t0[1], ax, ay };
}

/** Synchronous: the display CRS must be one proj4js executes. */
export function detectWrap(displayCRS: string): WrapSpec | null {
  const geo = geoTransform(displayCRS);
  if (!geo.fromGeoSync) throw new Error(`${displayCRS} needs the PROJ executor; use detectWrapAsync`);
  try {
    return decide(geo.fromGeoSync(probes(centralMeridian(displayCRS))));
  } catch {
    return null;
  }
}

/** Any executor: one batch. */
export async function detectWrapAsync(geo: GeoTransform): Promise<WrapSpec | null> {
  try {
    return decide(await geo.fromGeo(probes(centralMeridian(geo.crs))));
  } catch {
    return null;
  }
}
