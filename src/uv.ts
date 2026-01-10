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
 * Samples along edges to handle non-linear transforms.
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

  // Sample along all four edges
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    
    // Bottom edge
    const [bx, by] = transform.forward([minX + t * (maxX - minX), minY]);
    // Top edge
    const [tx, ty] = transform.forward([minX + t * (maxX - minX), maxY]);
    // Left edge
    const [lx, ly] = transform.forward([minX, minY + t * (maxY - minY)]);
    // Right edge
    const [rx, ry] = transform.forward([maxX, minY + t * (maxY - minY)]);

    for (const [x, y] of [[bx, by], [tx, ty], [lx, ly], [rx, ry]]) {
      if (isFinite(x) && isFinite(y)) {
        outMinX = Math.min(outMinX, x);
        outMinY = Math.min(outMinY, y);
        outMaxX = Math.max(outMaxX, x);
        outMaxY = Math.max(outMaxY, y);
      }
    }
  }

  return { minX: outMinX, minY: outMinY, maxX: outMaxX, maxY: outMaxY };
}
