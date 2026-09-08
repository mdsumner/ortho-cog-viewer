/**
 * XYZ / WMTS tile pyramid as a raster source.
 *
 * A tile matrix set is described by its CRS, the top-left origin, the tile
 * size, the number of columns/rows at level 0 and the resolution at level 0;
 * every further level halves the resolution. That covers the Web Mercator
 * "GoogleMapsCompatible" set and the EPSG:4326 sets used by NASA GIBS, which
 * is enough to make the point: a tile pyramid is a source image with a
 * built-in overview stack, and the viewer treats it exactly like a COG.
 *
 * URL templates use {z}, {x}, {y} (and {-y} for TMS row order).
 */

import { RasterSource, SourceLevel, TextureData } from './source';
import { SourceBounds } from './uv';

export interface TileScheme {
  crs: string;
  originX: number;
  originY: number;      // top edge
  tileSize: number;
  cols0: number;
  rows0: number;
  res0: number;         // source units per pixel at level 0
  maxLevel: number;
  wrapU: boolean;
}

const MERC = 20037508.342789244;

export const SCHEMES: Record<string, TileScheme> = {
  // Web Mercator, 256px tiles, one tile at z0
  GoogleMapsCompatible: {
    crs: 'EPSG:3857', originX: -MERC, originY: MERC, tileSize: 256,
    cols0: 1, rows0: 1, res0: 2 * MERC / 256, maxLevel: 22, wrapU: true
  },
  // NASA GIBS EPSG:4326 sets: 512px tiles, 2x1 at z0; the name gives the
  // finest level. "2km" has 4 levels (0-3), "1km" 5, "500m" 6, "250m" 7.
  GIBS4326_2km:  { crs: 'EPSG:4326', originX: -180, originY: 90, tileSize: 512, cols0: 2, rows0: 1, res0: 0.5625, maxLevel: 3, wrapU: true },
  GIBS4326_1km:  { crs: 'EPSG:4326', originX: -180, originY: 90, tileSize: 512, cols0: 2, rows0: 1, res0: 0.5625, maxLevel: 4, wrapU: true },
  GIBS4326_500m: { crs: 'EPSG:4326', originX: -180, originY: 90, tileSize: 512, cols0: 2, rows0: 1, res0: 0.5625, maxLevel: 5, wrapU: true },
  GIBS4326_250m: { crs: 'EPSG:4326', originX: -180, originY: 90, tileSize: 512, cols0: 2, rows0: 1, res0: 0.5625, maxLevel: 6, wrapU: true }
};

export interface TilePreset {
  label: string;
  template: string;
  scheme: string;        // key into SCHEMES
  maxLevel?: number;     // override the scheme's
  attribution: string;
}

export const TILE_PRESETS: Record<string, TilePreset> = {
  osm: {
    label: 'OpenStreetMap',
    template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    scheme: 'GoogleMapsCompatible', maxLevel: 19,
    attribution: '(c) OpenStreetMap contributors'
  },
  'esri-imagery': {
    label: 'Esri World Imagery',
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    scheme: 'GoogleMapsCompatible', maxLevel: 19,
    attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  },
  'gibs-bluemarble-3857': {
    label: 'GIBS Blue Marble (EPSG:3857)',
    template: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    scheme: 'GoogleMapsCompatible', maxLevel: 8,
    attribution: 'NASA GIBS'
  },
  'gibs-modis-truecolor': {
    label: 'GIBS MODIS Terra true colour 2024-12-04 (EPSG:4326)',
    template: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2024-12-04/250m/{z}/{y}/{x}.jpg',
    scheme: 'GIBS4326_250m',
    attribution: 'NASA GIBS'
  },
  'gibs-seaice-3857': {
    label: 'GIBS AMSR2 sea ice concentration 2024-12-04 (EPSG:3857)',
    template: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/AMSRU2_Sea_Ice_Concentration_12km/default/2024-12-04/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
    scheme: 'GoogleMapsCompatible', maxLevel: 6,
    attribution: 'NASA GIBS, JAXA AMSR2'
  }
};

export function isTileTemplate(url: string): boolean {
  return /\{z\}/.test(url) && /\{x\}/.test(url) && /\{-?y\}/.test(url);
}

/**
 * Guess a scheme from a template we have not seen before.
 */
