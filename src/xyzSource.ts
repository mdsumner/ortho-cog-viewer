/**
 * Tile pyramid (XYZ / WMTS) as a raster source.
 *
 * A tile matrix set is a list of levels, each with its own origin,
 * resolution, tile size and matrix size (WMTS TileMatrix). The built-in
 * schemes (Web Mercator "GoogleMapsCompatible", the NASA GIBS EPSG:4326
 * sets) are generated into that same shape, and a WMTS GetCapabilities
 * document is parsed into it (wmts.ts). Either way a tile pyramid is just a
 * source image with a built-in overview stack, and the viewer treats it
 * exactly like a COG.
 *
 * URL templates use {z}, {x}, {y} (and {-y} for TMS row order). {z} is
 * replaced by the matrix identifier, which is not always an integer.
 */

import { RasterSource, SourceLevel, TextureData, intersect } from './source';
import { SourceBounds } from './uv';
import { TileMatrix, TileMatrixSetDef, loadWMTS, splitCapabilitiesUrl } from './wmts';

const MERC = 20037508.342789244;

function pyramid(
  id: string, crs: string, originX: number, originY: number, tileSize: number,
  cols0: number, rows0: number, res0: number, maxLevel: number
): TileMatrixSetDef {
  const matrices: TileMatrix[] = [];
  for (let z = 0; z <= maxLevel; z++) {
    const f = Math.pow(2, z);
    matrices.push({
      id: String(z), resolution: res0 / f, topLeftX: originX, topLeftY: originY,
      tileW: tileSize, tileH: tileSize, matrixW: cols0 * f, matrixH: rows0 * f
    });
  }
  matrices.sort((a, b) => a.resolution - b.resolution);
  return { id, crs, matrices };
}

export const SCHEMES: Record<string, (maxLevel?: number) => TileMatrixSetDef> = {
  GoogleMapsCompatible: (max = 22) =>
    pyramid('GoogleMapsCompatible', 'EPSG:3857', -MERC, MERC, 256, 1, 1, 2 * MERC / 256, max),
  // NASA GIBS EPSG:4326 sets: 512px tiles, 2x1 at z0. The name gives the
  // finest level: "2km" 0-3, "1km" 0-4, "500m" 0-5, "250m" 0-6.
  GIBS4326_2km:  () => pyramid('2km',  'EPSG:4326', -180, 90, 512, 2, 1, 0.5625, 3),
  GIBS4326_1km:  () => pyramid('1km',  'EPSG:4326', -180, 90, 512, 2, 1, 0.5625, 4),
  GIBS4326_500m: () => pyramid('500m', 'EPSG:4326', -180, 90, 512, 2, 1, 0.5625, 5),
  GIBS4326_250m: () => pyramid('250m', 'EPSG:4326', -180, 90, 512, 2, 1, 0.5625, 6)
};

export interface TilePreset {
  label: string;
  template: string;      // {z}/{x}/{y} template, a GetCapabilities URL, or a COG URL (with styling fragment)
  scheme?: string;       // key into SCHEMES (ignored for capabilities and COG URLs)
  maxLevel?: number;
  attribution: string;
  cog?: boolean;
}

