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
import proj4 from 'proj4';
import { crsDefinition } from './crs';

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

export function detectWrap(displayCRS: string): WrapSpec | null {
  let fwd: { forward(p: number[]): number[] };
  try {
    fwd = proj4('EPSG:4326', displayCRS);
  } catch {
    return null;
  }
  const lon0 = centralMeridian(displayCRS);
  const eps = 1e-7;
  const across = (phi: number): [number, number] | null => {
    try {
      const a = fwd.forward([lon0 - 180 + eps, phi]);
      const b = fwd.forward([lon0 + 180 - eps, phi]);
      const t: [number, number] = [b[0] - a[0], b[1] - a[1]];
      return isFinite(t[0]) && isFinite(t[1]) ? t : null;
    } catch {
      return null;
    }
  };
  let anchor: number[];
  try {
    anchor = fwd.forward([lon0, 0]);
    if (!isFinite(anchor[0]) || !isFinite(anchor[1])) return null;
  } catch {
    return null;
  }
  const t0 = across(0);
  if (!t0) return null;
  const len0 = Math.hypot(t0[0], t0[1]);
  // A world is never narrower than its planet's radius; anything much
  // smaller is two edges landing on (nearly) the same point.
  if (!(len0 > 1e-3 * 6.378e6)) return null;

  for (let phi = -80; phi <= 80; phi += 10) {
    const t = across(phi);
    if (!t) return null;
    const len = Math.hypot(t[0], t[1]);
    if (len === 0) continue;                       // a pole-like pinch is fine
    if (len > len0 * (1 + 1e-6)) return null;      // wider than the equator: not a world map
    const cross = t0[0] * t[1] - t0[1] * t[0];
    const dot = t0[0] * t[0] + t0[1] * t[1];
    if (Math.abs(cross) > 1e-6 * len0 * len || dot <= 0) return null;
  }
  return { tx: t0[0], ty: t0[1], ax: anchor[0], ay: anchor[1] };
}
