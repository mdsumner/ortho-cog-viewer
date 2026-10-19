/* @ts-self-types="./rwarp_wasm.d.ts" */

export class Point {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PointFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_point_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get x() {
        const ret = wasm.__wbg_get_point_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get y() {
        const ret = wasm.__wbg_get_point_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get z() {
        const ret = wasm.__wbg_get_point_z(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    constructor(x, y, z) {
        const ret = wasm.point_new(x, y, z);
        this.__wbg_ptr = ret;
        PointFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} arg0
     */
    set x(arg0) {
        wasm.__wbg_set_point_x(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set y(arg0) {
        wasm.__wbg_set_point_y(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set z(arg0) {
        wasm.__wbg_set_point_z(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) Point.prototype[Symbol.dispose] = Point.prototype.free;

export class Projection {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projection_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get axis() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.projection_axis(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {boolean}
     */
    get isGeocentric() {
        const ret = wasm.projection_isGeocentric(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    get isLatlon() {
        const ret = wasm.projection_isLatlon(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    get isNormalizedAxis() {
        const ret = wasm.projection_isNormalizedAxis(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {string} defn
     */
    constructor(defn) {
        const ptr0 = passStringToWasm0(defn, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projection_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ProjectionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {string}
     */
    get projName() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.projection_projName(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get to_meter() {
        const ret = wasm.projection_to_meter(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get units() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.projection_units(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) Projection.prototype[Symbol.dispose] = Projection.prototype.free;

export class Warper {
    static __wrap(ptr) {
        const obj = Object.create(Warper.prototype);
        obj.__wbg_ptr = ptr;
        WarperFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WarperFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_warper_free(ptr, 0);
    }
    /**
     * `src_gt` / `dst_gt`: GDAL geotransforms `[x0, dx, rx, y0, ry, dy]`.
     * `max_error`: approximation threshold in source pixels (GDAL default 0.125).
     * @param {string} src_crs
     * @param {Float64Array} src_gt
     * @param {string} dst_crs
     * @param {Float64Array} dst_gt
     * @param {number} max_error
     */
    constructor(src_crs, src_gt, dst_crs, dst_gt, max_error) {
        const ptr0 = passStringToWasm0(src_crs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(src_gt, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(dst_crs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(dst_gt, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.warper_new(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, max_error);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WarperFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Source pixel window needed for a `dst_w` x `dst_h` destination tile,
     * given the full source raster is `src_w` x `src_h` pixels.
     * Returns `[xoff, yoff, xsize, ysize]`, or `undefined` if the tile does
     * not intersect the source at all.
     * @param {number} dst_w
     * @param {number} dst_h
     * @param {number} src_w
     * @param {number} src_h
     * @param {number} padding
     * @returns {Int32Array | undefined}
     */
    source_window(dst_w, dst_h, src_w, src_h, padding) {
        const ret = wasm.warper_source_window(this.__wbg_ptr, dst_w, dst_h, src_w, src_h, padding);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        }
        return v1;
    }
    /**
     * Warp a single-band `Float32Array` (`src_w * src_h`) into a
     * `dst_w * dst_h` `Float32Array` of values. Pass `nodata` as NaN for
     * "none"; unmapped output pixels are `nodata` (or NaN).
     * @param {Float32Array} src
     * @param {number} src_w
     * @param {number} src_h
     * @param {number} src_xoff
     * @param {number} src_yoff
     * @param {number} dst_w
     * @param {number} dst_h
     * @param {number} nodata
     * @param {string} alg
     * @returns {Float32Array}
     */
    warp_f32(src, src_w, src_h, src_xoff, src_yoff, dst_w, dst_h, nodata, alg) {
        const ptr0 = passArrayF32ToWasm0(src, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(alg, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.warper_warp_f32(this.__wbg_ptr, ptr0, len0, src_w, src_h, src_xoff, src_yoff, dst_w, dst_h, nodata, ptr1, len1);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v3;
    }
    /**
     * Warp an RGBA buffer (`src_w * src_h * 4` bytes) whose top-left pixel
     * sits at `(src_xoff, src_yoff)` in the full source raster, into a
     * `dst_w * dst_h * 4` RGBA buffer. `alg` is one of
     * `nearest | bilinear | cubic | lanczos`.
     * @param {Uint8Array} src
     * @param {number} src_w
     * @param {number} src_h
     * @param {number} src_xoff
     * @param {number} src_yoff
     * @param {number} dst_w
     * @param {number} dst_h
     * @param {string} alg
     * @returns {Uint8Array}
     */
    warp_rgba(src, src_w, src_h, src_xoff, src_yoff, dst_w, dst_h, alg) {
        const ptr0 = passArray8ToWasm0(src, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(alg, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.warper_warp_rgba(this.__wbg_ptr, ptr0, len0, src_w, src_h, src_xoff, src_yoff, dst_w, dst_h, ptr1, len1);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * Build a warper whose CRS transforms are JavaScript functions rather
     * than proj4rs: `dst_to_src(x, y, out)` and `src_to_dst(x, y, out)`
     * each write `[x, y]` into `out` (a `Float64Array` of length 2) and
     * return `true`, or return `false` for a point they cannot transform.
     * Everything downstream - the approximate transformer, the source
     * window, the kernels - is the same as for `new`; only who does the
     * projecting changes. This is how a page with proj4js or a PROJ build
     * lends rwarp a projection proj4rs does not have.
     * @param {Float64Array} src_gt
     * @param {Float64Array} dst_gt
     * @param {any} dst_to_src
     * @param {any} src_to_dst
     * @param {number} max_error
     * @returns {Warper}
     */
    static withTransforms(src_gt, dst_gt, dst_to_src, src_to_dst, max_error) {
        const ptr0 = passArrayF64ToWasm0(src_gt, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(dst_gt, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.warper_withTransforms(ptr0, len0, ptr1, len1, dst_to_src, src_to_dst, max_error);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Warper.__wrap(ret[0]);
    }
}
if (Symbol.dispose) Warper.prototype[Symbol.dispose] = Warper.prototype.free;

/**
 * @param {string} key
 * @param {Uint8Array} array
 */
export function add_nadgrid(key, array) {
    const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.add_nadgrid(ptr0, len0, array);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Inverse of [`lonlat_to_crs`]: `[lon, lat]` in degrees or `undefined`.
 * @param {string} crs
 * @param {number} x
 * @param {number} y
 * @returns {Float64Array | undefined}
 */
export function crs_to_lonlat(crs, x, y) {
    const ptr0 = passStringToWasm0(crs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.crs_to_lonlat(ptr0, len0, x, y);
    let v2;
    if (ret[0] !== 0) {
        v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    }
    return v2;
}

/**
 * Project a lon/lat (degrees, WGS84) into `crs`. Returns `[x, y]` or
 * `undefined`. Lets the page place markers and read coordinates without a
 * JavaScript PROJ.
 * @param {string} crs
 * @param {number} lon
 * @param {number} lat
 * @returns {Float64Array | undefined}
 */
export function lonlat_to_crs(crs, lon, lat) {
    const ptr0 = passStringToWasm0(crs, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.lonlat_to_crs(ptr0, len0, lon, lat);
    let v2;
    if (ret[0] !== 0) {
        v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    }
    return v2;
}

/**
 * @param {Projection} src
 * @param {Projection} dst
 * @param {Point} point
 */
export function transform(src, dst, point) {
    _assertClass(src, Projection);
    _assertClass(dst, Projection);
    _assertClass(point, Point);
    const ret = wasm.transform(src.__wbg_ptr, dst.__wbg_ptr, point.__wbg_ptr);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_falsy_16bd49b68658263e: function(arg0) {
            const ret = !arg0;
            return ret;
        },
        __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_939a2607c4484b0b: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = arg0.call(arg1, arg2, arg3, arg4);
            return ret;
        }, arguments); },
        __wbg_get_index_f4750150bb3083b3: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_length_7f3c00c40364105e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_with_length_3827645dc5adb679: function(arg0) {
            const ret = new Float64Array(arg0 >>> 0);
            return ret;
        },
        __wbg_parseFloat_a9cb882d5665c6cb: function(arg0, arg1) {
            const ret = parseFloat(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_parseInt_9756a56948abd94c: function(arg0, arg1, arg2) {
            const ret = parseInt(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        },
        __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./rwarp_wasm_bg.js": import0,
    };
}

const PointFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_point_free(ptr, 1));
const ProjectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projection_free(ptr, 1));
const WarperFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_warper_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('rwarp_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