export const TILE_PRESETS: Record<string, TilePreset> = {
  'gebco-2024': {
    label: 'GEBCO 2024 bathymetry, hillshaded (COG, source.coop)',
    template: 'https://data.source.coop/alexgleith/gebco-2024/GEBCO_2024.tif#cmap=bathy&curve=sqrt&shade=0.7&zf=8',
    attribution: 'GEBCO Compilation Group (2024); COG by Alex Leith on source.coop',
    cog: true
  },
  'gebco-2024-dirt': {
    label: 'GEBCO 2024 with the DiRT palette (COG, source.coop)',
    template: 'https://data.source.coop/alexgleith/gebco-2024/GEBCO_2024.tif#cmap=dirt&shade=0.6&zf=8',
    attribution: 'GEBCO Compilation Group (2024); COG by Alex Leith on source.coop',
    cog: true
  },
  'mur-sst-20260829': {
    label: 'GHRSST MUR SST 2026-08-29, deg C (COG, source.coop)',
    template: 'https://data.source.coop/ausantarctic/ghrsst-mur-v2/2026/08/29/20260829090000-JPL-L4_GHRSST-SSTfnd-MUR-GLOB-v02.0-fv04.1_analysed_sst.tif#scale=0.001&offset=25&min=-2&max=32&cmap=turbo',
    attribution: 'JPL MUR SST v4.1 (NASA PO.DAAC); COG by ausantarctic on source.coop',
    cog: true
  },
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
  'list-aerial-2026': {
    label: 'LIST Tasmania aerial photo 2026 (WMTS capabilities)',
    template: 'https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps/AerialPhoto2026/MapServer/WMTS/1.0.0/WMTSCapabilities.xml',
    attribution: 'Land Tasmania, theLIST (c) State of Tasmania'
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
 * Guess a matrix set for a template we have not seen before.
 */
export function guessScheme(template: string): TileMatrixSetDef {
  for (const p of Object.values(TILE_PRESETS)) {
    if (p.template === template && p.scheme) return SCHEMES[p.scheme](p.maxLevel);
  }
  const m = /\/epsg4326\/.*\/(2km|1km|500m|250m)\//.exec(template);
  if (m) return SCHEMES[`GIBS4326_${m[1]}`]();
  const lvl = /GoogleMapsCompatible_Level(\d+)/.exec(template);
  return SCHEMES.GoogleMapsCompatible(lvl ? parseInt(lvl[1]) : 18);
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

/**
 * The valid extent of the CRS itself. Tile matrices are allowed to extend
 * past it (GIBS EPSG:4326 level 0 is 576 degrees wide), but nothing outside
 * it is data, and u can only wrap when the texture spans exactly the world.
 */
function worldExtent(crs: string): SourceBounds | null {
  if (crs === 'EPSG:4326' || crs === 'EPSG:4269') return { minX: -180, maxX: 180, minY: -90, maxY: 90 };
  if (crs === 'EPSG:3857') return { minX: -MERC, maxX: MERC, minY: -MERC, maxY: MERC };
  return null;
}

function matrixExtent(m: TileMatrix): SourceBounds {
  return {
    minX: m.topLeftX,
    maxX: m.topLeftX + m.matrixW * m.tileW * m.resolution,
    maxY: m.topLeftY,
    minY: m.topLeftY - m.matrixH * m.tileH * m.resolution
  };
}

export class XYZSource implements RasterSource {
  readonly kind = 'xyz' as const;
  readonly label: string;
  readonly crs: string;
  readonly bounds: SourceBounds;
  readonly levels: SourceLevel[];
  readonly wrapU: boolean;
  readonly attribution?: string;
  readonly numeric = false;

  constructor(
    private template: string,
    private tms: TileMatrixSetDef,
    label?: string,
    attribution?: string,
    layerBounds?: SourceBounds
  ) {
    this.label = label || template.replace(/^https?:\/\//, '').split('/')[0];
    this.crs = tms.crs;
    this.attribution = attribution;

    // Union of the matrix extents (Esri "028mm" sets crop each level to the
    // data), intersected with the layer's own bbox when the capabilities
    // gave one, so fetches never ask for tiles outside the data.
    let ext: SourceBounds | null = null;
    for (const m of tms.matrices) {
      const e = matrixExtent(m);
      ext = ext ? { minX: Math.min(ext.minX, e.minX), minY: Math.min(ext.minY, e.minY),
                    maxX: Math.max(ext.maxX, e.maxX), maxY: Math.max(ext.maxY, e.maxY) } : e;
    }
    const world = worldExtent(tms.crs);
    if (world) ext = intersect(ext!, world);
    this.bounds = layerBounds ? intersect(ext!, layerBounds) : ext!;

    const fullWidth = world ? world.maxX - world.minX : Infinity;
    this.wrapU = (this.bounds.maxX - this.bounds.minX) >= fullWidth * 0.999;

    this.levels = tms.matrices.map((m, i) => ({
      index: i,
      resolution: m.resolution,
      width: m.matrixW * m.tileW,
      height: m.matrixH * m.tileH
    }));
  }

  static fromTemplate(template: string): XYZSource {
    const preset = Object.values(TILE_PRESETS).find(p => p.template === template);
    return new XYZSource(template, guessScheme(template), preset?.label, preset?.attribution);
  }

  static async fromPreset(name: string): Promise<XYZSource> {
    const p = TILE_PRESETS[name];
    if (!p) throw new Error(`Unknown tile preset ${name}`);
    if (!p.scheme) return XYZSource.fromCapabilities(p.template, undefined, undefined, p.label, p.attribution);
    return new XYZSource(p.template, SCHEMES[p.scheme](p.maxLevel), p.label, p.attribution);
  }

  /**
   * From a WMTS GetCapabilities URL. Optional #layer=...&tms=... fragment on
   * the URL selects a layer and matrix set.
   */
  static async fromCapabilities(
    url: string, wantLayer?: string, wantTms?: string, label?: string, attribution?: string
  ): Promise<XYZSource> {
    const sel = splitCapabilitiesUrl(url);
    const w = await loadWMTS(sel.url, wantLayer || sel.layer, wantTms || sel.tms, sel.time);
    console.log(`WMTS layer ${w.layerId} on ${w.tms.id} (${w.tms.crs}, ${w.tms.matrices.length} levels)${sel.time ? ' time ' + sel.time : ''}`);
    const lbl = (label || w.title) + (sel.time ? ` ${sel.time}` : '');
    return new XYZSource(w.template, w.tms, lbl, attribution || w.attribution, w.bounds);
  }

  private tileUrl(m: TileMatrix, x: number, y: number): string {
    return this.template
      .replace('{z}', m.id)
      .replace('{x}', String(x))
      .replace('{-y}', String(m.matrixH - 1 - y))
      .replace('{y}', String(y));
  }

  async fetch(level: number, region: SourceBounds, maxDim: number): Promise<TextureData> {
    const m = this.tms.matrices[level];
    const spanX = m.tileW * m.resolution;
    const spanY = m.tileH * m.resolution;

    let c0 = Math.floor((region.minX - m.topLeftX) / spanX);
    let c1 = Math.floor((region.maxX - m.topLeftX - 1e-9) / spanX);
    let r0 = Math.floor((m.topLeftY - region.maxY) / spanY);
    let r1 = Math.floor((m.topLeftY - region.minY - 1e-9) / spanY);
    const minC = m.minCol ?? 0, maxC = m.maxCol ?? m.matrixW - 1;
    const minR = m.minRow ?? 0, maxR = m.maxRow ?? m.matrixH - 1;
    c0 = Math.max(minC, Math.min(maxC, c0));
    c1 = Math.max(c0, Math.min(maxC, c1));
    r0 = Math.max(minR, Math.min(maxR, r0));
    r1 = Math.max(r0, Math.min(maxR, r1));

    // Never exceed maxDim: trim the range around its centre
    const maxCols = Math.max(1, Math.floor(maxDim / m.tileW));
    const maxRows = Math.max(1, Math.floor(maxDim / m.tileH));
    if (c1 - c0 + 1 > maxCols) {
      const mid = Math.floor((c0 + c1) / 2);
      c0 = mid - Math.floor(maxCols / 2);
      c1 = c0 + maxCols - 1;
    }
    if (r1 - r0 + 1 > maxRows) {
      const mid = Math.floor((r0 + r1) / 2);
      r0 = mid - Math.floor(maxRows / 2);
      r1 = r0 + maxRows - 1;
    }

    const nx = c1 - c0 + 1, ny = r1 - r0 + 1;
    const canvas = document.createElement('canvas');
    canvas.width = nx * m.tileW;
    canvas.height = ny * m.tileH;
    const ctx = canvas.getContext('2d')!;

    console.log(`XYZ fetch ${m.id} cols ${c0}-${c1} rows ${r0}-${r1} (${nx * ny} tiles)`);
    const jobs: Promise<void>[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        jobs.push(loadImage(this.tileUrl(m, c, r)).then(img => {
          if (img) ctx.drawImage(img, (c - c0) * m.tileW, (r - r0) * m.tileH, m.tileW, m.tileH);
        }));
      }
    }
    await Promise.all(jobs);

    let bounds: SourceBounds = {
      minX: m.topLeftX + c0 * spanX,
      maxX: m.topLeftX + (c1 + 1) * spanX,
      maxY: m.topLeftY - r0 * spanY,
      minY: m.topLeftY - (r1 + 1) * spanY
    };

    // Crop away any padding beyond the world so the texture's extent is
    // real data and a full-width texture can wrap.
    const world = worldExtent(this.crs);
    if (world) {
      const crop = intersect(bounds, world);
      if (crop.minX > bounds.minX + 1e-9 || crop.maxX < bounds.maxX - 1e-9 ||
          crop.minY > bounds.minY + 1e-9 || crop.maxY < bounds.maxY - 1e-9) {
        const sx = Math.round((crop.minX - bounds.minX) / m.resolution);
        const sy = Math.round((bounds.maxY - crop.maxY) / m.resolution);
        const sw = Math.max(1, Math.round((crop.maxX - crop.minX) / m.resolution));
        const sh = Math.max(1, Math.round((crop.maxY - crop.minY) / m.resolution));
        const cropped = document.createElement('canvas');
        cropped.width = sw;
        cropped.height = sh;
        cropped.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        return { canvas: cropped, bounds: crop };
      }
    }

    return { canvas, bounds };
  }
}
