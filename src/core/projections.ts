/**
 * Projections proj4js does not ship, added through its plugin hook.
 *
 * proj4js implements a couple of dozen projections and PROJ implements
 * about 150; the display side of this viewer needs a synchronous forward
 * and inverse per mesh vertex, so the ones people actually reach for in
 * centred mode are written here rather than waiting on a worker round trip
 * to PROJ. All are spherical closed forms (PROJ treats them the same way,
 * radius a), ported from PROJ's own sources and checked against pyproj by
 * tools/check-projections.py.
 *
 * Interface, as proj4js's own projections have it: forward() takes p.x/p.y
 * as lon/lat in radians and returns metres; inverse() the reverse. this.a
 * is the radius, this.long0 the central meridian, this.x0/y0 false origins.
 */
import proj4 from 'proj4';

interface P { x: number; y: number; }

interface Base {
  a: number;
  long0: number;
  x0: number;
  y0: number;
  over?: boolean;
}

const PI = Math.PI;
const HALF_PI = PI / 2;
const EPS = 1e-10;

function adjustLon(lon: number, over?: boolean): number {
  if (over || Math.abs(lon) <= PI) return lon;
  return lon - Math.sign(lon) * 2 * PI * Math.floor((Math.abs(lon) + PI) / (2 * PI));
}
function aasin(v: number): number {
  return Math.asin(Math.max(-1, Math.min(1, v)));
}

// ---------------------------------------------------------------------------
// Eckert IV (PROJ: eck.cpp)

const E4_CX = 0.42223820031577120149;
const E4_CY = 1.32650042817700232;
const E4_CP = 3.57079632679489661922;

function eck4Init(this: Base): void {
  this.x0 = this.x0 || 0; this.y0 = this.y0 || 0; this.long0 = this.long0 || 0;
}
function eck4Forward(this: Base, p: P): P {
  const lam = adjustLon(p.x - this.long0, this.over);
  let phi = p.y;
  const pp = E4_CP * Math.sin(phi);
  let V = phi * phi;
  phi *= 0.895168 + V * (0.0218849 + V * 0.00826809);
  let i = 6;
  for (; i > 0; i--) {
    const c = Math.cos(phi), s = Math.sin(phi);
    V = (phi + s * (c + 2) - pp) / (1 + c * (c + 2) - s * s);
    phi -= V;
    if (Math.abs(V) < 1e-7) break;
  }
  if (i === 0) {
    p.x = this.x0; p.y = this.a * (phi < 0 ? -E4_CY : E4_CY) + this.y0;
  } else {
    p.x = this.a * E4_CX * lam * (1 + Math.cos(phi)) + this.x0;
    p.y = this.a * E4_CY * Math.sin(phi) + this.y0;
  }
  return p;
}
function eck4Inverse(this: Base, p: P): P {
  const x = (p.x - this.x0) / this.a, y = (p.y - this.y0) / this.a;
  let phi = aasin(y / E4_CY);
  const c = Math.cos(phi);
  const lam = x / (E4_CX * (1 + c));
  phi = aasin((phi + Math.sin(phi) * (c + 2)) / E4_CP);
  p.x = adjustLon(lam + this.long0, this.over); p.y = phi;
  return p;
}

// ---------------------------------------------------------------------------
// Natural Earth (PROJ: natearth.cpp; Savric, Jenny, Patterson, Hurni 2011)

const NE_A0 = 0.8707, NE_A1 = -0.131979, NE_A2 = -0.013791, NE_A3 = 0.003971, NE_A4 = -0.001529;
const NE_B0 = 1.007226, NE_B1 = 0.015085, NE_B2 = -0.044475, NE_B3 = 0.028874, NE_B4 = -0.005916;
const NE_C0 = NE_B0, NE_C1 = 3 * NE_B1, NE_C2 = 7 * NE_B2, NE_C3 = 9 * NE_B3, NE_C4 = 11 * NE_B4;
const NE_MAX_Y = 0.8707 * 0.52 * PI;

