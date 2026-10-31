/**
 * Centred-projection view mode.
 *
 * In the fixed-extent mode the display CRS is a static thing: we build a mesh
 * over some extent in it and move a camera around. Here we turn that inside
 * out. The display CRS is a *template* whose lon_0/lat_0 are the current view
 * centre, the mesh is always the screen rectangle around (0, 0), and panning
 * moves the projection centre rather than a camera.
 *
 * That gives a few nice properties for free:
 *   - the screen centre is always the point of zero distortion
 *   - mesh cells are uniform in screen space, so the linear-interpolation
 *     error of the UV warp is uniform across the screen at any zoom
 *   - azimuthal projections (ortho, laea, aeqd, stere) become a globe you can
 *     spin, with no special-casing of poles or the antimeridian
 *
 * The cost is that UVs must be recomputed on every pan, but that is only one
 * proj4 round trip per mesh vertex per layer.
 */

import proj4 from 'proj4';
import { geoTransform } from './transform';

export interface CentredPreset {
  label: string;
  template: string;
  /**
   * Kept for links and the URL (`proj=igh`) but not offered in the list,
   * which shows the everyday CRSs, the ones a web map gets wrong.
   */
  hidden?: boolean;
  /** Where to look when this is picked from the list: lon, lat. */
  centre?: [number, number];
  /** Width in display metres to fit to the screen when picked from the list. */
  span?: number;
}

/**
 * Templates use {lon_0} and {lat_0} placeholders. Most of these are azimuthal
 * so that the tangent point is exactly the screen centre; anything with a
 * centre parameter works (omerc uses lonc, so the placeholder goes there).
 *
 * Note: proj4js does not default x_0/y_0 and silently returns NaN without
 * them, so custom templates must spell out +x_0=0 +y_0=0 too.
 */
