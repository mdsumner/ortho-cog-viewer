/**
 * The warp engine: the source resampled onto the display grid, drawn as
 * one quad.
 *
 * Where the mesh engine places triangle corners exactly and lets the GPU
 * interpolate the texture between them, this engine asks a warper for the
 * value of every screen pixel. It is exact and it resamples (nearest,
 * bilinear, cubic, lanczos), and what it draws is a raster in the display
 * CRS. It costs a warp per view change, which runs in a worker; while that
 * is in flight the last warp is drawn where it belongs, so panning slides
 * it and the new one lands a moment later.
 *
 *   layout()   place the quad; nothing to compute
 *   refresh()  plan, fetch, warp, upload
 *   draw()     the quad, through the same shader as the mesh engine, so
 *              palettes, hillshade, nodata and alpha are identical
 */
import { MeshRenderer } from './MeshRenderer';
import { LayerEngine, RenderContext, Style, EngineStatus, View } from './types';
import { RasterSource, FloatStats, planFetch } from '../core/source';
import { SourceBounds } from '../core/bounds';
import { colormapBytes } from '../core/colormap';
import { crsDefinition } from '../core/crs';
import { geoTransform } from '../core/transform';
import { ResampleAlg, WarpJob } from '../core/warp';
import { warpInWorker, WarpOutcome } from './warpClient';
import proj4 from 'proj4';

const MAX_TEXTURE_DIM = 4096;

export interface WarpOptions {
  alg: ResampleAlg;
  /** warp pixels per screen pixel: 1 is exact, 0.5 is four times faster */
  scale: number;
  prefer: 'rwarp' | 'reference';
  /** approximate-transformer threshold in source pixels; 0 is exact */
  maxError: number;
}

/** The rectangle a warp was made for, in its display CRS. */
interface WarpRect { crs: string; minX: number; minY: number; maxX: number; maxY: number; }

export class WarpEngine implements LayerEngine {
  readonly kind = 'warp';

  private renderer: MeshRenderer;
  private onChange: () => void;
  private opts: WarpOptions;

  private rect: WarpRect | null = null;
  private hasTexture = false;
  private loading = false;
  private seq = 0;
  private stats: FloatStats | null = null;
  private texSize = '';
  private level = -1;
  private lastKey = '';
  private lastOutcome: WarpOutcome | null = null;
  private lastError = '';
  private disposed = false;

  constructor(
    gl: WebGL2RenderingContext,
    readonly source: RasterSource,
    style: Style,
    onChange: () => void,
    opts: WarpOptions
  ) {
    this.renderer = new MeshRenderer(gl);
    this.onChange = onChange;
    this.opts = opts;
    this.setStyle(style);
  }

