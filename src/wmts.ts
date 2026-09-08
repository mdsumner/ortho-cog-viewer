/**
 * WMTS 1.0.0 GetCapabilities parsing.
 *
 * Produces a TileMatrixSetDef (per-level origin, resolution, tile size and
 * matrix size) plus a tile URL template with {z}/{x}/{y} placeholders, which
 * is everything XYZSource needs. Both RESTful ResourceURL templates and KVP
 * GetTile are supported. Matrix identifiers are kept verbatim (they are not
 * always integers), and {z} is substituted with the identifier.
 */

import { SourceBounds, transformBounds } from './uv';
import { ensureCRS } from './crs';

export interface TileMatrix {
  id: string;
  resolution: number;   // CRS units per pixel
  topLeftX: number;
  topLeftY: number;
  tileW: number;
  tileH: number;
  matrixW: number;
  matrixH: number;
  /** optional per-layer limits from TileMatrixSetLimits */
  minRow?: number;
  maxRow?: number;
  minCol?: number;
  maxCol?: number;
}

export interface TileMatrixSetDef {
  id: string;
  crs: string;
  /** finest first */
  matrices: TileMatrix[];
}

export interface WMTSLayerSource {
  template: string;      // with {z} {x} {y}
  tms: TileMatrixSetDef;
  layerId: string;
  title: string;
  attribution?: string;
  /** layer extent in the TMS CRS, if the capabilities gave a bbox */
  bounds?: SourceBounds;
}

const PIXEL_SIZE_M = 0.00028;           // OGC standardized rendering pixel size
const METRES_PER_DEGREE = 111319.49079327358;

export function isCapabilitiesUrl(url: string): boolean {
  return /capabilities/i.test(url) || /service=wmts/i.test(url) && /request=getcapabilities/i.test(url);
}

/**
 * Normalise "urn:ogc:def:crs:EPSG::3857", "urn:ogc:def:crs:EPSG:6.18.3:3857",
 * "EPSG:3857", "http://www.opengis.net/def/crs/EPSG/0/3857" to "EPSG:3857".
 * OGC:1.3:CRS84 becomes EPSG:4326 (lon/lat order for our purposes).
 */
export function normaliseCRS(s: string): string {
  const t = s.trim();
  if (/CRS84/i.test(t)) return 'EPSG:4326';
  const m = /EPSG(?:::|:[\d.]*:|[:/]0?\/|:)(\d+)$/i.exec(t) || /EPSG\D+(\d+)\s*$/i.exec(t);
  if (m) return `EPSG:${m[1]}`;
  return t;
}

function isGeographic(crs: string): boolean {
  return crs === 'EPSG:4326' || crs === 'EPSG:4269';
}

function text(el: Element | null | undefined): string {
  return el && el.textContent ? el.textContent.trim() : '';
}

function children(el: Element | Document, local: string): Element[] {
  return Array.from(el.getElementsByTagNameNS('*', local));
}

function firstChild(el: Element | Document, local: string): Element | null {
  const all = el.getElementsByTagNameNS('*', local);
  return all.length ? all[0] : null;
}

/** Direct child (not descendant) elements by local name. */
function directChildren(el: Element, local: string): Element[] {
  return Array.from(el.children).filter(c => c.localName === local);
}

function directChild(el: Element, local: string): Element | null {
  const c = directChildren(el, local);
  return c.length ? c[0] : null;
}

export interface WMTSDimension {
  id: string;
  default: string;
  values: string[];
}

export interface WMTSLayerInfo {
  id: string;
  title: string;
  tmsIds: string[];
  styles: string[];
  formats: string[];
  resourceURLs: string[];
  bbox84?: SourceBounds;
  dimensions: WMTSDimension[];
  limits: Map<string, Map<string, { minRow: number; maxRow: number; minCol: number; maxCol: number }>>;
}

export interface ParsedCapabilities {
  layers: WMTSLayerInfo[];
  tms: Map<string, TileMatrixSetDef>;
  getTileKvpUrl?: string;
  attribution?: string;
}