function natearthInit(this: Base): void {
  this.x0 = this.x0 || 0; this.y0 = this.y0 || 0; this.long0 = this.long0 || 0;
}
function natearthForward(this: Base, p: P): P {
  const lam = adjustLon(p.x - this.long0, this.over);
  const phi = p.y, phi2 = phi * phi, phi4 = phi2 * phi2;
  p.x = this.a * lam * (NE_A0 + phi2 * (NE_A1 + phi2 * (NE_A2 + phi4 * phi2 * (NE_A3 + phi2 * NE_A4)))) + this.x0;
  p.y = this.a * phi * (NE_B0 + phi2 * (NE_B1 + phi4 * (NE_B2 + NE_B3 * phi2 + NE_B4 * phi4))) + this.y0;
  return p;
}
function natearthInverse(this: Base, p: P): P {
  const x = (p.x - this.x0) / this.a;
  let y = (p.y - this.y0) / this.a;
  if (y > NE_MAX_Y) y = NE_MAX_Y; else if (y < -NE_MAX_Y) y = -NE_MAX_Y;
  let yc = y;
  for (let i = 0; i < 100; i++) {
    const y2 = yc * yc, y4 = y2 * y2;
    const f = yc * (NE_B0 + y2 * (NE_B1 + y4 * (NE_B2 + NE_B3 * y2 + NE_B4 * y4))) - y;
    const fder = NE_C0 + y2 * (NE_C1 + y4 * (NE_C2 + NE_C3 * y2 + NE_C4 * y4));
    const tol = f / fder;
    yc -= tol;
    if (Math.abs(tol) < 1e-11) break;
  }
  const phi = yc, y2 = phi * phi;
  const lam = x / (NE_A0 + y2 * (NE_A1 + y2 * (NE_A2 + y2 * y2 * y2 * (NE_A3 + y2 * NE_A4))));
  p.x = adjustLon(lam + this.long0, this.over); p.y = phi;
  return p;
}

// ---------------------------------------------------------------------------
// Hammer (PROJ: hammer.cpp, with its defaults W = 0.5, M = 1)

function hammerInit(this: Base): void {
  this.x0 = this.x0 || 0; this.y0 = this.y0 || 0; this.long0 = this.long0 || 0;
}
function hammerForward(this: Base, p: P): P {
  const lam = adjustLon(p.x - this.long0, this.over) * 0.5;
  const cosphi = Math.cos(p.y);
  const d = Math.sqrt(2 / (1 + cosphi * Math.cos(lam)));
  p.x = this.a * 2 * d * cosphi * Math.sin(lam) + this.x0;
  p.y = this.a * d * Math.sin(p.y) + this.y0;
  return p;
}
function hammerInverse(this: Base, p: P): P {
  const x = (p.x - this.x0) / this.a, y = (p.y - this.y0) / this.a;
  const z = Math.sqrt(1 - 0.0625 * x * x - 0.25 * y * y);
  const lam = Math.atan2(0.5 * x * z, 2 * z * z - 1) / 0.5;
  p.x = adjustLon(lam + this.long0, this.over);
  p.y = aasin(z * y);
  return p;
}

// ---------------------------------------------------------------------------
// Winkel Tripel (PROJ: aitoff.cpp in wintri mode)
//
// The standard parallel is lat_1, defaulting to acos(2/pi) = 50d28' as
// Winkel defined it and as PROJ's own pipeline applies it. Beware: when
// PROJ is handed "+proj=wintri" as a CRS rather than a pipeline (GDAL,
// pyproj, anything going through proj_create_crs_to_crs) the missing lat_1
// is filled in as 0, which is a different, wider projection. Two consumers
// of the same string can disagree by thousands of kilometres. Always write
// +lat_1 explicitly in a wintri definition that leaves this viewer.

interface WintriThis extends Base { lat1?: number; cosphi1: number; }

