/**
 * A transport whose backend runs inside the page (a Web Worker), for DA/EDS pages and demos with
 * no server. It is the normal transport with a fetch and a WebSocket that talk to the Worker,
 * so the datafeed, broker and widgets run exactly the code they run against a real backend.
 */
import { createTransport, urlsFromBase } from './transport.js';
import { createDevTokenSource } from './tokens.js';
import { createAutoPort } from './auto-port.js';

export const LOOPBACK_ORIGIN = 'http://loopback.invalid';

/**
 * @typedef {object} Port  a Worker, or anything with the same two members
 * @property {(message: any) => void} postMessage
 * @property {(type: 'message', listener: (event: { data: any }) => void) => void} addEventListener
 * @property {() => void} [terminate]
 */

/**
 * @param {object} [options]
 * @param {Port} [options.port]       defaults to a Worker running loopback-worker.js, or the page thread where Workers are not allowed
 * @param {string} [options.seed]
 * @param {number} [options.start]    simulated start time (ms)
 * @param {string} [options.startingBalance]
 * @param {string} [options.user]
 * @param {object} [options.socketOptions]
 */
export function createLoopbackTransport({ port, seed, start, startingBalance, user = 'local', socketOptions } = {}) {
  const worker = port ?? createAutoPort();
  worker.postMessage({ kind: 'init', seed, start, startingBalance });

  let nextId = 1;
  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  /** @type {Map<number, LoopbackSocket>} */
  const sockets = new Map();

  worker.addEventListener('message', (event) => {
    const m = event.data;
    if (m.kind === 'response') { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    const socket = sockets.get(m.conn);
    if (!socket) return;
    if (m.kind === 'opened') socket.opened();
    else if (m.kind === 'frame') socket.message(m.data);
    else if (m.kind === 'closed') { sockets.delete(m.conn); socket.closed(); }
  });

  /** @type {typeof fetch} */
  const fetchImpl = (input, init = {}) => {
    const id = nextId++;
    const headers = new Headers(init.headers);
    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) { reject(init.signal.reason); return; }
      pending.set(id, (m) => resolve(new Response(m.body, { status: m.status, headers: { 'content-type': 'application/json' } })));
      worker.postMessage({
        kind: 'fetch', id, url: String(input), method: init.method ?? 'GET',
        contentType: headers.get('content-type') ?? '', authorization: headers.get('authorization') ?? '',
        body: typeof init.body === 'string' ? init.body : undefined,
      });
    });
  };

  /** The subset of WebSocket that client/transport/socket.js uses. */
  class LoopbackSocket {
    /** @param {string} url */
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.conn = nextId++;
      /** @type {(() => void) | null} */ this.onopen = null;
      /** @type {((e: { data: string }) => void) | null} */ this.onmessage = null;
      /** @type {(() => void) | null} */ this.onclose = null;
      /** @type {(() => void) | null} */ this.onerror = null;
      sockets.set(this.conn, this);
      worker.postMessage({ kind: 'open', conn: this.conn, url });
    }
    opened() { this.readyState = 1; this.onopen?.(); }
    /** @param {string} data */
    message(data) { if (this.readyState === 1) this.onmessage?.({ data }); }
    closed() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
    /** @param {string} data */
    send(data) { if (this.readyState === 1) worker.postMessage({ kind: 'frame', conn: this.conn, data }); }
    close() {
      if (this.readyState === 3) return;
      worker.postMessage({ kind: 'close', conn: this.conn });
      this.readyState = 2;
    }
  }

  const tokens = createDevTokenSource({ authUrl: `${LOOPBACK_ORIGIN}/trade/v1/auth`, user, fetchImpl });
  const transport = createTransport({
    urls: urlsFromBase(LOOPBACK_ORIGIN), tokens, fetchImpl,
    WebSocketImpl: /** @type {typeof WebSocket} */ (/** @type {unknown} */ (LoopbackSocket)), socketOptions,
  });
  return {
    ...transport,
    close() {
      transport.close();
      worker.terminate?.();
    },
  };
}
