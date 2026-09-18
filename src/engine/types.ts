/**
 * The seam between the viewer shell and whatever actually draws a layer.
 *
 * The shell owns the view, the layer list, styling state and the UI. An
 * engine owns one layer's pixels: it reads from a RasterSource and puts
 * something on the screen for the current view. Two engines are envisaged:
 *
 *   mesh   Source stays in its own CRS as a texture; a screen-aligned grid
 *          carries the reprojection in its UVs, interpolated by the GPU.
 *          Approximate, no resampling, free while panning.
 *
 *   warp   A real warp (rwarp/GDAL pipeline in wasm) resamples the source
 *          into a raster on the display grid, drawn as a single quad.
 *          Exact and resampled, but costs work per view change.
 *
 * Both read through the same RasterSource and are styled by the same Style,
 * so everything above this interface - palettes, rescaling, hillshade,
 * nodata, alpha, the layer list, URL state - is engine-agnostic.
 *
 * The three verbs are separated by what they cost:
 *   layout()   every view change; cheap (mesh: recompute UVs)
 *   refresh()  debounced; may fetch or warp
 *   draw()     every frame
 */

import { GridMesh } from './mesh';
import { RasterSource, FloatStats } from '../core/source';

export type Curve = 'linear' | 'sqrt' | 'log';

/** What the shell is looking at, in display space. */
export interface View {
  /** Display CRS, already instantiated (never a {lon_0} template). */
  crs: string;
  /** Camera centre in display CRS units. */
  centreX: number;
  centreY: number;
  /** log2 of screen pixels per display unit. */
  zoom: number;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
}

/**
 * A view plus the screen-aligned grid the shell built for it, in display
 * coordinates. An engine that builds its own geometry ignores the grid.
 */
export interface RenderContext {
  view: View;
  grid: GridMesh;
}

/**
 * How a layer is turned into colour. Every field is a shader uniform in the
 * mesh engine, which is why changing any of them costs nothing.
 */
export interface Style {
  mode: 'single' | 'rgb';
  min: number;
  max: number;
  cmap: string;
  curve: Curve;
  nodata: number | null;
  shade: boolean;
  shadeStrength: number;
  zfactor: number;
  azimuth: number;
  altitude: number;
  opacity: number;
}

export function defaultStyle(): Style {
  return {
    mode: 'single', min: 0, max: 1, cmap: 'viridis', curve: 'linear',
    nodata: null, shade: false, shadeStrength: 0.6, zfactor: 1,
    azimuth: 315, altitude: 45, opacity: 1
  };
}

/** What the shell needs to report about a layer. */
export interface EngineStatus {
  hasTexture: boolean;
  loading: boolean;
  /** index into source.levels, or -1 */
  level: number;
  /** pixel dimensions of what is on the GPU, for display */
  textureSize: string;
  /** fraction of the view's vertices that landed on the globe */
  validFraction: number;
  /** statistics of the numeric data currently loaded, if any */
  stats: FloatStats | null;
}

export interface LayerEngine {
  readonly kind: string;
  readonly source: RasterSource;

  /** Uniforms only; never refetches. */
  setStyle(style: Style): void;

  /** Recompute geometry for this view. Called on every view change. */
  layout(ctx: RenderContext): void;

  /** Ensure the pixels on the GPU suit this view. Debounced by the shell. */
  refresh(ctx: RenderContext): Promise<void>;

  /** Drop cached pixels so the next refresh() reads again (band changes). */
  invalidate(): void;

  draw(ctx: RenderContext): void;
  drawWireframe(ctx: RenderContext, colour: [number, number, number, number]): void;

  status(): EngineStatus;
  dispose(): void;
}
