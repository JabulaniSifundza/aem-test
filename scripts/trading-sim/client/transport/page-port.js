/**
 * The loopback backend on the page's own thread, behind a MessageChannel, for pages whose
 * Content Security Policy does not allow module Workers (EDS pages: script-src 'strict-dynamic'
 * and Trusted Types). Same messages as loopback-worker.js, so the transport cannot tell the
 * difference. The simulation is light (four ticks a second), so the main thread copes.
 */
import { createLoopbackCore } from '../../service/loopback.js';

/** @returns {MessagePort} a port to pass to createLoopbackTransport({ port }) */
export function createPagePort() {
  const { port1, port2 } = new MessageChannel();
  /** @type {ReturnType<typeof createLoopbackCore> | null} */
  let core = null;
  /** @type {object[]} */
  const early = [];
  port1.onmessage = (event) => {
    const m = event.data;
    if (m && m.kind === 'init') {
      core ??= createLoopbackCore({ post: (msg) => port1.postMessage(msg), seed: m.seed, start: m.start, startingBalance: m.startingBalance });
      for (const queued of early.splice(0)) core.onMessage(queued);
      return;
    }
    if (core) core.onMessage(m);
    else early.push(m);
  };
  port2.start();
  return port2;
}
