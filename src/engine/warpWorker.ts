/**
 * The warp worker: rwarp (or the reference) off the main thread.
 *
 * One worker serves every warp engine. A job's source buffer is transferred
 * in and the result transferred out, so a screen-sized warp costs the main
 * thread two messages. core/ is worker-safe, so the CRS machinery here is
 * the same code the page runs, with PROJ available through its own nested
 * worker for the CRSs proj4js cannot execute.
 */
import { WarpBackend, WarpBackendName, WarpJob, loadRwarp, referenceBackend } from '../core/warp';
import { registerProjections, resolveCRS, setDefinitionProvider } from '../core/crs';
import { projWasmProvider, setProjWasmBase } from '../core/projwasm';

export interface WarpInit { type: 'init'; rwarpBase: string; projWasmBase: string; }
export interface WarpRequest { type: 'warp'; id: number; job: WarpJob; prefer: 'rwarp' | 'reference'; }
export type WarpMessage = WarpInit | WarpRequest;
export interface WarpReply {
  type: 'result';
  id: number;
  ok: boolean;
  backend?: WarpBackendName;
  /** why rwarp was not used, when it was asked for */
  note?: string;
  ms?: number;
  rgba?: Uint8ClampedArray;
  float?: Float32Array;
  error?: string;
}

let rwarp: Promise<WarpBackend | null> | null = null;

function post(msg: WarpReply, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = async (e: MessageEvent<WarpMessage>) => {
  const m = e.data;
  if (m.type === 'init') {
    registerProjections();
    setProjWasmBase(m.projWasmBase);
    setDefinitionProvider(projWasmProvider);
    rwarp = loadRwarp(m.rwarpBase).catch((err) => {
      console.warn('rwarp not available:', err);
      return null;
    });
    return;
  }
  if (m.type !== 'warp') return;
  const { id, job } = m;
  try {
    // The CRS strings are definitions, but a PROJ-only one still has to be
    // known to this worker's own registry before geoTransform can run it.
    await resolveCRS(job.dstCrs);
    await resolveCRS(job.srcCrs);
    let backend: WarpBackend | null = null;
    let note: string | undefined;
    if (m.prefer === 'rwarp') {
      const r = rwarp ? await rwarp : null;
      if (!r) note = 'rwarp not loaded';
      else {
        const why = await r.accepts(job.srcCrs, job.dstCrs);
        if (why) note = why;
        else backend = r;
      }
    }
    if (!backend) {
      const why = await referenceBackend.accepts(job.srcCrs, job.dstCrs);
      if (why) throw new Error(note ? `${note}; ${why}` : why);
      backend = referenceBackend;
    }
    const res = await backend.warp(job);
    const transfer: Transferable[] = [];
    if (res.rgba) transfer.push(res.rgba.buffer);
    if (res.float) transfer.push(res.float.buffer);
    post({ type: 'result', id, ok: true, backend: res.backend, note, ms: res.ms, rgba: res.rgba, float: res.float }, transfer);
  } catch (err) {
    post({ type: 'result', id, ok: false, error: String((err as Error).message ?? err) });
  }
};
