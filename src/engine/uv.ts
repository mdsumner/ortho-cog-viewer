/**
 * UV coordinate computation by inverse-projecting display positions to source pixels.
 *
 * This is the heart of the mesh engine's reprojection:
 * - Mesh vertices are in display space (regular grid)
 * - UV coords point to where in the source texture to sample
 * - The "warp" is encoded in how UVs vary across the mesh
 * - GPU interpolates linearly within triangles (the approximation)
 */

import proj4 from 'proj4';
import { SourceBounds } from '../core/bounds';
import { WrapSpec, copyIndex } from '../core/wrap';
import { GeoTransform, geoTransform } from '../core/transform';


export interface MaskedTextureCoords {
  texCoords: Float32Array;
  /** 1 where the display vertex has a well-defined position on the globe, 0 otherwise */
  valid: Uint8Array;
  validCount: number;
  /** source-CRS bounding box of the valid vertices (null if none) */
  sourceBBox: SourceBounds | null;
  /** display-CRS bounding box of the valid vertices (null if none) */
  displayBBox: SourceBounds | null;
}

/**
 * Like computeTextureCoords, but also reports which vertices are geometrically valid.
 *
 * A display-space vertex is valid when display -> lon/lat -> display returns
 * (within tolerance) to where it started. That single test catches every
 * projection-agnostic failure mode we care about: beyond the horizon of an
 * azimuthal projection (proj4 clamps the inverse to the rim), past the poles
 * of Mercator, the antipode of an aeqd, NaN/undefined from the transform, etc.
 *
 * The display-side transforms go through a GeoTransform, so the executor
 * may be proj4js (synchronous, this function) or PROJ in wasm (batched in
 * a worker, the Async variant). The source side is always proj4js.
 *
 * @param tolerance Max round-trip error, in display CRS units. Something like
 *                  a small fraction of a mesh cell is a good choice.
 */
export function computeTextureCoordsMasked(
  positions: Float32Array,
  displayCRS: string,
  sourceCRS: string,
  sourceBounds: SourceBounds,
  tolerance: number,
  wrap: WrapSpec | null = null
): MaskedTextureCoords {
  const geo = geoTransform(displayCRS);
  if (!geo.toGeoSync || !geo.fromGeoSync) {
    throw new Error(`${displayCRS} needs the PROJ executor; use computeTextureCoordsMaskedAsync`);
  }
  const reduced = reduceIntoBaseCopy(positions, wrap);
  const lonlat = geo.toGeoSync(reduced);
  const back = geo.fromGeoSync(lonlat);
  return finishTextureCoords(positions, reduced, lonlat, back, sourceCRS, sourceBounds, tolerance);
}

export async function computeTextureCoordsMaskedAsync(
  positions: Float32Array,
  geo: GeoTransform,
  sourceCRS: string,
  sourceBounds: SourceBounds,
  tolerance: number,
  wrap: WrapSpec | null = null
): Promise<MaskedTextureCoords> {
  const reduced = reduceIntoBaseCopy(positions, wrap);
  const lonlat = await geo.toGeo(reduced);
  const back = await geo.fromGeo(lonlat);
  return finishTextureCoords(positions, reduced, lonlat, back, sourceCRS, sourceBounds, tolerance);
}

/** Display xy pairs, each moved into the base copy of the world if wrapping. */
function reduceIntoBaseCopy(positions: Float32Array, wrap: WrapSpec | null): Float64Array {
  const n = positions.length / 3;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    let dx = positions[i * 3], dy = positions[i * 3 + 1];
    if (wrap) {
      // A point in a gap between copies fails the round trip later just as
      // a point off the globe does.
      const k = copyIndex(wrap, dx, dy);
      dx -= k * wrap.tx;
      dy -= k * wrap.ty;
    }
    out[i * 2] = dx;
    out[i * 2 + 1] = dy;
  }
  return out;
}

