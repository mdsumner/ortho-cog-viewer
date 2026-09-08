/**
 * UV coordinate computation by inverse-projecting display positions to source pixels.
 * 
 * This is the heart of the reprojection trick:
 * - Mesh vertices are in display space (regular grid)
 * - UV coords point to where in the source texture to sample
 * - The "warp" is encoded in how UVs vary across the mesh
 * - GPU interpolates linearly within triangles (the approximation)
 */

import proj4 from 'proj4';

export interface SourceBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Compute texture coordinates by inverse-projecting display positions to source space.
 * 
 * Transform chain for each vertex:
 *   display_coord -> WGS84 -> source_crs -> normalized [0,1]
 * 
 * @param positions [x, y, z, x, y, z, ...] in display CRS (z ignored)
 * @param displayCRS EPSG code or proj4 string for display space
 * @param sourceCRS EPSG code or proj4 string for source image
 * @param sourceBounds Geographic extent of source image in source CRS units
 * @returns Float32Array of [u, v, u, v, ...] texture coordinates
 */
export function computeTextureCoords(
  positions: Float32Array,
  displayCRS: string,
  sourceCRS: string,
  sourceBounds: SourceBounds
): Float32Array {
  const numVertices = positions.length / 3;  // xyz per vertex
  const texCoords = new Float32Array(numVertices * 2);

  // Build transform: display -> source (via WGS84 as intermediate)
  // proj4(from, to).forward() transforms from -> to
  const displayToSource = proj4(displayCRS, sourceCRS);

  const { minX, minY, maxX, maxY } = sourceBounds;
  const sourceWidth = maxX - minX;
  const sourceHeight = maxY - minY;

  for (let i = 0; i < numVertices; i++) {
    const displayX = positions[i * 3 + 0];
    const displayY = positions[i * 3 + 1];

    // Transform display coord -> source coord
    const [sourceX, sourceY] = displayToSource.forward([displayX, displayY]);

    // Source coord -> normalized texture coordinates [0, 1]
    let u = (sourceX - minX) / sourceWidth;
    let v = (sourceY - minY) / sourceHeight;

    // Flip V for typical image coordinates (origin top-left)
    // Most images have Y increasing downward, textures have V increasing upward
    v = 1.0 - v;

    texCoords[i * 2 + 0] = u;
    texCoords[i * 2 + 1] = v;
  }

  return texCoords;
}

export interface MaskedTextureCoords {
  texCoords: Float32Array;
  /** 1 where the display vertex has a well-defined position on the globe, 0 otherwise */
  valid: Uint8Array;
  validCount: number;
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

  return { texCoords, valid, validCount };
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
}

/**
 * Is this a geographic (lon/lat) CRS?
 */
export function isLongLat(crs: string): boolean {
  try {
    const def = proj4.defs(crs);
    if (def && (def.projName === 'longlat' || def.projName === 'latlong')) return true;
  } catch { /* fall through */ }
  return /\+proj=longlat|\+proj=latlong|^EPSG:4326$|^EPSG:4269$/.test(crs);
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
    seamDropped
  };
}

/**
 * Transform bounds from one CRS to another.
 * Samples along edges AND interior to handle non-linear transforms
 * (important for polar projections where extremes may be in the interior).
 */
export function transformBounds(
  bounds: SourceBounds,
  fromCRS: string,
  toCRS: string,
  samples: number = 20
): SourceBounds {
  const transform = proj4(fromCRS, toCRS);
  // Only Web Mercator needs its polar blow-up clamped; other targets keep their values.
  const isMercator = /3857|900913|\+proj=merc/.test(toCRS);
  
  let outMinX = Infinity;
  let outMinY = Infinity;
  let outMaxX = -Infinity;
  let outMaxY = -Infinity;

  const { minX, minY, maxX, maxY } = bounds;

  // Sample a grid across the entire bounds (edges + interior)
  for (let i = 0; i <= samples; i++) {
    for (let j = 0; j <= samples; j++) {
      const sx = minX + (i / samples) * (maxX - minX);
      const sy = minY + (j / samples) * (maxY - minY);
      
      try {
        const [dx, dy] = transform.forward([sx, sy]);
        
        // Skip infinite or NaN values (e.g., poles in Mercator)
        if (isFinite(dx) && isFinite(dy)) {
          // Clamp extreme Mercator Y values (beyond ~85 deg latitude)
          // This avoids near-infinite values near poles
          const clampedY = isMercator ? Math.max(-20037508, Math.min(20037508, dy)) : dy;
          
          outMinX = Math.min(outMinX, dx);
          outMinY = Math.min(outMinY, clampedY);
          outMaxX = Math.max(outMaxX, dx);
          outMaxY = Math.max(outMaxY, clampedY);
        }
      } catch {
        // Transform failed for this point, skip it
      }
    }
  }

  return { minX: outMinX, minY: outMinY, maxX: outMaxX, maxY: outMaxY };
}
