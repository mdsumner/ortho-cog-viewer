/**
 * Mesh engine: the reprojection this viewer was built around.
 *
 * The source texture stays in the source CRS. A screen-aligned grid in
 * display space carries the warp in its UV coordinates, computed by
 * inverse-projecting each vertex, and the GPU interpolates linearly within
 * each triangle. Panning costs one proj4 round trip per vertex; nothing is
 * resampled and nothing is refetched until the view leaves the region on
 * the GPU.
 */

import { MeshRenderer } from './MeshRenderer';
import { buildLayerGeometry } from './uv';
import { LayerEngine, RenderContext, Style, EngineStatus } from './types';
import { SourceBounds } from '../core/bounds';
import { RasterSource, FloatStats, planFetch, contains } from '../core/source';
import { colormapBytes } from '../core/colormap';

const MAX_TEXTURE_DIM = 4096;

export class MeshEngine implements LayerEngine {
  readonly kind = 'mesh';

  private renderer: MeshRenderer;
  private onChange: () => void;

  /** extent of the texture currently on the GPU, in source CRS */
  private texBounds: SourceBounds;
  private texLevel = -1;
  private texSize = '';
  private hasTexture = false;
  private loading = false;
  private fetchSeq = 0;
  /** the request in flight, so an identical plan is not issued twice */
  private pending: { level: number; region: SourceBounds } | null = null;
  private validFraction = 0;
  private stats: FloatStats | null = null;
  /** what the last layout() said the view needs from the source */
  private needBBox: SourceBounds | null = null;
  private needPx: { w: number; h: number } | null = null;

  constructor(
    gl: WebGL2RenderingContext,
    readonly source: RasterSource,
    style: Style,
    onChange: () => void
  ) {
    this.renderer = new MeshRenderer(gl);
    this.texBounds = { ...source.bounds };
    this.onChange = onChange;
    this.setStyle(style);
  }

  setStyle(style: Style): void {
    this.renderer.setOpacity(style.opacity);
    if (!this.source.numeric) return;
    this.renderer.setRange(style.min, style.max);
    this.renderer.setColormap(colormapBytes(style.cmap));
    this.renderer.setCurve(style.curve);
    this.renderer.setNodata(style.nodata);
    this.renderer.setHillshade(
      style.shade, style.shadeStrength, style.zfactor, style.azimuth, style.altitude);
  }

  /**
   * u is periodic only when the source is periodic AND the texture on the
   * GPU spans the source's full width.
   */
  private textureWrapsU(): boolean {
    if (!this.source.wrapU) return false;
    const full = this.source.bounds.maxX - this.source.bounds.minX;
    const tex = this.texBounds.maxX - this.texBounds.minX;
    return tex >= full * 0.999;
  }

  layout(ctx: RenderContext): void {
    const { view, grid } = ctx;
    const wrapU = this.textureWrapsU();
    // Round-trip tolerance: a small fraction of one mesh cell.
    const cell = Math.abs(grid.positions[3] - grid.positions[0]) || 1;
    const geom = buildLayerGeometry(
      grid.positions,
      grid.indices,
      view.crs,
      this.source.crs,
      this.texBounds,
      cell * 1e-2,
      wrapU,
      ctx.wrap
    );
    this.validFraction = geom.validFraction;
    this.needBBox = geom.sourceBBox;
    if (geom.displayBBox) {
      const scale = Math.pow(2, view.zoom);
      this.needPx = {
        w: Math.max(1, (geom.displayBBox.maxX - geom.displayBBox.minX) * scale),
        h: Math.max(1, (geom.displayBBox.maxY - geom.displayBBox.minY) * scale)
      };
    } else {
      this.needPx = null;
    }
    this.renderer.setWrapU(wrapU);
    this.renderer.setMesh({
      positions: geom.positions,
      texCoords: geom.texCoords,
      indices: geom.indices
    });
  }

  async refresh(ctx: RenderContext): Promise<void> {
    const plan = planFetch(this.source, this.needBBox, this.needPx, MAX_TEXTURE_DIM);
    if (!plan) return;

    if (this.hasTexture && plan.level.index === this.texLevel && contains(this.texBounds, plan.need)) {
      return;  // current texture already covers the need at the right level
    }
    if (this.pending && this.pending.level === plan.level.index && contains(this.pending.region, plan.need)) {
      return;  // a request that will cover it is already in flight
    }

    const seq = ++this.fetchSeq;
    this.pending = { level: plan.level.index, region: plan.region };
    this.loading = true;
    this.onChange();
    try {
      const data = await this.source.fetch(plan.level.index, plan.region, MAX_TEXTURE_DIM);
      if (seq !== this.fetchSeq) return;  // superseded
      this.texBounds = data.bounds;
      this.texLevel = plan.level.index;
      if (data.float) {
        const f = data.float;
        this.texSize = `${f.width}x${f.height}`;
        this.stats = f.stats;
        this.renderer.updateFloatTexture(f.data, f.width, f.height, f.nodata, f.channels);
        const b = data.bounds;
        const geo = /4326|4269|longlat/.test(this.source.crs);
        const k = geo ? 111319.49 : 1;   // degrees -> metres (x scaled by cos(lat) in the shader)
        this.renderer.setTexelGeometry(
          f.width, f.height,
          (b.maxX - b.minX) / f.width * k,
          (b.maxY - b.minY) / f.height * k,
          geo, b.minY, b.maxY
        );
      } else if (data.canvas) {
        this.texSize = `${data.canvas.width}x${data.canvas.height}`;
        this.renderer.updateTexture(data.canvas);
      }
      this.hasTexture = true;
      this.layout(ctx);   // UVs are relative to the new texture bounds
      this.onChange();
    } catch (err) {
      console.error('Failed to fetch texture:', err);
    } finally {
      if (seq === this.fetchSeq) {
        this.pending = null;
        this.loading = false;
        this.onChange();
      }
    }
  }

  invalidate(): void {
    this.hasTexture = false;
    this.texLevel = -1;
    this.fetchSeq++;      // drop anything in flight
    this.pending = null;
  }

  draw(ctx: RenderContext): void {
    const { view } = ctx;
    this.renderer.renderWithViewport(
      view.centreX, view.centreY, view.zoom, view.width, view.height);
  }

  drawWireframe(ctx: RenderContext, colour: [number, number, number, number]): void {
    const { view } = ctx;
    this.renderer.renderWireframe(view.centreX, view.centreY, view.zoom, colour);
  }

  status(): EngineStatus {
    return {
      hasTexture: this.hasTexture,
      loading: this.loading,
      level: this.texLevel,
      textureSize: this.texSize,
      validFraction: this.validFraction,
      stats: this.stats
    };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
