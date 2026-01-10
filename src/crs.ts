/**
 * CRS handling and proj4 definitions.
 */

import proj4 from 'proj4';

// Register common projections that we know we'll need
export function registerProjections(): void {
  // Web Mercator
  proj4.defs('EPSG:3857', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs');
  
  // WGS84 geographic (usually built-in but be explicit)
  proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
  
  // Antarctic Polar Stereographic
  proj4.defs('EPSG:3031', '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs');
  
  // Arctic Polar Stereographic  
  proj4.defs('EPSG:3995', '+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs');

  // Australian Albers Equal Area
  proj4.defs('EPSG:3577', '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
}

/**
 * Convert lon/lat bounds to Mercator.
 * Clamps latitude to avoid infinity at poles.
 */
export function lonLatToMercator(
  lon: number, 
  lat: number
): [number, number] {
  // Clamp latitude to avoid Mercator singularity
  lat = Math.max(-85, Math.min(85, lat));
  return proj4('EPSG:4326', 'EPSG:3857').forward([lon, lat]) as [number, number];
}

/**
 * Convert Mercator to lon/lat.
 */
export function mercatorToLonLat(
  x: number,
  y: number  
): [number, number] {
  return proj4('EPSG:3857', 'EPSG:4326').forward([x, y]) as [number, number];
}
