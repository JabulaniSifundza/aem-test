/**
 * Web Worker entry for the loopback backend: the simulation runs here, off the page's main thread.
 * The page sends { kind: 'init', seed, start, startingBalance } first.
 */
import { createLoopbackCore } from '../../service/loopback.js';

const scope = /** @type {{ postMessage(m: object): void, onmessage: ((e: MessageEvent) => void) | null }} */ (/** @type {unknown} */ (globalThis));
/** @type {ReturnType<typeof createLoopbackCore> | null} */
let core = null;
/** @type {object[]} */
const early = [];

scope.onmessage = (/** @type {MessageEvent} */ event) => {
  const m = event.data;
  if (m && m.kind === 'init') {
    core ??= createLoopbackCore({ post: (msg) => scope.postMessage(msg), seed: m.seed, start: m.start, startingBalance: m.startingBalance });
    for (const queued of early.splice(0)) core.onMessage(queued);
    return;
  }
  if (core) core.onMessage(m);
  else early.push(m);
};