export const CENTRED_PRESETS: Record<string, CentredPreset> = {
  ortho: {
    label: 'Orthographic globe, drag to spin',
    template: '+proj=ortho +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  aeqd: {
    label: 'Azimuthal equidistant, drag to spin',
    template: '+proj=aeqd +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  igh: {
    label: 'World: Goode homolosine (interrupted)',
    template: '+proj=igh +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  // Everyday CRSs, fixed (no placeholders): the projection stays put and the
  // view moves over it. Each has a pole, the antimeridian or a long way
  // from Web Mercator in view, which is where a tile-based web map fails.
  'laea-south': {
    label: 'South polar Lambert azimuthal equal area',
    template: '+proj=laea +lat_0=-90 +lon_0=0 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs',
    centre: [0, -90], span: 12e6
  },
  'laea-north': {
    label: 'North polar Lambert azimuthal equal area',
    template: '+proj=laea +lat_0=90 +lon_0=0 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs',
    centre: [0, 90], span: 12e6
  },
  'EPSG:3031': {
    label: 'Antarctic polar stereographic',
    template: 'EPSG:3031',
    centre: [0, -90], span: 9e6
  },
  'EPSG:3413': {
    label: 'NSIDC Arctic polar stereographic',
    template: 'EPSG:3413',
    centre: [0, 90], span: 9e6
  },
  'EPSG:5070': {
    label: 'CONUS Albers equal area',
    template: 'EPSG:5070',
    centre: [-96, 38], span: 5.5e6
  },
  'EPSG:3577': {
    label: 'Australian Albers equal area',
    template: 'EPSG:3577',
    centre: [134, -28], span: 5e6
  },
  'EPSG:32760': {
    label: 'UTM zone 60 south, across the antimeridian',
    template: 'EPSG:32760',
    centre: [177, -40], span: 2e6
  },
  spilhaus: {
    // PROJ only (in wasm, already loaded for codes proj4js lacks): the
    // world's ocean as one piece, cut through the continents.
    label: 'Spilhaus world ocean (PROJ)',
    template: '+proj=spilhaus +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs',
    centre: [66.94970198, -49.56371678], span: 2.5e7
  },
  // Re-centring templates and world projections: they work by name in a
  // link, they are just not in the list.
  laea: {
    hidden: true,
    label: 'Lambert azimuthal equal area',
    template: '+proj=laea +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  stere: {
    hidden: true,
    label: 'Oblique stereographic',
    template: '+proj=stere +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  gnom: {
    hidden: true,
    label: 'Gnomonic',
    template: '+proj=gnom +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  omerc: {
    hidden: true,
    label: 'Oblique Mercator (near north-up)',
    template: '+proj=omerc +alpha=1 +gamma=2 +lonc={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  // World projections take only a central meridian, so panning east-west
  // rotates the globe under a fixed net and panning north-south just moves
  // the view. The ones proj4js lacks are in projections.ts.
  sinu: {
    hidden: true,
    label: 'World: sinusoidal',
    template: '+proj=sinu +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  moll: {
    hidden: true,
    label: 'World: Mollweide',
    template: '+proj=moll +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  robin: {
    hidden: true,
    label: 'World: Robinson',
    template: '+proj=robin +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  eqearth: {
    hidden: true,
    label: 'World: Equal Earth',
    template: '+proj=eqearth +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  eck4: {
    hidden: true,
    label: 'World: Eckert IV',
    template: '+proj=eck4 +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  natearth: {
    hidden: true,
    label: 'World: Natural Earth',
    template: '+proj=natearth +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  hammer: {
    hidden: true,
    label: 'World: Hammer',
    template: '+proj=hammer +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  wintri: {
    hidden: true,
    // lat_1 written out on purpose: see projections.ts on what PROJ's CRS
    // path does with a missing one.
    label: 'World: Winkel Tripel',
    template: '+proj=wintri +lat_1=50.46697 +lon_0={lon_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  }
};

/**
 * Does this template re-centre with the view? A template without {lon_0} or
 * {lat_0} is an ordinary fixed CRS being used in centred mode: the projection
 * stays put and only the mesh follows the view centre.
 */
export function hasPlaceholders(template: string): boolean {
  return /\{lon_0\}|\{lat_0\}/.test(template);
}

/**
 * Projections whose centre has a latitude: the azimuthals, the conics, the
 * transverse cylindricals, Spilhaus. A template for one of these gets a
 * {lat_0} placeholder even when the definition leaves lat_0 to its default.
 * The rest (the world projections) re-centre only their meridian.
 */
const CENTRED_ON_A_POINT = new Set([
  'ortho', 'laea', 'aeqd', 'stere', 'sterea', 'gnom', 'nsper', 'tpers',
  'tmerc', 'etmerc', 'aea', 'lcc', 'eqdc', 'leac', 'omerc', 'spilhaus',
  'bonne', 'poly', 'cass', 'geos', 'vertical_perspective'
]);

/**
 * Turn a fixed CRS into a re-centring template, keeping its other settings:
 * lon_0 and lat_0 become placeholders (lonc for omerc), the false origin
 * goes to zero (the centred mesh is built around the projected centre), and
 * a UTM zone becomes the transverse Mercator it is. The standard parallels
 * of a conic, a polar stereographic's lat_ts, an ellipsoid and so on stay as
 * they were, so the first frame is that CRS, moved to the view centre.
 * Null for a definition that is not a proj string.
 */
export function templateFromDefinition(def: string): string | null {
  let d = ` ${def.trim()} `;
  const proj = /\s\+proj=([^\s]+)/.exec(d)?.[1];
  if (!proj) return null;
  if (proj === 'utm') {
    const zone = parseInt(/\s\+zone=(\d+)/.exec(d)?.[1] || '');
    if (!isFinite(zone)) return null;
    d = d.replace(/\s\+proj=utm/, ' +proj=tmerc')
      .replace(/\s\+zone=\d+/, ` +lon_0=${zone * 6 - 183} +lat_0=0 +k_0=0.9996`)
      .replace(/\s\+south(=[^\s]*)?/, '');
  }
  d = d.replace(/\s\+[xy]_0=[^\s]*/g, '');
  d = d.replace(/\s\+type=crs/g, '');
  const lonKey = proj === 'omerc' ? 'lonc' : 'lon_0';
  const lonRe = new RegExp(`\\s\\+${lonKey}=[^\\s]*`);
  d = lonRe.test(d) ? d.replace(lonRe, ` +${lonKey}={lon_0}`) : d + ` +${lonKey}={lon_0}`;
  if (/\s\+lat_0=/.test(d)) d = d.replace(/\s\+lat_0=[^\s]*/, ' +lat_0={lat_0}');
  else if (CENTRED_ON_A_POINT.has(proj)) d += ' +lat_0={lat_0}';
  return (d + ' +x_0=0 +y_0=0').replace(/\s+/g, ' ').trim();
}

export function isPresetName(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(CENTRED_PRESETS, s);
}

/**
 * Resolve a preset name or a raw template to a template string.
 */
export function resolveTemplate(presetOrTemplate: string): string {
  if (isPresetName(presetOrTemplate)) {
    return CENTRED_PRESETS[presetOrTemplate].template;
  }
  return presetOrTemplate;
}

/**
 * Wrap a longitude to [-180, 180) and clamp latitude to [-90, 90].
 */
export function normaliseLonLat(lon: number, lat: number): [number, number] {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  const p = Math.max(-90, Math.min(90, lat));
  return [l, p];
}

/**
 * Instantiate a template at a centre. Values are formatted with enough
 * precision that a re-parse of the string is a no-op.
 */
export function centredCRS(template: string, lon: number, lat: number): string {
  const [l, p] = normaliseLonLat(lon, lat);
  return template
    .replace(/\{lon_0\}/g, l.toFixed(8))
    .replace(/\{lat_0\}/g, p.toFixed(8));
}

/**
 * Given a projection centred at (lon, lat), find the lon/lat of the point at
 * display position (dx, dy). For a re-centring template that position is an
 * offset from the tangent point; for a static one the caller passes absolute
 * display coordinates, which works out the same way. This is how a screen pan
 * becomes a new centre: the point that was under the middle of the screen
 * after the drag becomes the tangent point of the next frame's projection.
 *
 * Returns null if the offset is not on the globe (dragged past the horizon
 * of an orthographic view, say), in which case the caller should keep the
 * old centre.
 */
/**
 * panCentre for any executor: the inverse and the round trip are batches
 * through the display transform of the current centre's CRS.
 */
export async function panCentreAsync(
  template: string,
  lon: number,
  lat: number,
  dx: number,
  dy: number
): Promise<[number, number] | null> {
  if (dx === 0 && dy === 0) return [lon, lat];
  const geo = geoTransform(centredCRS(template, lon, lat));
  try {
    const ll = await geo.toGeo(new Float64Array([dx, dy]));
    const nlon = ll[0], nlat = ll[1];
    if (!isFinite(nlon) || !isFinite(nlat)) return null;
    const b = await geo.fromGeo(new Float64Array([nlon, nlat]));
    const err = Math.hypot(b[0] - dx, b[1] - dy);
    const scale = Math.max(1, Math.hypot(dx, dy));
    if (!isFinite(err) || err > 1e-6 * scale + 1) return null;
    return normaliseLonLat(nlon, nlat);
  } catch {
    return null;
  }
}

export function panCentre(
  template: string,
  lon: number,
  lat: number,
  dx: number,
  dy: number
): [number, number] | null {
  if (dx === 0 && dy === 0) return [lon, lat];
  const crs = centredCRS(template, lon, lat);
  const inv = proj4(crs, 'EPSG:4326');
  const fwd = proj4('EPSG:4326', crs);
  try {
    const [nlon, nlat] = inv.forward([dx, dy]);
    if (!isFinite(nlon) || !isFinite(nlat)) return null;
    // Reject clamped inverses (beyond the horizon) by round-tripping.
    const [bx, by] = fwd.forward([nlon, nlat]);
    const err = Math.hypot(bx - dx, by - dy);
    const scale = Math.max(1, Math.hypot(dx, dy));
    if (!isFinite(err) || err > 1e-6 * scale + 1) return null;
    return normaliseLonLat(nlon, nlat);
  } catch {
    return null;
  }
}
