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
 * Whatever the route, the definition string itself is kept (crsDefinition),
 * because a second transform implementation - rwarp's proj4rs in wasm - has
 * the same no-database problem and should be handed the same parameters
 * rather than a code it would have to resolve for itself.
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
import { registerExtraProjections } from './projections';

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
    return `+proj=utm +zone=${zone}${f.south ? ' +south' : ''} ${f.datum} +units=m +no_defs`;
  }
  return null;
}

/**
 * The definition string behind every code registered so far.
 *
 * proj4.defs(code) hands back a parsed object, not the text it came from, so
 * the text is kept here: it is what gets passed to another implementation.
 */
const definitions = new Map<string, string>();

function register(code: string, def: string): void {
  proj4.defs(code, def);
  definitions.set(code, def);
}

export function registerProjections(): void {
  registerExtraProjections();
  for (const [code, def] of Object.entries(DEFS)) {
    register(code, def);
  }
}

/**
 * The proj4 definition string for a CRS, ready to hand to another transform
 * implementation. A CRS that is already a definition (a proj string, or WKT)
 * is returned as it stands; a code returns whatever was registered for it,
 * or null if nothing has been.
 *
 * This is the single authority the viewer intends to keep: one place decides
 * what EPSG:28355 means, and every engine is given that same answer.
 */
export function crsDefinition(crs: string): string | null {
  if (!crs) return null;
  const t = crs.trim();
  const known = definitions.get(t) ?? definitions.get(t.toUpperCase());
  if (known) return known;
  if (!/^EPSG:\d+$/i.test(t)) return t;   // a definition as given, not normalised

  // proj4js ships definitions of its own - the WGS84 UTM zones among them -
  // so a code can be perfectly usable here without ever passing through
  // register(). Recover the string it parsed, so the definition handed out
  // is the one this viewer is actually projecting with, and fall back to
  // zone arithmetic if proj4 kept no string.
  const parsed = proj4.defs(t) as { projStr?: string } | undefined;
  const recovered = parsed && typeof parsed.projStr === 'string' && parsed.projStr
    ? parsed.projStr
    : synthesiseCRS(t);
  if (recovered) definitions.set(t, recovered);
  return recovered;
}

/**
 * Register a definition under a code, for one that came from somewhere else
 * (a URL fragment, a remote lookup). False if proj4 cannot use it.
 */
export function defineCRS(code: string, def: string): boolean {
  try {
    register(code, def);
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
    if (syn) {
      console.log(`${crs} synthesised as ${syn}`);
      register(crs, syn);
    }
  }
  try {
    proj4(crs, 'EPSG:4326');
    return true;
  } catch {
    return false;
  }
}

/**
 * Something that can turn an EPSG code into a definition string when nothing
 * built in can: a PROJ build in wasm with the real EPSG database, say. It is
 * asked only after the table and zone arithmetic have both missed, and only
 * for codes, so the cost of a large resolver is paid by the rare session that
 * needs it. Return null for "not known"; throwing is treated the same way.
 */
export type DefinitionProvider = (code: string) => Promise<string | null>;

let provider: DefinitionProvider | null = null;

export function setDefinitionProvider(p: DefinitionProvider | null): void {
  provider = p;
  remoteTried.clear();   // a new provider deserves a fresh go at earlier misses
}

// Remote lookups already attempted, so a miss is not retried for every layer.
const remoteTried = new Map<string, Promise<boolean>>();

/**
 * Like ensureCRS, but falls back to the definition provider if one has been
 * set, and then to fetching the definition from epsg.io. That last needs
 * network and CORS from epsg.io; failure is not an error, it just leaves the
 * CRS unusable for the caller to report.
 */
export async function resolveCRS(crs: string): Promise<boolean> {
  if (ensureCRS(crs)) return true;
  const key = crs.trim();
  if (!key) return false;
  const m = /^EPSG:(\d+)$/i.exec(key);
  const code = m ? m[1] : null;

  let attempt = remoteTried.get(key);
  if (!attempt) {
    attempt = (async () => {
      // The provider (PROJ) reads anything: a code, WKT in any dialect,
      // PROJJSON, a URN, a +proj string with parameters proj4js does not
      // parse. Whatever it is, ask for the PROJ.4 string and try to use that.
      if (provider) {
        try {
          const def = await provider(key);
          if (def) {
            if (defineCRS(key, def)) {
              console.log(`Resolved ${describe(key)} through the definition provider`);
              return true;
            }
            failures.set(key, executorFailure(def));
            return false;
          }
        } catch (err) {
          console.warn(`Definition provider failed for ${describe(key)}:`, err);
        }
      }
      if (!code) return false;
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
    remoteTried.set(key, attempt);
  }
  return attempt;
}

// Why the last attempt at a CRS failed, when the reason is more useful than
// "unknown": PROJ understood it, proj4js could not execute the result.
const failures = new Map<string, string>();

function describe(crs: string): string {
  return crs.length > 60 ? crs.slice(0, 57) + '...' : crs;
}

function executorFailure(def: string): string {
  const m = /\+proj=([^\s]+)/.exec(def);
  return m
    ? `PROJ understands it (${describe(def)}) but proj4js cannot execute ` +
      `+proj=${m[1]}. The projections proj4js runs are its own couple of ` +
      `dozen plus eck4, natearth, hammer, wintri and igh added here.`
    : `PROJ understands it but could not express it as a proj4 string proj4js accepts.`;
}

/**
 * What to tell the user when a CRS cannot be resolved: the escape hatch,
 * not just the failure.
 */
export function unknownCRSMessage(crs: string): string {
  const why = failures.get(crs.trim());
  if (why) return `CRS ${describe(crs)}:\n\n${why}`;
  return `CRS ${describe(crs)} could not be resolved.\n\n` +
    `Tried: the built-in table, UTM-style zone codes (WGS84, GDA94 and ` +
    `GDA2020 MGA, NAD83, ETRS89), PROJ itself (which needs the proj-wasm ` +
    `folder to load), and epsg.io (which needs network access to that host).\n\n` +
    `You can give the definition yourself: paste a proj4 string or WKT in ` +
    `place of the code, or put one on a layer URL as\n<url>#crs=+proj=... +ellps=...`;
}

/**
 * Turn any CRS text into a definition proj4js can use, or null. A string
 * proj4js already accepts is returned as it is; otherwise PROJ normalises it.
 */
export async function normaliseDefinition(def: string): Promise<string | null> {
  const d = def.trim();
  if (!d) return null;
  try {
    proj4(d, 'EPSG:4326');
    return d;
  } catch {
    // not something proj4js reads on its own
  }
  if (!provider) return null;
  try {
    const norm = await provider(d);
    if (!norm) return null;
    proj4(norm, 'EPSG:4326');
    return norm;
  } catch {
    return null;
  }
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
