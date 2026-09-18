/**
 * CRS handling and proj4 definitions.
 *
 * proj4js ships no EPSG database, so a code is only usable once a definition
 * has been registered. Three ways to get one, in order:
 *
 *   1. A named definition from the table below.
 *   2. Synthesised from zone arithmetic, for the UTM-style families where the
 *      code number encodes the zone (WGS84, GDA94/GDA2020 MGA, NAD83, ETRS89).
 *   3. Fetched from epsg.io at runtime (resolveCRS, async). Needs network and
 *      CORS from that host, so it is a convenience, not something to rely on.
 *
 * When all three fail, a layer URL can carry the definition itself:
 * `cog.tif#crs=+proj=utm +zone=55 +south +ellps=GRS80`. That is the escape
 * hatch for anything exotic, and it registers the definition under the
 * source's own code so later layers get it too.
 *
 * The definitions here are checked against PROJ's own EPSG database by
 * tools/check-crs.py. Datum shifts are the identity for the GRS80-based
 * datums (GDA94, GDA2020, NAD83, ETRS89): a metre or two against WGS84,
 * which is well inside a screen pixel at any zoom this viewer reaches.
 */

import proj4 from 'proj4';

/** Named definitions: anything whose code is not pure zone arithmetic. */
const DEFS: Record<string, string> = {
  // Geographic
  'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:4269': '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',       // NAD83
  'EPSG:4283': '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',       // GDA94
  'EPSG:7844': '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',       // GDA2020

  // Web mapping
  'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  'EPSG:3395': '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',

  // Polar
  'EPSG:3031': '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  'EPSG:3995': '+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  // IBCSO v2: standard parallel is -65, not the -71 of EPSG:3031
  'EPSG:9354': '+proj=stere +lat_0=-90 +lat_ts=-65 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  'EPSG:3032': '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=70 +k=1 +x_0=6000000 +y_0=6000000 +datum=WGS84 +units=m +no_defs',
  'EPSG:3033': '+proj=lcc +lat_0=-50 +lon_0=70 +lat_1=-68.5 +lat_2=-74.5 +x_0=6000000 +y_0=6000000 +datum=WGS84 +units=m +no_defs',
  'EPSG:3413': '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  'EPSG:3976': '+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  'EPSG:3411': '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs',
  'EPSG:3412': '+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +k=1 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs',
  'EPSG:5041': '+proj=stere +lat_0=90 +lat_ts=90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs',
  'EPSG:5042': '+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs',
  'EPSG:32661': '+proj=stere +lat_0=90 +lat_ts=90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs',
  'EPSG:32761': '+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs',

  // EASE-Grid 2.0
  'EPSG:6931': '+proj=laea +lat_0=90 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  'EPSG:6932': '+proj=laea +lat_0=-90 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  'EPSG:6933': '+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',

  // Australia
  'EPSG:3577': '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:9473': '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:3112': '+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:7845': '+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',  // GDA2020 / GA LCC
  'EPSG:7899': '+proj=lcc +lat_0=-37 +lon_0=145 +lat_1=-36 +lat_2=-38 +x_0=2500000 +y_0=2500000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',  // GDA2020 / Vicgrid

  // Elsewhere, common enough to be worth carrying
  'EPSG:2193': '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:27700': '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  'EPSG:3035': '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
};

/**
 * Families where the EPSG code is a base plus the UTM zone number.
 */
interface ZoneFamily {
  lo: number;
  hi: number;
  base: number;
  south: boolean;
  datum: string;
  label: string;
}

const ZONE_FAMILIES: ZoneFamily[] = [
  { lo: 32601, hi: 32660, base: 32600, south: false, datum: '+datum=WGS84', label: 'WGS 84 / UTM north' },
  { lo: 32701, hi: 32760, base: 32700, south: true,  datum: '+datum=WGS84', label: 'WGS 84 / UTM south' },
  { lo: 28348, hi: 28358, base: 28300, south: true,  datum: '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0', label: 'GDA94 / MGA' },
  { lo: 7846,  hi: 7859,  base: 7800,  south: true,  datum: '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0', label: 'GDA2020 / MGA' },
  { lo: 26901, hi: 26923, base: 26900, south: false, datum: '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0', label: 'NAD83 / UTM north' },
  { lo: 25828, hi: 25838, base: 25800, south: false, datum: '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0', label: 'ETRS89 / UTM north' }
];

