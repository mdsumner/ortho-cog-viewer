/**
 * Raster extents in a CRS, and transforms between them.
 *
 * Core rather than engine: a source's footprint and the arithmetic for moving
 * one between CRSs is needed to plan reads, whatever draws the result.
 */

import proj4 from 'proj4';

export interface SourceBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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
