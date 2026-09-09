/**
 * Raster sources.
 *
 * A layer does not care where its pixels come from. It needs a source CRS, the
 * full extent, a list of resolution levels, and a way to fetch a texture
 * covering some region at some level. A COG provides that through its
 * overviews and tiled windows; an XYZ/WMTS tile pyramid provides exactly the
 * same thing through zoom levels and tiles. Nothing in the mesh, UV or
 * display-CRS code knows the difference.
 */

import { SourceBounds } from './uv';

export interface SourceLevel {
  index: number;
  resolution: number;   // source units per pixel
  width: number;        // pixels across the full extent at this level
  height: number;
}

export interface FloatStats {
  min: number;
  max: number;
  p2: number;     // 2nd percentile
  p98: number;    // 98th percentile
  count: number;  // valid samples
  /** counts per bin over [min, max] */
  hist: Uint32Array;
}

export interface TextureData {
  /** RGBA image, for picture-like sources */
  canvas?: HTMLCanvasElement;
  /** single-band numeric data, for colour mapping on the GPU */
  float?: { data: Float32Array; width: number; height: number; channels: 1 | 3; nodata: number | null; stats: FloatStats };
  bounds: SourceBounds;  // extent of the texture in source CRS units
}

export interface RasterSource {
  readonly kind: 'cog' | 'xyz';
  readonly label: string;
  readonly crs: string;
  readonly bounds: SourceBounds;
  /** Sorted finest (smallest resolution) to coarsest. */
  readonly levels: SourceLevel[];
  /** True when the x axis is periodic (a source spanning all longitudes). */
  readonly wrapU: boolean;
  readonly attribution?: string;
  /** true when fetch() returns float data rather than a canvas */
  readonly numeric: boolean;
  /**
   * Fetch a texture covering at least `region` at `level`. The returned
   * bounds may be larger than asked (snapped to tiles) and the canvas is
   * never larger than maxDim on a side.
   */
  fetch(level: number, region: SourceBounds, maxDim: number): Promise<TextureData>;
}

export interface FetchPlan {
  level: SourceLevel;
  /** what the view needs, clamped to the source */
  need: SourceBounds;
  /** what to ask for: need plus padding so small pans do not refetch */
  region: SourceBounds;
}

export function intersect(a: SourceBounds, b: SourceBounds): SourceBounds {
  return {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY)
  };
}

export function contains(outer: SourceBounds, inner: SourceBounds, eps = 0): boolean {
  return inner.minX >= outer.minX - eps && inner.maxX <= outer.maxX + eps &&
         inner.minY >= outer.minY - eps && inner.maxY <= outer.maxY + eps;
}

export function isEmpty(b: SourceBounds): boolean {
  return !(b.maxX > b.minX && b.maxY > b.minY);
}

/**
 * Decide what to fetch for a view.
 *
 * @param source     the raster source
 * @param sourceBBox source-space bounding box of the visible mesh vertices
 *                   (null if nothing is visible or unknown -> whole source)
 * @param displayPx  screen-pixel span of those same vertices; with the bbox
 *                   this gives an estimate of source units per screen pixel
 * @param maxDim     largest texture side we are willing to make
 * @param quality    < 1 asks for finer data than the estimate (the estimate
 *                   is an average over the visible region; the centre of an
 *                   azimuthal view is finer than its rim)
 */
export function planFetch(
  source: RasterSource,
  sourceBBox: SourceBounds | null,
  displayPx: { w: number; h: number } | null,
  maxDim: number,
  pad = 0.25,
  quality = 0.7
): FetchPlan | null {
  const full = source.bounds;
  let need = sourceBBox ? intersect(sourceBBox, full) : { ...full };
  if (isEmpty(need)) return null;

  // Desired resolution in source units per screen pixel
  let desired = Infinity;
  if (displayPx && displayPx.w > 0 && displayPx.h > 0) {
    const rx = (need.maxX - need.minX) / displayPx.w;
    const ry = (need.maxY - need.minY) / displayPx.h;
    desired = Math.min(rx, ry) * quality;
  }

  // Padded region, clamped
  const pw = (need.maxX - need.minX) * pad;
  const ph = (need.maxY - need.minY) * pad;
  let region = intersect({
    minX: need.minX - pw, maxX: need.maxX + pw,
    minY: need.minY - ph, maxY: need.maxY + ph
  }, full);

  // Coarsest level that still meets the desired resolution
  const levels = source.levels;  // finest -> coarsest
  let level = levels[0];
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i].resolution <= desired) {
      level = levels[i];
      break;
    }
  }

  // Back off to coarser levels until the padded region fits in maxDim
  let li = levels.indexOf(level);
  while (li < levels.length - 1) {
    const px = (region.maxX - region.minX) / levels[li].resolution;
    const py = (region.maxY - region.minY) / levels[li].resolution;
    if (px <= maxDim && py <= maxDim) break;
    li++;
  }
  level = levels[li];

  return { level, need, region };
}
