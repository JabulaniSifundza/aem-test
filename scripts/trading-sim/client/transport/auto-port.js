/**
 * Where the in-browser backend runs: a module Worker when the page allows one, otherwise the
 * page's own thread (page-port.js). EDS pages send a strict Content Security Policy; with
 * `worker-src 'self'` and Trusted Types (the worker URL goes through a policy that accepts only
 * this one URL) the Worker is allowed, without them the backend falls back to the page thread.
 * The fallback also covers a Worker that fails to load: messages sent before the Worker answered
 * are replayed to the page port.
 */
import { createPagePort } from './page-port.js';

/** @type {any} */
let policy = null;

/** The worker script's URL, as a TrustedScriptURL where Trusted Types are enforced. */
function workerUrl() {
  const url = new URL('./loopback-worker.js', import.meta.url).href;
  const tt = /** @type {any} */ (globalThis).trustedTypes;
  if (!tt?.createPolicy) return url;
  policy ??= tt.createPolicy('trading-sim-worker', {
    createScriptURL: (/** @type {string} */ u) => {
      if (u !== url) throw new TypeError(`Unexpected worker URL ${u}`);
      return u;
    },
  });
  return policy.createScriptURL(url);
}

/**
 * @param {{ preferWorker?: boolean }} [o] preferWorker false: always the page thread
 * @returns {import('./loopback.js').Port & { kind: () => 'worker' | 'page' }}
 */
export function createAutoPort({ preferWorker = true } = {}) {
  /** @type {Array<(event: { data: any }) => void>} */
  const listeners = [];
  /** @type {object[]} messages sent before the Worker first answered */
  const sent = [];
  let answered = false;
  let onPage = false;
  /** @type {Worker | MessagePort | null} */
  let target = null;

  const usePage = () => {
    if (onPage) return;
    onPage = true;
    if (target && 'terminate' in target) target.terminate();
    const port = createPagePort();
    for (const l of listeners) port.addEventListener('message', l);
    for (const m of sent.splice(0)) port.postMessage(m);
    target = port;
  };

  if (preferWorker && typeof Worker === 'function') {
    try {
      const worker = new Worker(workerUrl(), { type: 'module' });
      worker.addEventListener('error', () => { if (!answered) usePage(); });
      worker.addEventListener('message', () => { answered = true; sent.length = 0; }, { once: true });
      target = worker;
    } catch {
      usePage(); // blocked by the Content Security Policy or Trusted Types
    }
  } else usePage();

  return {
    postMessage(m) {
      if (!answered && !onPage) sent.push(m);
      /** @type {Worker | MessagePort} */ (target).postMessage(m);
    },
    addEventListener(type, l) {
      listeners.push(l);
      /** @type {Worker | MessagePort} */ (target).addEventListener(type, /** @type {any} */ (l));
    },
    terminate() { if (target && 'terminate' in target) target.terminate(); else /** @type {MessagePort | null} */ (target)?.close(); },
    kind: () => (onPage ? 'page' : 'worker'),
  };
}
