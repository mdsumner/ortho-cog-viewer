/**
 * COG raster source: overviews are the levels, and a texture is a windowed
 * read of one overview, snapped to that overview's internal tile grid so
 * geotiff.js only fetches the tiles that intersect the window.
 */

import { fromUrl, GeoTIFF, GeoTIFFImage } from 'geotiff';
import { RasterSource, SourceLevel, TextureData } from './source';
import { SourceBounds } from './uv';
import { ensureCRS } from './crs';

// One open handle per URL; the promise is cached so concurrent opens share it.
const tiffCache = new Map<string, Promise<GeoTIFF>>();

function getTiff(url: string): Promise<GeoTIFF> {
  let p = tiffCache.get(url);
  if (!p) {
    p = fromUrl(url);
    tiffCache.set(url, p);
    p.catch(() => tiffCache.delete(url));
  }
  return p;
}

function parseCRSFromGeoKeys(geoKeys: Record<string, number>): string | null {
  if (geoKeys.ProjectedCSTypeGeoKey && geoKeys.ProjectedCSTypeGeoKey !== 32767) {
    return `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
  }
  if (geoKeys.GeographicTypeGeoKey && geoKeys.GeographicTypeGeoKey !== 32767) {
    return `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  }
  return null;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Interleaved samples -> RGBA canvas. Bands beyond the first three are
 * ignored except a fourth, which is taken as alpha. Single band is grey.
 */
function toCanvas(data: ArrayLike<number>, width: number, height: number, spp: number): HTMLCanvasElement {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const n = width * height;
  if (spp >= 3) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4 + 0] = clampByte(data[i * spp + 0]);
      rgba[i * 4 + 1] = clampByte(data[i * spp + 1]);
      rgba[i * 4 + 2] = clampByte(data[i * spp + 2]);
      rgba[i * 4 + 3] = spp >= 4 ? clampByte(data[i * spp + 3]) : 255;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = clampByte(data[i * spp]);
      rgba[i * 4 + 0] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return c;
}

export class COGSource implements RasterSource {
  readonly kind = 'cog' as const;
  readonly label: string;
  readonly crs: string;
  readonly bounds: SourceBounds;
  readonly levels: SourceLevel[];
  readonly wrapU: boolean;
  readonly samplesPerPixel: number;

  private constructor(
    private url: string,
    crs: string,
    bounds: SourceBounds,
    levels: SourceLevel[],
    spp: number
  ) {
    this.label = url.split('/').pop() || url;
    this.crs = crs;
    this.bounds = bounds;
    this.levels = levels;
    this.samplesPerPixel = spp;
    const geographic = /^EPSG:4326$|^EPSG:4269$|\+proj=longlat/.test(crs);
    this.wrapU = geographic && (bounds.maxX - bounds.minX) >= 359.9;
  }

  static async open(url: string): Promise<COGSource> {
    const tiff = await getTiff(url);
    const image = await tiff.getImage();
    const crs = parseCRSFromGeoKeys(image.getGeoKeys());
    if (!crs) throw new Error('COG has no CRS information');
    if (!ensureCRS(crs)) {
      throw new Error(`Source CRS ${crs} is not registered in crs.ts (UTM zones are synthesised; other EPSG codes need a def)`);
    }
    const bbox = image.getBoundingBox();
    const bounds = { minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3] };

    const count = await tiff.getImageCount();
    const levels: SourceLevel[] = [];
    for (let i = 0; i < count; i++) {
      const img = await tiff.getImage(i);
      const w = img.getWidth(), h = img.getHeight();
      levels.push({ index: i, resolution: (bounds.maxX - bounds.minX) / w, width: w, height: h });
    }
    levels.sort((a, b) => a.resolution - b.resolution);
    return new COGSource(url, crs, bounds, levels, image.getSamplesPerPixel());
  }

  async fetch(level: number, region: SourceBounds, maxDim: number): Promise<TextureData> {
    const tiff = await getTiff(this.url);
    const image: GeoTIFFImage = await tiff.getImage(level);
    const W = image.getWidth(), H = image.getHeight();
    const { minX, minY, maxX, maxY } = this.bounds;
    const resX = (maxX - minX) / W;
    const resY = (maxY - minY) / H;

    // Pixel window (row 0 is the top / maxY), snapped to the tile grid
    const tw = image.getTileWidth() || 256;
    const th = image.getTileHeight() || 256;
    let x0 = Math.floor((region.minX - minX) / resX);
    let x1 = Math.ceil((region.maxX - minX) / resX);
    let y0 = Math.floor((maxY - region.maxY) / resY);
    let y1 = Math.ceil((maxY - region.minY) / resY);
    x0 = Math.max(0, Math.floor(x0 / tw) * tw);
    y0 = Math.max(0, Math.floor(y0 / th) * th);
    x1 = Math.min(W, Math.ceil(x1 / tw) * tw);
    y1 = Math.min(H, Math.ceil(y1 / th) * th);
    if (x1 <= x0 || y1 <= y0) {
      x0 = 0; y0 = 0; x1 = W; y1 = H;
    }

    // Downsample on read if the window is still too big for a texture
    const winW = x1 - x0, winH = y1 - y0;
    const scale = Math.min(1, maxDim / winW, maxDim / winH);
    const outW = Math.max(1, Math.round(winW * scale));
    const outH = Math.max(1, Math.round(winH * scale));

    const opts: Record<string, unknown> = { window: [x0, y0, x1, y1], interleave: true };
    if (scale < 1) {
      opts.width = outW;
      opts.height = outH;
      opts.resampleMethod = 'nearest';
    }
    console.log(`COG fetch level ${level} window [${x0},${y0},${x1},${y1}] -> ${outW}x${outH}`);
    const rasters = await image.readRasters(opts as any);
    const data = rasters as unknown as ArrayLike<number>;
    const canvas = toCanvas(data, outW, outH, image.getSamplesPerPixel());

    return {
      canvas,
      bounds: {
        minX: minX + x0 * resX,
        maxX: minX + x1 * resX,
        maxY: maxY - y0 * resY,
        minY: maxY - y1 * resY
      }
    };
  }
}