/** The part after the display-side transforms: validity, UVs, bboxes. */
function finishTextureCoords(
  positions: Float32Array,
  reduced: Float64Array,
  lonlat: Float64Array,
  back: Float64Array,
  sourceCRS: string,
  sourceBounds: SourceBounds,
  tolerance: number
): MaskedTextureCoords {
  const numVertices = positions.length / 3;
  const texCoords = new Float32Array(numVertices * 2);
  const valid = new Uint8Array(numVertices);
  let validCount = 0;

  const geoToSource = proj4('EPSG:4326', sourceCRS);
  const { minX, minY, maxX, maxY } = sourceBounds;
  const sourceWidth = maxX - minX;
  const sourceHeight = maxY - minY;
  const tol2 = tolerance * tolerance;

  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  let dMinX = Infinity, dMinY = Infinity, dMaxX = -Infinity, dMaxY = -Infinity;

  for (let i = 0; i < numVertices; i++) {
    const dx = reduced[i * 2], dy = reduced[i * 2 + 1];
    const lon = lonlat[i * 2], lat = lonlat[i * 2 + 1];
    let ok = false;
    let u = -1, v = -1;
    if (isFinite(lon) && isFinite(lat)) {
      const ex = back[i * 2] - dx, ey = back[i * 2 + 1] - dy;
      if (isFinite(ex) && isFinite(ey) && ex * ex + ey * ey <= tol2) {
        try {
          const [sx, sy] = geoToSource.forward([lon, lat]);
          if (isFinite(sx) && isFinite(sy)) {
            u = (sx - minX) / sourceWidth;
            v = 1.0 - (sy - minY) / sourceHeight;
            ok = true;
            if (sx < sMinX) sMinX = sx;
            if (sx > sMaxX) sMaxX = sx;
            if (sy < sMinY) sMinY = sy;
            if (sy > sMaxY) sMaxY = sy;
            // display bbox in the vertex's own (unreduced) position
            const px = positions[i * 3], py = positions[i * 3 + 1];
            if (px < dMinX) dMinX = px;
            if (px > dMaxX) dMaxX = px;
            if (py < dMinY) dMinY = py;
            if (py > dMaxY) dMaxY = py;
          }
        } catch {
          ok = false;
        }
      }
    }
    texCoords[i * 2 + 0] = u;
    texCoords[i * 2 + 1] = v;
    if (ok) {
      valid[i] = 1;
      validCount++;
    }
  }

  return {
    texCoords, valid, validCount,
    sourceBBox: validCount ? { minX: sMinX, minY: sMinY, maxX: sMaxX, maxY: sMaxY } : null,
    displayBBox: validCount ? { minX: dMinX, minY: dMinY, maxX: dMaxX, maxY: dMaxY } : null
  };
}

/**
 * Drop every triangle that touches an invalid vertex.
 */
export function filterIndices(indices: Uint32Array, valid: Uint8Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  let n = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (valid[a] && valid[b] && valid[c]) {
      out[n++] = a;
      out[n++] = b;
      out[n++] = c;
    }
  }
  return out.subarray(0, n);
}

export interface LayerGeometry {
  positions: Float32Array;   // de-indexed: 3 vertices per triangle
  texCoords: Float32Array;
  indices: Uint32Array;      // 0..n-1, sequential
  triangleCount: number;
  validFraction: number;     // fraction of base-mesh vertices that were on-globe
  seamDropped: number;       // triangles dropped because they contain a pole
  sourceBBox: SourceBounds | null;
  displayBBox: SourceBounds | null;
}

/**
 * Build a per-layer, de-indexed mesh with seam-safe texture coordinates.
 *
 * Two things go wrong when a shared-vertex mesh is textured with a global
 * lon/lat image:
 *
 *   1. A triangle straddling the antimeridian has vertices at u ~ 0 and
 *      u ~ 1, and the GPU interpolates across the whole texture width.
 *   2. A triangle containing a pole has vertices at every longitude; no
 *      unwrapping can fix it.
 *
 * So each triangle gets its own three vertices (3x the vertex count, which
 * is still only a few thousand), u is unwrapped per triangle relative to its
 * first vertex when the source is 360 degrees wide (the renderer then uses
 * REPEAT wrapping in S), and any triangle whose u span is still more than
 * half the texture is dropped: those are the pole triangles and they leave a
 * hole one cell across instead of a smear to the horizon.
 */