function wintriUnit(lam: number, phi: number, cosphi1: number): [number, number] {
  const c = 0.5 * lam;
  const cosphi = Math.cos(phi);
  const d = Math.acos(cosphi * Math.cos(c));
  let x = 0, y = 0;
  if (d !== 0) {
    const sd = 1 / Math.sin(d);
    x = 2 * d * cosphi * Math.sin(c) * sd;
    y = d * Math.sin(phi) * sd;
  }
  return [(x + lam * cosphi1) * 0.5, (y + phi) * 0.5];
}
function wintriInit(this: WintriThis): void {
  this.x0 = this.x0 || 0; this.y0 = this.y0 || 0; this.long0 = this.long0 || 0;
  this.cosphi1 = this.lat1 !== undefined ? Math.cos(this.lat1) : 2 / PI;
}
function wintriForward(this: WintriThis, p: P): P {
  const lam = adjustLon(p.x - this.long0, this.over);
  const [x, y] = wintriUnit(lam, p.y, this.cosphi1);
  p.x = this.a * x + this.x0; p.y = this.a * y + this.y0;
  return p;
}
function wintriInverse(this: WintriThis, p: P): P {
  // Newton on the forward with a numerical Jacobian; the forward is smooth
  // and the start (lam = x, phi = y) is close, so it converges in a few steps.
  const X = (p.x - this.x0) / this.a, Y = (p.y - this.y0) / this.a;
  const k = this.cosphi1;
  let lam = X, phi = Y;
  const h = 1e-7;
  for (let i = 0; i < 30; i++) {
    const [fx, fy] = wintriUnit(lam, phi, k);
    const ex = fx - X, ey = fy - Y;
    if (Math.abs(ex) < 1e-12 && Math.abs(ey) < 1e-12) break;
    const [fxl, fyl] = wintriUnit(lam + h, phi, k);
    const [fxp, fyp] = wintriUnit(lam, phi + h, k);
    const a = (fxl - fx) / h, b = (fxp - fx) / h;
    const c = (fyl - fy) / h, d = (fyp - fy) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-300) break;
    lam -= (d * ex - b * ey) / det;
    phi -= (-c * ex + a * ey) / det;
    if (phi > HALF_PI) phi = PI - phi;
    if (phi < -HALF_PI) phi = -PI - phi;
  }
  if (Math.abs(lam) > PI + EPS) { p.x = NaN; p.y = NaN; return p; }
  p.x = adjustLon(lam + this.long0, this.over); p.y = phi;
  return p;
}

// ---------------------------------------------------------------------------
// Interrupted Goode Homolosine (PROJ: igh.cpp): sinusoidal below 40d44'11.8"
// of latitude, Mollweide above, in twelve lobes with their own meridians.

const D_JUNCTION = (40 + 44 / 60 + 11.8 / 3600) * PI / 180;
const d = (deg: number) => deg * PI / 180;
const MOLL_CX = 0.900316316158, MOLL_CY = 1.4142135623731;

function mollUnit(lam: number, phi: number): [number, number] {
  let theta = phi;
  const con = PI * Math.sin(phi);
  for (let i = 0; i < 50; i++) {
    const dt = -(theta + Math.sin(theta) - con) / (1 + Math.cos(theta));
    theta += dt;
    if (Math.abs(dt) < EPS) break;
  }
  theta /= 2;
  if (HALF_PI - Math.abs(phi) < EPS) lam = 0;
  return [MOLL_CX * lam * Math.cos(theta), MOLL_CY * Math.sin(theta)];
}
function mollUnitInverse(x: number, y: number): [number, number] {
  let arg = y / MOLL_CY;
  if (Math.abs(arg) > 0.999999999999) arg = Math.sign(arg) * 0.999999999999;
  const theta = Math.asin(arg);
  const lam = x / (MOLL_CX * Math.cos(theta));
  const phi = aasin((2 * theta + Math.sin(2 * theta)) / PI);
  return [lam, phi];
}

// The Mollweide lobes are shifted so the two projections meet at the junction.
const IGH_DY0 = (() => {
  const [, ym] = mollUnit(0, D_JUNCTION);
  return Math.abs(D_JUNCTION - ym);   // sinusoidal y is the latitude itself
})();
const IGH_MOLL_SIGN = D_JUNCTION - mollUnit(0, D_JUNCTION)[1] > 0 ? 1 : -1;

interface Lobe { moll: boolean; lam0: number; y0: number; }
const LOBES: Lobe[] = [
  { moll: true,  lam0: d(-100), y0:  IGH_DY0 },
  { moll: true,  lam0: d(30),   y0:  IGH_DY0 },
  { moll: false, lam0: d(-100), y0: 0 },
  { moll: false, lam0: d(30),   y0: 0 },
  { moll: false, lam0: d(-160), y0: 0 },
  { moll: false, lam0: d(-60),  y0: 0 },
  { moll: false, lam0: d(20),   y0: 0 },
  { moll: false, lam0: d(140),  y0: 0 },
  { moll: true,  lam0: d(-160), y0: -IGH_DY0 },
  { moll: true,  lam0: d(-60),  y0: -IGH_DY0 },
  { moll: true,  lam0: d(20),   y0: -IGH_DY0 },
  { moll: true,  lam0: d(140),  y0: -IGH_DY0 }
];

