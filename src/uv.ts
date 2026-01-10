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
 *   display_coord → WGS84 → source_crs → normalized [0,1]
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

  // Build transform: display → source (via WGS84 as intermediate)
  // proj4(from, to).forward() transforms from → to
  const displayToSource = proj4(displayCRS, sourceCRS);

  const { minX, minY, maxX, maxY } = sourceBounds;
  const sourceWidth = maxX - minX;
  const sourceHeight = maxY - minY;

  for (let i = 0; i < numVertices; i++) {
    const displayX = positions[i * 3 + 0];
    const displayY = positions[i * 3 + 1];

    // Transform display coord → source coord
    const [sourceX, sourceY] = displayToSource.forward([displayX, displayY]);

    // Source coord → normalized texture coordinates [0, 1]
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
          // Clamp extreme Mercator Y values (beyond ~85° latitude)
          // This avoids near-infinite values near poles
          const clampedY = Math.max(-20037508, Math.min(20037508, dy));
          
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