export function buildLayerGeometry(
  positions: Float32Array,
  indices: Uint32Array,
  displayCRS: string,
  sourceCRS: string,
  sourceBounds: SourceBounds,
  tolerance: number,
  wrapU: boolean,
  wrap: WrapSpec | null = null
): LayerGeometry {
  const masked = computeTextureCoordsMasked(positions, displayCRS, sourceCRS, sourceBounds, tolerance, wrap);
  const rim = rimEdges(positions, indices, masked);
  for (let k = 0; k < RIM_STEPS && rim.count; k++) {
    rimStep(rim, computeTextureCoordsMasked(rimMidpoints(rim), displayCRS, sourceCRS, sourceBounds, tolerance, wrap));
  }
  const poles = wrapU ? polesOf(geoTransform(displayCRS).fromGeoSync!(POLES_LL), sourceCRS, sourceBounds) : [];
  return assembleLayerGeometry(positions, indices, masked, wrapU, rim, poles, wrap);
}

/** The same, with the display transforms run by any executor. */
export async function buildLayerGeometryAsync(
  positions: Float32Array,
  indices: Uint32Array,
  geo: GeoTransform,
  sourceCRS: string,
  sourceBounds: SourceBounds,
  tolerance: number,
  wrapU: boolean,
  wrap: WrapSpec | null = null
): Promise<LayerGeometry> {
  const masked = await computeTextureCoordsMaskedAsync(positions, geo, sourceCRS, sourceBounds, tolerance, wrap);
  const rim = rimEdges(positions, indices, masked);
  for (let k = 0; k < RIM_STEPS && rim.count; k++) {
    rimStep(rim, await computeTextureCoordsMaskedAsync(rimMidpoints(rim), geo, sourceCRS, sourceBounds, tolerance, wrap));
  }
  const poles = wrapU ? polesOf(await geo.fromGeo(POLES_LL), sourceCRS, sourceBounds) : [];
  return assembleLayerGeometry(positions, indices, masked, wrapU, rim, poles, wrap);
}

// ---------------------------------------------------------------------------
// The poles
// ---------------------------------------------------------------------------

const POLES_LL = new Float64Array([0, 90, 0, -90]);

/** A pole where the display has it as a point: display xy, and its v. */
interface Pole { x: number; y: number; v: number }

function polesOf(xy: Float64Array, sourceCRS: string, sourceBounds: SourceBounds): Pole[] {
  const out: Pole[] = [];
  const toSource = proj4('EPSG:4326', sourceCRS);
  for (let k = 0; k < 2; k++) {
    const x = xy[k * 2], y = xy[k * 2 + 1];
    if (!isFinite(x) || !isFinite(y)) continue;
    let sy: number;
    try { sy = toSource.forward([0, k === 0 ? 90 : -90])[1]; } catch { continue; }
    if (!isFinite(sy)) continue;
    out.push({ x, y, v: 1.0 - (sy - sourceBounds.minY) / (sourceBounds.maxY - sourceBounds.minY) });
  }
  return out;
}

/** Is (px, py) inside the triangle (allowing for either winding)? */
function inTriangle(px: number, py: number, xs: number[], ys: number[]): boolean {
  const d = (i: number, j: number) =>
    (xs[j] - xs[i]) * (py - ys[i]) - (ys[j] - ys[i]) * (px - xs[i]);
  const a = d(0, 1), b = d(1, 2), c = d(2, 0);
  return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0);
}

// ---------------------------------------------------------------------------
// The rim: where the valid region ends inside a mesh cell
// ---------------------------------------------------------------------------

/**
 * Bisection steps along each edge that crosses the rim. Each step halves the
 * distance to the true edge of the valid region, so 10 steps put it within a
 * thousandth of a mesh cell, well under a pixel at any grid size.
 */
const RIM_STEPS = 10;

/**
 * Every mesh edge with one valid and one invalid end. Dropping the triangles
 * on those edges gives the map a staircase outline one mesh cell deep (the
 * limb of an orthographic globe, the rim of a lobe); instead each edge is
 * bisected to where validity actually ends, and the partial triangles are
 * clipped there. An edge is shared by the two triangles on either side of
 * it and both use the same boundary point, so the clip leaves no cracks.
 */
