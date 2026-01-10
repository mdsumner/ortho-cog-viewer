export function assign(target: any, source: any): void;
export function chunk(iterable: any, length: any): any[][];
export function endsWith(string: any, expectedEnding: any): boolean;
export function forEach(iterable: any, func: any): void;
export function invert(oldObj: any): {};
export function range(n: any): number[];
export function times(numTimes: any, func: any): any[];
export function toArray(iterable: any): any[];
export function toArrayRecursively(input: any): any;
export function parseContentRange(headerValue: any): {
    unit: string | null;
    first: number;
    last: number;
    length: number | null;
} | {
    unit: string | null;
    first: null;
    last: null;
    length: number | null;
} | null;
export function wait(milliseconds: any): Promise<any>;
export function zip(a: any, b: any): any[][];
export function isTypedFloatArray(input: any): boolean;
export function isTypedIntArray(input: any): boolean;
export function isTypedUintArray(input: any): boolean;
export class AbortError extends Error {
    constructor(params: any);
}
export class CustomAggregateError extends Error {
    constructor(errors: any, message: any);
    errors: any;
}
export const AggregateError: typeof CustomAggregateError;
export namespace typeMap {
    const Float64Array: Float64ArrayConstructor;
    const Float32Array: Float32ArrayConstructor;
    const Uint32Array: Uint32ArrayConstructor;
    const Uint16Array: Uint16ArrayConstructor;
    const Uint8Array: Uint8ArrayConstructor;
}
//# sourceMappingURL=utils.d.ts.map