  setOptions(opts: WarpOptions): void {
    this.opts = opts;
    this.lastKey = '';
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

  /** The quad: the warp's own rectangle, wherever the camera is now. */
  layout(_ctx: RenderContext): void {
    const r = this.rect;
    if (!r) return;
    // A warp made in another CRS (centred mode re-centred) has no place in
    // this one; keep drawing it where it was, the refresh replaces it.
    this.setQuad(r);
  }

  private setQuad(r: WarpRect): void {
    const positions = new Float32Array([
      r.minX, r.minY, 0,  r.maxX, r.minY, 0,  r.maxX, r.maxY, 0,
      r.minX, r.minY, 0,  r.maxX, r.maxY, 0,  r.minX, r.maxY, 0
    ]);
    const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]);
    this.renderer.setWrapU(false);
    this.renderer.setMesh({ positions, texCoords: uv, indices: new Uint32Array([0, 1, 2, 3, 4, 5]) });
  }

  async refresh(ctx: RenderContext): Promise<void> {
    const { view } = ctx;
    const scale = Math.max(0.1, Math.min(2, this.opts.scale));
    const W = Math.max(1, Math.round(view.width * scale));
    const H = Math.max(1, Math.round(view.height * scale));
    // display units per warp pixel
    const res = 1 / (Math.pow(2, view.zoom) * scale);
    const rect: WarpRect = {
      crs: view.crs,
      minX: view.centreX - W / 2 * res, maxX: view.centreX + W / 2 * res,
      minY: view.centreY - H / 2 * res, maxY: view.centreY + H / 2 * res
    };
    const key = `${view.crs}|${rect.minX.toFixed(3)},${rect.minY.toFixed(3)},${W},${H}|${this.opts.alg}|${this.opts.prefer}|${this.opts.maxError}`;
    // Same view as the last warp, or one already in flight for it: nothing to do.
    if (key === this.lastKey && (this.hasTexture || this.loading)) return;
    const seq = ++this.seq;
    this.lastKey = key;
    this.loading = true;
    this.lastError = '';
    this.onChange();
    try {
      // What the screen needs from the source: the screen sampled to the
      // source CRS (through whichever executor the display CRS has).
      const need = await this.needFromSource(view, rect);
      if (seq !== this.seq) return;
      if (!need) {
        this.lastError = 'the view is entirely off the source';
        return;
      }
      const plan = planFetch(this.source, need, { w: W, h: H }, MAX_TEXTURE_DIM, 0.05);
      if (!plan) {
        this.lastError = 'nothing to fetch';
        return;
      }
      const data = await this.source.fetch(plan.level.index, plan.region, MAX_TEXTURE_DIM);
      if (seq !== this.seq) return;
      const b = data.bounds;
      const sw = data.float ? data.float.width : data.rgba!.width;
      const sh = data.float ? data.float.height : data.rgba!.height;
      const srcGt = new Float64Array([b.minX, (b.maxX - b.minX) / sw, 0, b.maxY, 0, -(b.maxY - b.minY) / sh]);
      const dstGt = new Float64Array([rect.minX, res, 0, rect.maxY, 0, -res]);
      const srcDef = crsDefinition(this.source.crs) ?? this.source.crs;
      const dstDef = crsDefinition(view.crs) ?? view.crs;
      const job: WarpJob = {
        srcCrs: srcDef, srcGt, srcW: sw, srcH: sh,
        dstCrs: dstDef, dstGt, dstW: W, dstH: H,
        alg: this.opts.alg,
        maxError: this.opts.maxError,
        nodata: data.float ? data.float.nodata : null
      };
      if (data.float) {
        if (data.float.channels !== 1) throw new Error('warp engine: multi-band float not supported yet');
        job.float = data.float.data;
      } else {
        job.rgba = data.rgba!.data;
      }
      const out = await warpInWorker(job, this.opts.prefer);
      if (seq !== this.seq || this.disposed) return;
      this.lastOutcome = out;
      this.level = plan.level.index;
      this.texSize = `${W}x${H}`;
      if (out.float) {
        this.stats = data.float!.stats;
        this.renderer.updateFloatTexture(out.float, W, H, job.nodata, 1);
        // Warped pixels are square in display units, which makes hillshade
        // honest: one texel is res by res metres (for a metric display CRS).
        this.renderer.setTexelGeometry(W, H, res, res, false, 0, 0);
      } else if (out.rgba) {
        this.renderer.updateTexture({ data: out.rgba, width: W, height: H });
      }
      this.rect = rect;
      this.setQuad(rect);
      this.hasTexture = true;
    } catch (err) {
      this.lastError = String((err as Error).message ?? err);
      console.error('warp failed:', err);
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.onChange();
      }
    }
  }

  /** Source-CRS bbox of the screen rectangle, or null if none of it lands. */
  private async needFromSource(view: View, rect: WarpRect): Promise<SourceBounds | null> {
    const n = 12;
    const xy = new Float64Array((n + 1) * (n + 1) * 2);
    let k = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        xy[k++] = rect.minX + (rect.maxX - rect.minX) * i / n;
        xy[k++] = rect.minY + (rect.maxY - rect.minY) * j / n;
      }
    }
    const ll = await geoTransform(view.crs).toGeo(xy);
    const toSrc = proj4('EPSG:4326', this.source.crs);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < ll.length; i += 2) {
      const lon = ll[i], lat = ll[i + 1];
      if (!isFinite(lon) || !isFinite(lat)) continue;
      try {
        const [sx, sy] = toSrc.forward([lon, lat]);
        if (!isFinite(sx) || !isFinite(sy)) continue;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      } catch {
        // off the source
      }
    }
    if (!isFinite(minX)) return null;
    // A view straddling the antimeridian of a global source needs all of it.
    if (this.source.wrapU) {
      const b = this.source.bounds;
      if (maxX - minX > (b.maxX - b.minX) * 0.5) { minX = b.minX; maxX = b.maxX; }
    }
    return { minX, minY, maxX, maxY };
  }

  invalidate(): void {
    this.hasTexture = false;
    this.lastKey = '';
    this.seq++;
  }

  draw(ctx: RenderContext): void {
    if (!this.hasTexture || !this.rect) return;
    const { view } = ctx;
    this.renderer.renderWithViewport(view.centreX, view.centreY, view.zoom, view.width, view.height);
  }

  drawWireframe(ctx: RenderContext, colour: [number, number, number, number]): void {
    if (!this.hasTexture) return;
    const { view } = ctx;
    this.renderer.renderWireframe(view.centreX, view.centreY, view.zoom, colour);
  }

  status(): EngineStatus {
    return {
      hasTexture: this.hasTexture,
      loading: this.loading,
      level: this.level,
      textureSize: this.texSize,
      validFraction: this.hasTexture ? 1 : 0,
      stats: this.stats
    };
  }

  /** A line for the layer's caption: which backend, how long, or why not. */
  describe(): string {
    if (this.lastError) return `warp: ${this.lastError}`;
    const o = this.lastOutcome;
    if (!o) return this.loading ? 'warp: working...' : 'warp: not yet';
    const via = o.backend === 'rwarp' ? 'rwarp' : `reference${o.note ? ' (' + o.note + ')' : ''}`;
    return `warp: ${via}, ${this.opts.alg}, ${this.texSize} in ${Math.round(o.ms)} ms`;
  }

  dispose(): void {
    this.disposed = true;
    this.seq++;
    this.renderer.dispose();
  }
}