export function guessScheme(template: string): { scheme: TileScheme; maxLevel: number } {
  for (const p of Object.values(TILE_PRESETS)) {
    if (p.template === template) {
      const s = SCHEMES[p.scheme];
      return { scheme: s, maxLevel: p.maxLevel ?? s.maxLevel };
    }
  }
  const m = /\/epsg4326\/.*\/(2km|1km|500m|250m)\//.exec(template);
  if (m) {
    const s = SCHEMES[`GIBS4326_${m[1]}`];
    return { scheme: s, maxLevel: s.maxLevel };
  }
  const lvl = /GoogleMapsCompatible_Level(\d+)/.exec(template);
  const s = SCHEMES.GoogleMapsCompatible;
  return { scheme: s, maxLevel: lvl ? parseInt(lvl[1]) : 18 };
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export class XYZSource implements RasterSource {
  readonly kind = 'xyz' as const;
  readonly label: string;
  readonly crs: string;
  readonly bounds: SourceBounds;
  readonly levels: SourceLevel[];
  readonly wrapU: boolean;
  readonly attribution?: string;

  constructor(
    private template: string,
    private scheme: TileScheme,
    maxLevel: number,
    label?: string,
    attribution?: string
  ) {
    this.label = label || template.replace(/^https?:\/\//, '').split('/')[0];
    this.crs = scheme.crs;
    this.attribution = attribution;
    this.wrapU = scheme.wrapU;
    const w = scheme.cols0 * scheme.tileSize * scheme.res0;
    const h = scheme.rows0 * scheme.tileSize * scheme.res0;
    this.bounds = { minX: scheme.originX, maxX: scheme.originX + w, maxY: scheme.originY, minY: scheme.originY - h };
    this.levels = [];
    for (let z = 0; z <= maxLevel; z++) {
      const f = Math.pow(2, z);
      this.levels.push({
        index: z,
        resolution: scheme.res0 / f,
        width: scheme.cols0 * scheme.tileSize * f,
        height: scheme.rows0 * scheme.tileSize * f
      });
    }
    this.levels.sort((a, b) => a.resolution - b.resolution);
  }

  static fromTemplate(template: string): XYZSource {
    const preset = Object.values(TILE_PRESETS).find(p => p.template === template);
    const { scheme, maxLevel } = guessScheme(template);
    return new XYZSource(template, scheme, maxLevel, preset?.label, preset?.attribution);
  }

  static fromPreset(name: string): XYZSource {
    const p = TILE_PRESETS[name];
    if (!p) throw new Error(`Unknown tile preset ${name}`);
    const s = SCHEMES[p.scheme];
    return new XYZSource(p.template, s, p.maxLevel ?? s.maxLevel, p.label, p.attribution);
  }

  private tileUrl(z: number, x: number, y: number): string {
    const rows = this.scheme.rows0 * Math.pow(2, z);
    return this.template
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{-y}', String(rows - 1 - y))
      .replace('{y}', String(y));
  }

  async fetch(level: number, region: SourceBounds, maxDim: number): Promise<TextureData> {
    const s = this.scheme;
    const f = Math.pow(2, level);
    const cols = s.cols0 * f, rows = s.rows0 * f;
    const span = s.tileSize * s.res0 / f;   // tile size in source units

    let c0 = Math.floor((region.minX - s.originX) / span);
    let c1 = Math.floor((region.maxX - s.originX - 1e-9) / span);
    let r0 = Math.floor((s.originY - region.maxY) / span);
    let r1 = Math.floor((s.originY - region.minY - 1e-9) / span);
    c0 = Math.max(0, Math.min(cols - 1, c0));
    c1 = Math.max(c0, Math.min(cols - 1, c1));
    r0 = Math.max(0, Math.min(rows - 1, r0));
    r1 = Math.max(r0, Math.min(rows - 1, r1));

    // Never exceed maxDim: trim the range around its centre
    const maxTiles = Math.max(1, Math.floor(maxDim / s.tileSize));
    if (c1 - c0 + 1 > maxTiles) {
      const mid = Math.floor((c0 + c1) / 2);
      c0 = mid - Math.floor(maxTiles / 2);
      c1 = c0 + maxTiles - 1;
    }
    if (r1 - r0 + 1 > maxTiles) {
      const mid = Math.floor((r0 + r1) / 2);
      r0 = mid - Math.floor(maxTiles / 2);
      r1 = r0 + maxTiles - 1;
    }

    const nx = c1 - c0 + 1, ny = r1 - r0 + 1;
    const canvas = document.createElement('canvas');
    canvas.width = nx * s.tileSize;
    canvas.height = ny * s.tileSize;
    const ctx = canvas.getContext('2d')!;

    console.log(`XYZ fetch z${level} cols ${c0}-${c1} rows ${r0}-${r1} (${nx * ny} tiles)`);
    const jobs: Promise<void>[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        jobs.push(loadImage(this.tileUrl(level, c, r)).then(img => {
          if (img) ctx.drawImage(img, (c - c0) * s.tileSize, (r - r0) * s.tileSize, s.tileSize, s.tileSize);
        }));
      }
    }
    await Promise.all(jobs);

    return {
      canvas,
      bounds: {
        minX: s.originX + c0 * span,
        maxX: s.originX + (c1 + 1) * span,
        maxY: s.originY - r0 * span,
        minY: s.originY - (r1 + 1) * span
      }
    };
  }
}