export function parseCapabilities(xml: string): ParsedCapabilities {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = firstChild(doc, 'parsererror');
  if (err) throw new Error('Capabilities XML failed to parse');

  // TileMatrixSets
  const tms = new Map<string, TileMatrixSetDef>();
  for (const setEl of children(doc, 'TileMatrixSet')) {
    // Only the Contents-level definitions have TileMatrix children; a layer's
    // <TileMatrixSetLink><TileMatrixSet>id</TileMatrixSet> does not.
    const matrixEls = directChildren(setEl, 'TileMatrix');
    if (matrixEls.length === 0) continue;
    const id = text(directChild(setEl, 'Identifier'));
    const crs = normaliseCRS(text(directChild(setEl, 'SupportedCRS')));
    const geo = isGeographic(crs);
    const unitsPerPixel = geo ? PIXEL_SIZE_M / METRES_PER_DEGREE : PIXEL_SIZE_M;
    const matrices: TileMatrix[] = matrixEls.map(m => {
      const corner = text(directChild(m, 'TopLeftCorner')).split(/\s+/).map(Number);
      let [a, b] = corner;
      // Geographic CRSs in urn form are lat/lon ordered; detect and swap.
      if (geo && Math.abs(a) <= 90 && Math.abs(b) > 90) [a, b] = [b, a];
      return {
        id: text(directChild(m, 'Identifier')),
        resolution: parseFloat(text(directChild(m, 'ScaleDenominator'))) * unitsPerPixel,
        topLeftX: a,
        topLeftY: b,
        tileW: parseInt(text(directChild(m, 'TileWidth'))) || 256,
        tileH: parseInt(text(directChild(m, 'TileHeight'))) || 256,
        matrixW: parseInt(text(directChild(m, 'MatrixWidth'))) || 1,
        matrixH: parseInt(text(directChild(m, 'MatrixHeight'))) || 1
      };
    });
    matrices.sort((p, q) => p.resolution - q.resolution);
    tms.set(id, { id, crs, matrices });
  }

  // Layers
  const layers: ParsedCapabilities['layers'] = [];
  const contents = firstChild(doc, 'Contents');
  const layerEls = contents ? directChildren(contents, 'Layer') : children(doc, 'Layer');
  for (const l of layerEls) {
    const id = text(directChild(l, 'Identifier'));
    const title = text(directChild(l, 'Title')) || id;
    const styles = directChildren(l, 'Style').map(s => text(directChild(s, 'Identifier')));
    const formats = directChildren(l, 'Format').map(text);
    const links = directChildren(l, 'TileMatrixSetLink');
    const tmsIds = links.map(k => text(directChild(k, 'TileMatrixSet')));
    const limits = new Map<string, Map<string, { minRow: number; maxRow: number; minCol: number; maxCol: number }>>();
    links.forEach((k, i) => {
      const lim = directChild(k, 'TileMatrixSetLimits');
      if (!lim) return;
      const perMatrix = new Map<string, { minRow: number; maxRow: number; minCol: number; maxCol: number }>();
      for (const ml of directChildren(lim, 'TileMatrixLimits')) {
        perMatrix.set(text(directChild(ml, 'TileMatrix')), {
          minRow: parseInt(text(directChild(ml, 'MinTileRow'))),
          maxRow: parseInt(text(directChild(ml, 'MaxTileRow'))),
          minCol: parseInt(text(directChild(ml, 'MinTileCol'))),
          maxCol: parseInt(text(directChild(ml, 'MaxTileCol')))
        });
      }
      limits.set(tmsIds[i], perMatrix);
    });
    const resourceURLs = directChildren(l, 'ResourceURL')
      .filter(r => (r.getAttribute('resourceType') || 'tile') === 'tile')
      .map(r => r.getAttribute('template') || '')
      .filter(Boolean);
    let bbox84: SourceBounds | undefined;
    const bb = directChild(l, 'WGS84BoundingBox');
    if (bb) {
      const lo = text(directChild(bb, 'LowerCorner')).split(/\s+/).map(Number);
      const hi = text(directChild(bb, 'UpperCorner')).split(/\s+/).map(Number);
      if (lo.length === 2 && hi.length === 2 && lo.concat(hi).every(isFinite)) {
        bbox84 = { minX: lo[0], minY: lo[1], maxX: hi[0], maxY: hi[1] };
      }
    }
    const dimensions: WMTSDimension[] = directChildren(l, 'Dimension').map(d => ({
      id: text(directChild(d, 'Identifier')),
      default: text(directChild(d, 'Default')),
      values: directChildren(d, 'Value').map(text)
    }));
    layers.push({ id, title, tmsIds, styles, formats, resourceURLs, bbox84, dimensions, limits });
  }

  // KVP GetTile endpoint, if any
  let getTileKvpUrl: string | undefined;
  for (const op of children(doc, 'Operation')) {
    if (op.getAttribute('name') === 'GetTile') {
      const get = firstChild(op, 'Get');
      const href = get && (get.getAttribute('xlink:href') || get.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
      if (href) getTileKvpUrl = href;
    }
  }

  const attribution = text(firstChild(doc, 'ProviderName')) || text(firstChild(doc, 'AccessConstraints')) || undefined;
  return { layers, tms, getTileKvpUrl, attribution };
}

/**
 * Pick a layer and matrix set and build the source description.
 *
 * @param wantLayer  layer identifier; first layer if omitted
 * @param wantTms    matrix set identifier; otherwise the first one whose CRS
 *                   we can transform, preferring a Google-style set
 */
export function selectWMTSSource(
  caps: ParsedCapabilities,
  wantLayer?: string,
  wantTms?: string,
  wantTime?: string
): WMTSLayerSource {
  if (caps.layers.length === 0) throw new Error('Capabilities has no layers');
  const layer = (wantLayer && caps.layers.find(l => l.id === wantLayer)) || caps.layers[0];

  const candidates = layer.tmsIds
    .map(id => caps.tms.get(id))
    .filter((t): t is TileMatrixSetDef => !!t && ensureCRS(t.crs));
  if (candidates.length === 0) {
    throw new Error(`No usable TileMatrixSet for layer ${layer.id} (CRS not supported)`);
  }
  let tmsDef = wantTms ? candidates.find(t => t.id === wantTms) : undefined;
  if (!tmsDef) {
    tmsDef = candidates.find(t => /google|webmercator|3857/i.test(t.id)) || candidates[0];
  }

  // Apply per-layer limits
  const lim = layer.limits.get(tmsDef.id);
  const matrices = tmsDef.matrices.map(m => {
    const l = lim && lim.get(m.id);
    return l ? { ...m, ...l } : { ...m };
  });
  const tms: TileMatrixSetDef = { ...tmsDef, matrices };

  const style = layer.styles[0] || 'default';
  const format = layer.formats[0] || 'image/png';
  let template: string;
  if (layer.resourceURLs.length) {
    template = layer.resourceURLs[0];
  } else if (caps.getTileKvpUrl) {
    const sep = caps.getTileKvpUrl.includes('?') ? '&' : '?';
    template = `${caps.getTileKvpUrl}${sep}SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
      `&LAYER=${encodeURIComponent(layer.id)}&STYLE=${encodeURIComponent(style)}` +
      `&TILEMATRIXSET=${encodeURIComponent(tms.id)}&FORMAT=${encodeURIComponent(format)}` +
      `&TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}`;
  } else {
    throw new Error('Capabilities has neither a ResourceURL template nor a GetTile endpoint');
  }
  template = template
    .replace(/\{Style\}/gi, style)
    .replace(/\{TileMatrixSet\}/gi, tms.id)
    .replace(/\{TileMatrix\}/gi, '{z}')
    .replace(/\{TileRow\}/gi, '{y}')
    .replace(/\{TileCol\}/gi, '{x}');
  // Dimensions: {Time} (or whatever the identifier is) -> requested or default
  for (const d of layer.dimensions) {
    const value = (wantTime && /^time$/i.test(d.id)) ? wantTime : (d.default || d.values[0] || '');
    template = template.replace(new RegExp(`\\{${d.id}\\}`, 'gi'), value);
    if (/^time$/i.test(d.id) && caps.getTileKvpUrl && !layer.resourceURLs.length) {
      template += `&TIME=${encodeURIComponent(value)}`;
    }
  }

  let bounds: SourceBounds | undefined;
  if (layer.bbox84) {
    try {
      bounds = transformBounds(layer.bbox84, 'EPSG:4326', tms.crs, 20);
      if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(isFinite)) bounds = undefined;
    } catch {
      bounds = undefined;
    }
  }

  return { template, tms, layerId: layer.id, title: layer.title, attribution: caps.attribution, bounds };
}

const capsCache = new Map<string, Promise<ParsedCapabilities>>();

/**
 * Fetch and parse a capabilities document, cached per URL.
 */
export function fetchCapabilities(url: string): Promise<ParsedCapabilities> {
  let p = capsCache.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GetCapabilities failed: HTTP ${res.status}`);
      return parseCapabilities(await res.text());
    })();
    capsCache.set(url, p);
    p.catch(() => capsCache.delete(url));
  }
  return p;
}

/**
 * Split "caps.xml#layer=a&tms=b&time=c" into the URL and its selections.
 */
export function splitCapabilitiesUrl(url: string): { url: string; layer?: string; tms?: string; time?: string } {
  const hash = url.indexOf('#');
  if (hash < 0) return { url };
  const frag = new URLSearchParams(url.slice(hash + 1));
  return {
    url: url.slice(0, hash),
    layer: frag.get('layer') || undefined,
    tms: frag.get('tms') || undefined,
    time: frag.get('time') || undefined
  };
}

export async function loadWMTS(url: string, wantLayer?: string, wantTms?: string, wantTime?: string): Promise<WMTSLayerSource> {
  return selectWMTSSource(await fetchCapabilities(url), wantLayer, wantTms, wantTime);
}