interface Rim {
  count: number;
  /** edge key (lo * nVerts + hi of the vertex indices) -> rim slot */
  slot: Map<number, number>;
  nVerts: number;
  /** last known valid point and first known invalid point, display xy */
  inX: Float64Array; inY: Float64Array;
  outX: Float64Array; outY: Float64Array;
  /** uv at the valid point */
  u: Float64Array; v: Float64Array;
}

function edgeKey(a: number, b: number, n: number): number {
  return a < b ? a * n + b : b * n + a;
}

function rimEdges(positions: Float32Array, indices: Uint32Array, masked: MaskedTextureCoords): Rim {
  const { valid, texCoords: uv } = masked;
  const nVerts = positions.length / 3;
  const slot = new Map<number, number>();
  const pairs: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k], b = indices[t + (k + 1) % 3];
      if (valid[a] === valid[b]) continue;
      const key = edgeKey(a, b, nVerts);
      if (slot.has(key)) continue;
      slot.set(key, pairs.length / 2);
      if (valid[a]) pairs.push(a, b); else pairs.push(b, a);
    }
  }
  const count = pairs.length / 2;
  const rim: Rim = {
    count, slot, nVerts,
    inX: new Float64Array(count), inY: new Float64Array(count),
    outX: new Float64Array(count), outY: new Float64Array(count),
    u: new Float64Array(count), v: new Float64Array(count)
  };
  for (let i = 0; i < count; i++) {
    const a = pairs[i * 2], b = pairs[i * 2 + 1];
    rim.inX[i] = positions[a * 3]; rim.inY[i] = positions[a * 3 + 1];
    rim.outX[i] = positions[b * 3]; rim.outY[i] = positions[b * 3 + 1];
    rim.u[i] = uv[a * 2]; rim.v[i] = uv[a * 2 + 1];
  }
  return rim;
}

function rimMidpoints(rim: Rim): Float32Array {
  const out = new Float32Array(rim.count * 3);
  for (let i = 0; i < rim.count; i++) {
    out[i * 3] = (rim.inX[i] + rim.outX[i]) / 2;
    out[i * 3 + 1] = (rim.inY[i] + rim.outY[i]) / 2;
  }
  return out;
}

function rimStep(rim: Rim, probe: MaskedTextureCoords): void {
  for (let i = 0; i < rim.count; i++) {
    const mx = (rim.inX[i] + rim.outX[i]) / 2, my = (rim.inY[i] + rim.outY[i]) / 2;
    if (probe.valid[i]) {
      rim.inX[i] = mx; rim.inY[i] = my;
      rim.u[i] = probe.texCoords[i * 2]; rim.v[i] = probe.texCoords[i * 2 + 1];
    } else {
      rim.outX[i] = mx; rim.outY[i] = my;
    }
  }
}

