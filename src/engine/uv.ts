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
 * @param tolerance Max round-trip error, in display CRS units. Something like
 *                  a small fraction of a mesh cell is a good choice.
 */
export function computeTextureCoordsMasked(
  positions: Float32Array,
  displayCRS: string,
  sourceCRS: string,
  sourceBounds: SourceBounds,
  tolerance: number
): MaskedTextureCoords {
  const numVertices = positions.length / 3;
  const texCoords = new Float32Array(numVertices * 2);
  const valid = new Uint8Array(numVertices);
  let validCount = 0;

  const displayToGeo = proj4(displayCRS, 'EPSG:4326');
  const geoToDisplay = proj4('EPSG:4326', displayCRS);
  const geoToSource = proj4('EPSG:4326', sourceCRS);

  const { minX, minY, maxX, maxY } = sourceBounds;
  const sourceWidth = maxX - minX;
  const sourceHeight = maxY - minY;
  const tol2 = tolerance * tolerance;

  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  let dMinX = Infinity, dMinY = Infinity, dMaxX = -Infinity, dMaxY = -Infinity;

  for (let i = 0; i < numVertices; i++) {
    const dx = positions[i * 3 + 0];
    const dy = positions[i * 3 + 1];

    let ok = false;
    let u = -1, v = -1;
    try {
      const [lon, lat] = displayToGeo.forward([dx, dy]);
      if (isFinite(lon) && isFinite(lat)) {
        const [bx, by] = geoToDisplay.forward([lon, lat]);
        const ex = bx - dx, ey = by - dy;
        if (isFinite(ex) && isFinite(ey) && ex * ex + ey * ey <= tol2) {
          const [sx, sy] = geoToSource.forward([lon, lat]);
          if (isFinite(sx) && isFinite(sy)) {
            u = (sx - minX) / sourceWidth;
            v = 1.0 - (sy - minY) / sourceHeight;
            ok = true;
            if (sx < sMinX) sMinX = sx;
            if (sx > sMaxX) sMaxX = sx;
            if (sy < sMinY) sMinY = sy;
            if (sy > sMaxY) sMaxY = sy;
            if (dx < dMinX) dMinX = dx;
            if (dx > dMaxX) dMaxX = dx;
            if (dy < dMinY) dMinY = dy;
            if (dy > dMaxY) dMaxY = dy;
          }
        }
      }
    } catch {
      ok = false;
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
  wrapU: boolean
): LayerGeometry {
  const masked = computeTextureCoordsMasked(positions, displayCRS, sourceCRS, sourceBounds, tolerance);
  const { texCoords: uv, valid } = masked;

  const maxTris = indices.length / 3;
  const outPos = new Float32Array(maxTris * 9);
  const outUV = new Float32Array(maxTris * 6);
  let n = 0;
  let seamDropped = 0;

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (!(valid[a] && valid[b] && valid[c])) continue;

    let ua = uv[a * 2], ub = uv[b * 2], uc = uv[c * 2];
    if (wrapU) {
      // Bring b and c to within half a texture of a.
      ub -= Math.round(ub - ua);
      uc -= Math.round(uc - ua);
      const span = Math.max(ua, ub, uc) - Math.min(ua, ub, uc);
      if (span > 0.5) {
        seamDropped++;
        continue;
      }
    }

    const verts = [a, b, c];
    const us = [ua, ub, uc];
    for (let k = 0; k < 3; k++) {
      const v = verts[k];
      outPos[n * 9 + k * 3 + 0] = positions[v * 3 + 0];
      outPos[n * 9 + k * 3 + 1] = positions[v * 3 + 1];
      outPos[n * 9 + k * 3 + 2] = positions[v * 3 + 2];
      outUV[n * 6 + k * 2 + 0] = us[k];
      outUV[n * 6 + k * 2 + 1] = uv[v * 2 + 1];
    }
    n++;
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
