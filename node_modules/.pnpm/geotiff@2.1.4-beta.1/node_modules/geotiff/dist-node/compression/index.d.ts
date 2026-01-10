/**
 * Either a number or undefined.
 * @typedef {(number|undefined)} NumberOrUndefined
 */
/**
 * Register a decoder for a specific compression method or a range of compressions
 * @param {(NumberOrUndefined|(NumberOrUndefined[]))} cases ids of the compression methods to register for
 * @param {function():Promise} importFn the function to import the decoder
 * @param {boolean} preferWorker_ Whether to prefer running the decoder in a worker
 */
export function addDecoder(cases: (NumberOrUndefined | (NumberOrUndefined[])), importFn: () => Promise<any>, preferWorker_?: boolean): void;
/**
 * Get a decoder for a specific file directory
 * @param {object} fileDirectory the file directory of the image
 * @returns {Promise<Decoder>}
 */
export function getDecoder(fileDirectory: object): Promise<any>;
/**
 * Whether to prefer running the decoder in a worker
 * @param {object} fileDirectory the file directory of the image
 * @returns {boolean}
 */
export function preferWorker(fileDirectory: object): boolean;
/**
 * Either a number or undefined.
 */
export type NumberOrUndefined = (number | undefined);
//# sourceMappingURL=index.d.ts.map