"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* global globalThis */
/* eslint-disable import/no-mutable-exports */
const index_js_1 = require("../compression/index.js");
const worker = globalThis;
worker.addEventListener('message', async (e) => {
    const { fileDirectory, buffer, ...extra } = e.data;
    try {
        const decoder = await (0, index_js_1.getDecoder)(fileDirectory);
        const decoded = await decoder.decode(fileDirectory, buffer);
        worker.postMessage({ decoded, ...extra }, [decoded]);
    }
    catch (error) {
        worker.postMessage({ error: error.message, ...extra });
    }
});
//# sourceMappingURL=decoder.js.map