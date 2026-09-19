/**
 * Main-thread handle on the warp worker: one worker, jobs by id.
 */
import type { WarpJob, WarpBackendName } from '../core/warp';
import type { WarpMessage, WarpReply } from './warpWorker';

export interface WarpOutcome {
  backend: WarpBackendName;
  note?: string;
  ms: number;
  rgba?: Uint8ClampedArray;
  float?: Float32Array;
}

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (r: WarpOutcome) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./warpWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WarpReply>) => {
    const r = e.data;
    const w = waiting.get(r.id);
    if (!w) return;
    waiting.delete(r.id);
    if (r.ok) w.resolve({ backend: r.backend!, note: r.note, ms: r.ms ?? 0, rgba: r.rgba, float: r.float });
    else w.reject(new Error(r.error ?? 'warp failed'));
  };
  worker.onerror = (e) => console.error('warp worker error:', e.message);
  const init: WarpMessage = {
    type: 'init',
    rwarpBase: new URL('rwarp/', document.baseURI).href,
    projWasmBase: new URL('proj-wasm/', document.baseURI).href
  };
  worker.postMessage(init);
  return worker;
}

/** Run a warp in the worker. The job's buffer is transferred, not copied. */
export function warpInWorker(job: WarpJob, prefer: 'rwarp' | 'reference'): Promise<WarpOutcome> {
  const w = ensureWorker();
  const id = nextId++;
  const transfer: Transferable[] = [];
  if (job.rgba) transfer.push(job.rgba.buffer);
  if (job.float) transfer.push(job.float.buffer);
  const msg: WarpMessage = { type: 'warp', id, job, prefer };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage(msg, transfer);
  });
}
