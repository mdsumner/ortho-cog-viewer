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

export interface CentredPreset {
  label: string;
  template: string;
}

/**
 * Templates use {lon_0} and {lat_0} placeholders. All of these are azimuthal
 * so that the tangent point is exactly the screen centre.
 *
 * Note: proj4js does not default x_0/y_0 and silently returns NaN without
 * them, so custom templates must spell out +x_0=0 +y_0=0 too.
 */
export const CENTRED_PRESETS: Record<string, CentredPreset> = {
  ortho: {
    label: 'Orthographic (globe)',
    template: '+proj=ortho +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  laea: {
    label: 'Lambert azimuthal equal area',
    template: '+proj=laea +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  aeqd: {
    label: 'Azimuthal equidistant',
    template: '+proj=aeqd +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  stere: {
    label: 'Oblique stereographic',
    template: '+proj=stere +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  },
  gnom: {
    label: 'Gnomonic',
    template: '+proj=gnom +lon_0={lon_0} +lat_0={lat_0} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs'
  }
};

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
 * display offset (dx, dy) metres from the centre. This is how a screen pan
 * becomes a new centre: the point that was under the middle of the screen
 * after the drag becomes the tangent point of the next frame's projection.
 *
 * Returns null if the offset is not on the globe (dragged past the horizon
 * of an orthographic view, say), in which case the caller should keep the
 * old centre.
 */
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
