/**
 * A resilient WebSocket (spec §10, requirement M-11):
 * - authenticates with the first frame and re-authenticates in place when the token is refreshed
 * - pings every 15 s; if nothing comes back within 10 s, it reconnects
 * - reconnects with exponential backoff and jitter (0.5 s doubling to 30 s)
 * - remembers subscriptions and sends them again after every reconnect
 * - tells listeners when it reconnected, so they can reload anything they may have missed
 */

/** @typedef {'connecting' | 'open' | 'closed'} SocketStatus */

/**
 * @param {object} options
 * @param {string} options.url
 * @param {() => Promise<string>} options.getToken
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.timeoutMs]
 * @param {{ initial: number, max: number, factor: number }} [options.backoff]
 * @param {() => number} [options.random]
 */
export function createSocket({
  url, getToken, WebSocketImpl = globalThis.WebSocket, heartbeatMs = 15_000, timeoutMs = 10_000,
  backoff = { initial: 500, max: 30_000, factor: 2 }, random = Math.random,
}) {
  /** @type {WebSocket | null} */
  let ws = null;
  /** @type {SocketStatus} */
  let status = 'closed';
  let attempts = 0;
  let everOpened = false;
  let stopped = true;
  let lastHeard = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let heartbeat = null;
  /** @type {Map<string, { subscribe: object, unsubscribe: object }>} */
  const subscriptions = new Map();
  /** @type {Set<(frame: any) => void>} */
  const frameListeners = new Set();
  /** @type {Set<(status: SocketStatus) => void>} */
  const statusListeners = new Set();
  /** @type {Set<() => void>} */
  const reconnectListeners = new Set();

  /** @param {SocketStatus} next */
  function setStatus(next) {
    if (status === next) return;
    status = next;
    for (const l of statusListeners) l(next);
  }

  /** @param {object} frame */
  function rawSend(frame) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  }

  function connect() {
    if (stopped) return;
    setStatus('connecting');
    let socket;
    try { socket = new WebSocketImpl(url); } catch { scheduleRetry(); return; }
    ws = socket;
    socket.onopen = async () => {
      lastHeard = Date.now();
      try { rawSend({ action: 'auth', token: await getToken() }); } catch { socket.close(); }
    };
    socket.onmessage = (event) => {
      lastHeard = Date.now();
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame.type === 'auth_ok') {
        if (status !== 'open') {
          const reconnected = everOpened;
          everOpened = true;
          attempts = 0;
          setStatus('open');
          for (const s of subscriptions.values()) rawSend(s.subscribe);
          if (reconnected) for (const l of reconnectListeners) l();
        }
        return;
      }
      if (frame.type === 'pong') return;
      for (const l of frameListeners) l(frame);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      setStatus('closed');
      scheduleRetry();
    };
    socket.onerror = () => { /* onclose follows */ };
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const delay = Math.min(backoff.max, backoff.initial * backoff.factor ** attempts) * (0.5 + random() / 2);
    attempts += 1;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - lastHeard > heartbeatMs + timeoutMs) { ws.close(); return; }
      rawSend({ action: 'ping', t: Date.now() });
    }, heartbeatMs);
  }

  return {
    /** Start connecting (idempotent). */
    open() {
      if (!stopped) return;
      stopped = false;
      startHeartbeat();
      connect();
    },
    /** Stop for good. */
    close() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (heartbeat) clearInterval(heartbeat);
      retryTimer = null;
      heartbeat = null;
      const socket = ws;
      ws = null;
      socket?.close();
      setStatus('closed');
    },
    /**
     * Keep a subscription alive across reconnects. Returns a function that ends it.
     * @param {string} key @param {object} subscribe @param {object} unsubscribe
     */
    subscribe(key, subscribe, unsubscribe) {
      subscriptions.set(key, { subscribe, unsubscribe });
      if (status === 'open') rawSend(subscribe);
      return () => {
        if (subscriptions.get(key)?.subscribe !== subscribe) return;
        subscriptions.delete(key);
        if (status === 'open') rawSend(unsubscribe);
      };
    },
    /** Send a new token on the open connection (token refresh without reconnecting). @param {string} token */
    reauthenticate(token) { if (status === 'open') rawSend({ action: 'auth', token }); },
    /** Force a reconnect (used by tests and after the network comes back). */
    reconnect() { ws?.close(); },
    /** @param {(frame: any) => void} cb */
    onFrame(cb) { frameListeners.add(cb); return () => frameListeners.delete(cb); },
    /** @param {(status: SocketStatus) => void} cb */
    onStatus(cb) { statusListeners.add(cb); return () => statusListeners.delete(cb); },
    /** @param {() => void} cb */
    onReconnect(cb) { reconnectListeners.add(cb); return () => reconnectListeners.delete(cb); },
    get status() { return status; },
  };
}

/** @typedef {ReturnType<typeof createSocket>} Socket */