function lobeFor(lam: number, phi: number): number {
  if (phi > D_JUNCTION) return lam <= d(-40) ? 1 : 2;
  if (phi >= 0) return lam <= d(-40) ? 3 : 4;
  if (phi >= -D_JUNCTION) {
    if (lam <= d(-100)) return 5;
    if (lam <= d(-20)) return 6;
    if (lam <= d(80)) return 7;
    return 8;
  }
  if (lam <= d(-100)) return 9;
  if (lam <= d(-20)) return 10;
  if (lam <= d(80)) return 11;
  return 12;
}

function ighInit(this: Base): void {
  this.x0 = this.x0 || 0; this.y0 = this.y0 || 0; this.long0 = this.long0 || 0;
}
function ighForward(this: Base, p: P): P {
  const lam = adjustLon(p.x - this.long0, this.over);
  const phi = p.y;
  const z = LOBES[lobeFor(lam, phi) - 1];
  const l = lam - z.lam0;
  let x: number, y: number;
  if (z.moll) {
    [x, y] = mollUnit(l, phi);
    y += IGH_MOLL_SIGN * z.y0;
  } else {
    x = l * Math.cos(phi); y = phi;
  }
  // Each lobe carries a false easting of its own meridian, so it sits where
  // that meridian is on the whole map rather than at the origin.
  x += z.lam0;
  p.x = this.a * x + this.x0; p.y = this.a * y + this.y0;
  return p;
}
function ighInverse(this: Base, p: P): P {
  const x = (p.x - this.x0) / this.a, y = (p.y - this.y0) / this.a;
  const y90 = IGH_DY0 + Math.SQRT2;
  let zi = 0;
  if (y > y90 + EPS || y < -y90 + EPS) zi = 0;
  else zi = lobeFor(x, y);   // PROJ compares x and y against the same angles
  if (zi === 0) { p.x = NaN; p.y = NaN; return p; }
  const z = LOBES[zi - 1];
  const xl = x - z.lam0;
  let lam: number, phi: number;
  if (z.moll) {
    [lam, phi] = mollUnitInverse(xl, y - IGH_MOLL_SIGN * z.y0);
  } else {
    phi = y;
    lam = Math.abs(Math.abs(phi) - HALF_PI) < EPS ? 0 : xl / Math.cos(phi);
  }
  lam += z.lam0;
  // Is that inside the lobe it came from (and not in an interruption)?
  const between = (lo: number, hi: number, v: number) => v >= d(lo) - EPS && v <= d(hi) + EPS;
  let ok = false;
  switch (zi) {
    case 1: ok = between(-180, -40, lam) || (between(-40, -10, lam) && between(60, 90, phi)); break;
    case 2: ok = between(-40, 180, lam) || (between(-180, -160, lam) && between(50, 90, phi))
                 || (between(-50, -40, lam) && between(60, 90, phi)); break;
    case 3: ok = between(-180, -40, lam); break;
    case 4: ok = between(-40, 180, lam); break;
    case 5: case 9: ok = between(-180, -100, lam); break;
    case 6: case 10: ok = between(-100, -20, lam); break;
    case 7: case 11: ok = between(-20, 80, lam); break;
    case 8: case 12: ok = between(80, 180, lam); break;
  }
  if (!ok) { p.x = NaN; p.y = NaN; return p; }
  p.x = adjustLon(lam + this.long0, this.over); p.y = phi;
  return p;
}

// ---------------------------------------------------------------------------

export const EXTRA_PROJECTIONS = [
  { names: ['Eckert IV', 'eck4'], init: eck4Init, forward: eck4Forward, inverse: eck4Inverse },
  { names: ['Natural Earth', 'natearth'], init: natearthInit, forward: natearthForward, inverse: natearthInverse },
  { names: ['Hammer & Eckert-Greifendorff', 'hammer'], init: hammerInit, forward: hammerForward, inverse: hammerInverse },
  { names: ['Winkel Tripel', 'wintri'], init: wintriInit, forward: wintriForward, inverse: wintriInverse },
  { names: ['Interrupted Goode Homolosine', 'igh'], init: ighInit, forward: ighForward, inverse: ighInverse }
];

let added = false;

/** Register them with proj4js. Idempotent. */
export function registerExtraProjections(): void {
  if (added) return;
  added = true;
  const store = (proj4 as unknown as { Proj: { projections: { add(p: unknown): void } } }).Proj.projections;
  for (const p of EXTRA_PROJECTIONS) store.add(p);
}
