/* tslint:disable */
/* eslint-disable */

export class Point {
    free(): void;
    [Symbol.dispose](): void;
    constructor(x: number, y: number, z: number);
    x: number;
    y: number;
    z: number;
}

export class Projection {
    free(): void;
    [Symbol.dispose](): void;
    constructor(defn: string);
    readonly axis: string;
    readonly isGeocentric: boolean;
    readonly isLatlon: boolean;
    readonly isNormalizedAxis: boolean;
    readonly projName: string;
    readonly to_meter: number;
    readonly units: string;
}

export class Warper {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `src_gt` / `dst_gt`: GDAL geotransforms `[x0, dx, rx, y0, ry, dy]`.
     * `max_error`: approximation threshold in source pixels (GDAL default 0.125).
     */
    constructor(src_crs: string, src_gt: Float64Array, dst_crs: string, dst_gt: Float64Array, max_error: number);
    /**
     * Source pixel window needed for a `dst_w` x `dst_h` destination tile,
     * given the full source raster is `src_w` x `src_h` pixels.
     * Returns `[xoff, yoff, xsize, ysize]`, or `undefined` if the tile does
     * not intersect the source at all.
     */
    source_window(dst_w: number, dst_h: number, src_w: number, src_h: number, padding: number): Int32Array | undefined;
    /**
     * Warp a single-band `Float32Array` (`src_w * src_h`) into a
     * `dst_w * dst_h` `Float32Array` of values. Pass `nodata` as NaN for
     * "none"; unmapped output pixels are `nodata` (or NaN).
     */
    warp_f32(src: Float32Array, src_w: number, src_h: number, src_xoff: number, src_yoff: number, dst_w: number, dst_h: number, nodata: number, alg: string): Float32Array;
    /**
     * Warp an RGBA buffer (`src_w * src_h * 4` bytes) whose top-left pixel
     * sits at `(src_xoff, src_yoff)` in the full source raster, into a
     * `dst_w * dst_h * 4` RGBA buffer. `alg` is one of
     * `nearest | bilinear | cubic | lanczos`.
     */
    warp_rgba(src: Uint8Array, src_w: number, src_h: number, src_xoff: number, src_yoff: number, dst_w: number, dst_h: number, alg: string): Uint8Array;
}

/**
 * Read a binary NTv2 from Dataview.
 *
 * Note: only NTv2 file format are supported.
 */
export function add_nadgrid(key: string, view: DataView): void;

/**
 * Inverse of [`lonlat_to_crs`]: `[lon, lat]` in degrees or `undefined`.
 */
export function crs_to_lonlat(crs: string, x: number, y: number): Float64Array | undefined;

/**
 * Project a lon/lat (degrees, WGS84) into `crs`. Returns `[x, y]` or
 * `undefined`. Lets the page place markers and read coordinates without a
 * JavaScript PROJ.
 */
export function lonlat_to_crs(crs: string, lon: number, lat: number): Float64Array | undefined;

export function transform(src: Projection, dst: Projection, point: Point): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_point_x: (a: number) => number;
    readonly __wbg_get_point_y: (a: number) => number;
    readonly __wbg_get_point_z: (a: number) => number;
    readonly __wbg_point_free: (a: number, b: number) => void;
    readonly __wbg_projection_free: (a: number, b: number) => void;
    readonly __wbg_set_point_x: (a: number, b: number) => void;
    readonly __wbg_set_point_y: (a: number, b: number) => void;
    readonly __wbg_set_point_z: (a: number, b: number) => void;
    readonly __wbg_warper_free: (a: number, b: number) => void;
    readonly add_nadgrid: (a: number, b: number, c: any) => [number, number];
    readonly crs_to_lonlat: (a: number, b: number, c: number, d: number) => [number, number];
    readonly lonlat_to_crs: (a: number, b: number, c: number, d: number) => [number, number];
    readonly point_new: (a: number, b: number, c: number) => number;
    readonly projection_axis: (a: number) => [number, number];
    readonly projection_isGeocentric: (a: number) => number;
    readonly projection_isLatlon: (a: number) => number;
    readonly projection_isNormalizedAxis: (a: number) => number;
    readonly projection_new: (a: number, b: number) => [number, number, number];
    readonly projection_projName: (a: number) => [number, number];
    readonly projection_to_meter: (a: number) => number;
    readonly projection_units: (a: number) => [number, number];
    readonly transform: (a: number, b: number, c: number) => [number, number];
    readonly warper_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly warper_source_window: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly warper_warp_f32: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly warper_warp_rgba: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
