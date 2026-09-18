/**
 * Graticule: lon/lat lines projected into the current display CRS.
 *
 * Built on the CPU each time the display CRS changes (every frame in centred
 * mode). Lines are sampled densely in lon/lat, each sample is validated with
 * the same round-trip test the mesh uses, and any segment that is wildly
 * longer than its neighbours (a projection cut, e.g. the antimeridian in
 * Mercator or omerc) is dropped rather than drawn across the map.
 */

import proj4 from 'proj4';

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
}

export function buildGraticule(displayCRS: string, opts: GraticuleOptions = {}): GraticuleGeometry {
  const step = opts.stepDeg ?? 10;
  const sample = opts.sampleDeg ?? 1;
  const tol = opts.tolerance ?? 1;
  const tol2 = tol * tol;

  const fwd = proj4('EPSG:4326', displayCRS);
  const inv = proj4(displayCRS, 'EPSG:4326');

  const minor: number[] = [];
  const major: number[] = [];

  function project(lon: number, lat: number): [number, number] | null {
    try {
      const [x, y] = fwd.forward([lon, lat]);
      if (!isFinite(x) || !isFinite(y)) return null;
      // Round trip back to lon/lat and forward again: a point whose forward
      // image is a clamped or folded value will not survive this.
      const [blon, blat] = inv.forward([x, y]);
      if (!isFinite(blon) || !isFinite(blat)) return null;
      const [bx, by] = fwd.forward([blon, blat]);
      const ex = bx - x, ey = by - y;
      if (ex * ex + ey * ey > tol2) return null;
      return [x, y];
    } catch {
      return null;
    }
  }

  function emit(points: ([number, number] | null)[], out: number[]): void {
    // Collect candidate segments and their lengths
    const segs: number[][] = [];
    const lens: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (!a || !b) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      segs.push([a[0], a[1], b[0], b[1]]);
      lens.push(len);
    }
    if (segs.length === 0) return;
    const sorted = [...lens].sort((p, q) => p - q);
    const median = sorted[Math.floor(sorted.length / 2)];
    const limit = median * 8;
    for (let i = 0; i < segs.length; i++) {
      if (lens[i] > limit) continue;  // a cut
      const s = segs[i];
      out.push(s[0], s[1], 0, s[2], s[3], 0);
    }
  }

  // Meridians
  for (let lon = -180; lon < 180; lon += step) {
    const pts: ([number, number] | null)[] = [];
    for (let lat = -90; lat <= 90 + 1e-9; lat += sample) {
      pts.push(project(lon, Math.min(90, lat)));
    }
    emit(pts, lon === 0 ? major : minor);
  }

  // Parallels (skip the poles themselves)
  for (let lat = -90 + step; lat < 90; lat += step) {
    const pts: ([number, number] | null)[] = [];
    for (let lon = -180; lon <= 180 + 1e-9; lon += sample) {
      pts.push(project(Math.min(180, lon), lat));
    }
    emit(pts, lat === 0 ? major : minor);
  }

  return { minor: new Float32Array(minor), major: new Float32Array(major) };
}