function assembleLayerGeometry(
  positions: Float32Array,
  indices: Uint32Array,
  masked: MaskedTextureCoords,
  wrapU: boolean,
  rim: Rim | null = null,
  poles: Pole[] = [],
  wrap: WrapSpec | null = null
): LayerGeometry {
  const { texCoords: uv, valid } = masked;

  // A clipped triangle with two valid corners becomes a quad, two triangles;
  // a triangle around a pole becomes three.
  const maxTris = (indices.length / 3) * 3;
  const outPos = new Float32Array(maxTris * 9);
  const outUV = new Float32Array(maxTris * 6);
  let n = 0;
  let seamDropped = 0;

  // The corners of the (possibly clipped) triangle being emitted.
  const px = [0, 0, 0, 0], py = [0, 0, 0, 0], pz = [0, 0, 0, 0];
  const pu = [0, 0, 0, 0], pv = [0, 0, 0, 0];
  let m = 0;
  const pushVertex = (i: number) => {
    px[m] = positions[i * 3]; py[m] = positions[i * 3 + 1]; pz[m] = positions[i * 3 + 2];
    pu[m] = uv[i * 2]; pv[m] = uv[i * 2 + 1];
    m++;
  };
  const pushRim = (s: number) => {
    px[m] = rim!.inX[s]; py[m] = rim!.inY[s]; pz[m] = 0;
    pu[m] = rim!.u[s]; pv[m] = rim!.v[s];
    m++;
  };
  const write = (xs: number[], ys: number[], zs: number[], us: number[], vs: number[]) => {
    for (let k = 0; k < 3; k++) {
      outPos[n * 9 + k * 3 + 0] = xs[k];
      outPos[n * 9 + k * 3 + 1] = ys[k];
      outPos[n * 9 + k * 3 + 2] = zs[k];
      outUV[n * 6 + k * 2 + 0] = us[k];
      outUV[n * 6 + k * 2 + 1] = vs[k];
    }
    n++;
  };
  const emit = (i0: number, i1: number, i2: number) => {
    const ids = [i0, i1, i2];
    const xs = ids.map(c => px[c]), ys = ids.map(c => py[c]), zs = ids.map(c => pz[c]);
    const vs = ids.map(c => pv[c]);
    const ua = pu[i0];
    let ub = pu[i1], uc = pu[i2];
    if (wrapU) {
      // Bring b and c to within half a texture of a.
      ub -= Math.round(ub - ua);
      uc -= Math.round(uc - ua);
      const span = Math.max(ua, ub, uc) - Math.min(ua, ub, uc);
      if (span > 0.5) {
        if (!fanAroundPole(xs, ys, zs, [pu[i0], pu[i1], pu[i2]], vs)) seamDropped++;
        return;
      }
    }
    write(xs, ys, zs, [ua, ub, uc], vs);
  };
  /**
   * A triangle with a pole inside it has corners at every longitude, so no
   * one u works for it. Split it at the pole into three, each spanning only
   * the longitudes along one of its edges, with the pole's own corner at the
   * middle of those: u is arbitrary at the pole itself, so that is exact.
   */
  const fanAroundPole = (xs: number[], ys: number[], zs: number[], us: number[], vs: number[]): boolean => {
    for (const pole of poles) {
      let ox = pole.x, oy = pole.y;
      if (wrap && (wrap.tx || wrap.ty)) {
        // The copy of the pole nearest this triangle.
        const cx = (xs[0] + xs[1] + xs[2]) / 3, cy = (ys[0] + ys[1] + ys[2]) / 3;
        const t2 = wrap.tx * wrap.tx + wrap.ty * wrap.ty;
        const k = Math.round(((cx - ox) * wrap.tx + (cy - oy) * wrap.ty) / t2);
        ox += k * wrap.tx;
        oy += k * wrap.ty;
      }
      if (!inTriangle(ox, oy, xs, ys)) continue;
      for (let k = 0; k < 3; k++) {
        const a = k, b = (k + 1) % 3;
        const ua = us[a];
        const ub = us[b] - Math.round(us[b] - ua);
        if (Math.abs(ub - ua) > 0.5) continue;
        write([xs[a], xs[b], ox], [ys[a], ys[b], oy], [zs[a], zs[b], 0],
              [ua, ub, (ua + ub) / 2], [vs[a], vs[b], pole.v]);
      }
      return true;
    }
    return false;
  };

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const nValid = valid[a] + valid[b] + valid[c];
    if (nValid === 0) continue;
    if (nValid < 3 && !rim) continue;
    m = 0;
    if (nValid === 3) {
      pushVertex(a); pushVertex(b); pushVertex(c);
    } else {
      // Walk the corners in order, keeping the valid ones and putting the
      // rim point in wherever an edge crosses out of (or into) the valid
      // region. The winding is kept.
      const tri = [a, b, c];
      for (let k = 0; k < 3; k++) {
        const p = tri[k], q = tri[(k + 1) % 3];
        if (valid[p]) pushVertex(p);
        if (valid[p] !== valid[q]) pushRim(rim!.slot.get(edgeKey(p, q, rim!.nVerts))!);
      }
    }
    emit(0, 1, 2);
    if (m === 4) emit(0, 2, 3);
  }

  const idx = new Uint32Array(n * 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;

  return {
    positions: outPos.subarray(0, n * 9),
    texCoords: outUV.subarray(0, n * 6),
    indices: idx,
    triangleCount: n,
    validFraction: masked.validCount / (positions.length / 3),
    seamDropped,
    sourceBBox: masked.sourceBBox,
    displayBBox: masked.displayBBox
  };
}