/**
 * Build a definition from zone arithmetic, or null if the code is not in one
 * of the families.
 */
export function synthesiseCRS(crs: string): string | null {
  const m = /^EPSG:(\d+)$/i.exec(crs.trim());
  if (!m) return null;
  const code = parseInt(m[1]);
  for (const f of ZONE_FAMILIES) {
    if (code < f.lo || code > f.hi) continue;
    const zone = code - f.base;
    if (zone < 1 || zone > 60) continue;
    console.log(`${crs} synthesised as ${f.label} zone ${zone}`);
    return `+proj=utm +zone=${zone}${f.south ? ' +south' : ''} ${f.datum} +units=m +no_defs`;
  }
  return null;
}

export function registerProjections(): void {
  for (const [code, def] of Object.entries(DEFS)) {
    proj4.defs(code, def);
  }
}

/**
 * Register a definition under a code, for one that came from somewhere else
 * (a URL fragment, a remote lookup). False if proj4 cannot use it.
 */
export function defineCRS(code: string, def: string): boolean {
  try {
    proj4.defs(code, def);
    proj4(code, 'EPSG:4326');
    return true;
  } catch (err) {
    console.warn(`Definition for ${code} did not parse:`, err);
    return false;
  }
}

/**
 * Is this CRS usable right now? Registers a synthesised definition if the
 * code belongs to one of the zone families. Synchronous: no network.
 */
export function ensureCRS(crs: string): boolean {
  if (!crs) return false;
  if (!proj4.defs(crs)) {
    const syn = synthesiseCRS(crs);
    if (syn) proj4.defs(crs, syn);
  }
  try {
    proj4(crs, 'EPSG:4326');
    return true;
  } catch {
    return false;
  }
}

// Remote lookups already attempted, so a miss is not retried for every layer.
const remoteTried = new Map<string, Promise<boolean>>();

/**
 * Like ensureCRS, but falls back to fetching the definition from epsg.io.
 * That needs network and CORS from epsg.io; failure is not an error, it just
 * leaves the CRS unusable for the caller to report.
 */
export async function resolveCRS(crs: string): Promise<boolean> {
  if (ensureCRS(crs)) return true;
  const m = /^EPSG:(\d+)$/i.exec(crs.trim());
  if (!m) return false;
  const code = m[1];

  let attempt = remoteTried.get(code);
  if (!attempt) {
    attempt = (async () => {
      for (const url of [`https://epsg.io/${code}.proj4`, `https://epsg.io/${code}.wkt`]) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const text = (await res.text()).trim();
          if (!text || /<html/i.test(text)) continue;
          if (defineCRS(`EPSG:${code}`, text)) {
            console.log(`Fetched definition for EPSG:${code} from epsg.io`);
            return true;
          }
        } catch {
          // network or CORS: try the next form, then give up quietly
        }
      }
      return false;
    })();
    remoteTried.set(code, attempt);
  }
  return attempt;
}

/**
 * What to tell the user when a CRS cannot be resolved: the escape hatch,
 * not just the failure.
 */
export function unknownCRSMessage(crs: string): string {
  return `CRS ${crs} is not known to proj4js.\n\n` +
    `Built in: UTM-style codes (WGS84, GDA94 and GDA2020 MGA, NAD83, ETRS89) ` +
    `and a table of common projections. epsg.io is tried at runtime, which ` +
    `needs network access to that host.\n\n` +
    `You can give the definition yourself: paste a proj4 string in place of ` +
    `the code, or put one on a layer URL as\n<url>#crs=+proj=... +ellps=...`;
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
