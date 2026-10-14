/**
 * The two streams of docs/PROTOCOL.md, without sockets: market data (ticks, quotes) and the
 * trading gateway (order book depth and the user's trade events). The Node server wraps each
 * WebSocket in a session; the browser loopback wraps each port in one. tick(now) drives
 * everything: it advances the gateway and pushes what changed.
 *
 * Every session must authenticate first ({ action: "auth", token }) and can re-authenticate with
 * a fresh token at any time without reconnecting (SEC-1, SEC-2). A session whose token expires
 * is closed.
 */
import { ACTIONS, DEPTH_LEVELS } from '../shared/protocol.js';
import { getSymbol } from '../shared/symbols.js';

/** @typedef {'marketdata' | 'trade'} StreamService */
/** @typedef {(frame: object) => void} Send */
/** @typedef {{ user: string, expiresAt: number }} Identity */

/** Most ticks sent for one symbol in one tick() call; beyond that, clients are told to reload. */
const MAX_TICKS_PER_PUSH = 500;
const AUTH_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} Session
 * @property {StreamService} service
 * @property {Send} send
 * @property {() => void} close
 * @property {string | null} user
 * @property {number} expiresAt
 * @property {number} openedAt
 * @property {Map<string, number>} bars      symbol → number of bar subscriptions (any resolution)
 * @property {Set<string>} quotes
 * @property {Set<string>} depth
 */

/**
 * @param {object} deps
 * @param {import('../engine/market.js').Market} deps.market
 * @param {import('../engine/gateway.js').Gateway} deps.gateway
 * @param {import('./router.js').Router} deps.router
 * @param {(token: string) => Identity | null} deps.verify
 * @param {() => number} deps.now          the simulation clock
 * @param {() => number} [deps.realNow]    wall-clock time, for token expiry (tokens live in real time)
 */
export function createHub({ market, gateway, router, verify, now, realNow = () => Date.now() }) {
  /** @type {Set<Session>} */
  const sessions = new Set();
  /** @type {Map<string, number>} symbol → time of the last tick pushed */
  const lastPushed = new Map();
  /** @type {Map<string, { bids: Map<number, number>, asks: Map<number, number> }>} last book sent per symbol */
  const lastBook = new Map();

  gateway.subscribe((event) => {
    const { user, ...frame } = event;
    for (const s of sessions) if (s.service === 'trade' && s.user === user) s.send(frame);
  });

  /** @param {Session} s @param {string} message @param {string} [code] */
  const error = (s, message, code = 'bad_request') => s.send({ type: 'error', code, message });

  /**
   * The book for a symbol as a full snapshot, or as changes since the last push to everyone.
   * Snapshots for new subscribers don't move the shared "last pushed" book.
   * @param {string} symbol @param {boolean} snapshot
   */
  function bookFrame(symbol, snapshot) {
    const b = market.book(symbol, now());
    const bids = new Map(b.bids.slice(0, DEPTH_LEVELS));
    const asks = new Map(b.asks.slice(0, DEPTH_LEVELS));
    /** @param {Map<number, number>} m */
    const all = (m) => [...m].map(([p, q]) => /** @type {[string, string]} */ ([market.priceString(symbol, p), market.qtyString(symbol, q)]));
    const prev = lastBook.get(symbol);
    if (snapshot || !prev) {
      if (!prev) lastBook.set(symbol, { bids, asks });
      return { full: { type: 'l2', symbol, isSnapshot: true, asks: all(asks), bids: all(bids) }, delta: null };
    }
    lastBook.set(symbol, { bids, asks });
    /** @param {Map<number, number>} next @param {Map<number, number>} old */
    const diff = (next, old) => {
      /** @type {Array<[string, string]>} */
      const out = [];
      for (const [p, q] of next) if (old.get(p) !== q) out.push([market.priceString(symbol, p), market.qtyString(symbol, q)]);
      for (const p of old.keys()) if (!next.has(p)) out.push([market.priceString(symbol, p), '0']);
      return out;
    };
    return { full: null, delta: { type: 'l2', symbol, isSnapshot: false, asks: diff(asks, prev.asks), bids: diff(bids, prev.bids) } };
  }

  /** @param {Session} s @param {any} frame */
  function receive(s, frame) {
    if (!frame || typeof frame !== 'object' || typeof frame.action !== 'string') return error(s, 'Frames must be JSON objects with an action');
    const t = now();
    if (frame.action === ACTIONS.PING) return s.send({ type: 'pong', t: frame.t ?? t });
    if (frame.action === ACTIONS.AUTH) {
      const id = typeof frame.token === 'string' ? verify(frame.token) : null;
      if (!id || id.expiresAt <= realNow()) { error(s, 'Invalid or expired token', 'unauthorized'); return s.close(); }
      if (s.user && s.user !== id.user) { error(s, 'A session cannot change user', 'unauthorized'); return s.close(); }
      s.user = id.user;
      s.expiresAt = id.expiresAt;
      return s.send({ type: 'auth_ok', user: id.user, expiresAt: id.expiresAt });
    }
    if (!s.user) return error(s, 'Authenticate first: { "action": "auth", "token": "…" }', 'unauthorized');

    /** @param {unknown} name */
    const symbol = (name) => {
      const def = getSymbol(String(name ?? ''));
      if (!def) { error(s, `Unknown symbol "${name}"`, 'unknown_symbol'); return null; }
      return def.name;
    };

    if (s.service === 'marketdata') {
      switch (frame.action) {
        case ACTIONS.SUBSCRIBE_BARS: {
          const name = symbol(frame.symbol);
          if (name) { s.bars.set(name, (s.bars.get(name) ?? 0) + 1); if (!lastPushed.has(name)) lastPushed.set(name, t); }
          return;
        }
        case ACTIONS.UNSUBSCRIBE_BARS: {
          const name = symbol(frame.symbol);
          if (name) { const n = (s.bars.get(name) ?? 0) - 1; if (n > 0) s.bars.set(name, n); else s.bars.delete(name); }
          return;
        }
        case ACTIONS.SUBSCRIBE_QUOTES:
          for (const n of Array.isArray(frame.symbols) ? frame.symbols : []) {
            const name = symbol(n);
            if (name) { s.quotes.add(name); s.send({ type: 'quote', data: router.quote(name, t) }); if (!lastPushed.has(name)) lastPushed.set(name, t); }
          }
          return;
        case ACTIONS.UNSUBSCRIBE_QUOTES:
          for (const n of Array.isArray(frame.symbols) ? frame.symbols : []) s.quotes.delete(getSymbol(String(n))?.name ?? '');
          return;
        default:
          return error(s, `Unknown action "${frame.action}" on the market data stream`);
      }
    }
    switch (frame.action) {
      case ACTIONS.SUBSCRIBE_L2: {
        const name = symbol(frame.symbol);
        if (!name) return;
        if (frame.depthLevels !== undefined && frame.depthLevels !== DEPTH_LEVELS) return error(s, `depthLevels must be ${DEPTH_LEVELS}`);
        s.depth.add(name);
        s.send(/** @type {object} */ (bookFrame(name, true).full));
        return;
      }
      case ACTIONS.UNSUBSCRIBE_L2: {
        const name = symbol(frame.symbol);
        if (name) s.depth.delete(name);
        return;
      }
      default:
        return error(s, `Unknown action "${frame.action}" on the trading stream`);
    }
  }

  /**
   * Advance time: run the gateway, then push ticks, quotes and depth that changed.
   * @param {number} [t]
   */
  function tick(t = now()) {
    gateway.step(t);
    const wall = realNow();
    for (const s of [...sessions]) {
      if (!s.user && wall - s.openedAt > AUTH_TIMEOUT_MS) { error(s, 'No auth frame received', 'unauthorized'); s.close(); }
      else if (s.user && s.expiresAt <= wall) { error(s, 'Token expired', 'token_expired'); s.close(); }
    }

    /** @type {Set<string>} */
    const marketSymbols = new Set();
    /** @type {Set<string>} */
    const depthSymbols = new Set();
    for (const s of sessions) {
      if (!s.user) continue;
      for (const n of s.bars.keys()) marketSymbols.add(n);
      for (const n of s.quotes) marketSymbols.add(n);
      for (const n of s.depth) depthSymbols.add(n);
    }

    for (const name of marketSymbols) {
      const from = lastPushed.get(name) ?? t;
      lastPushed.set(name, t);
      const ticks = market.ticksBetween(name, from, t);
      if (!ticks.length) continue;
      const tooMany = ticks.length > MAX_TICKS_PER_PUSH;
      const frames = (tooMany ? ticks.slice(-1) : ticks).map((k) => ({
        type: 'tick', data: { symbol: name, price: market.priceString(name, k.price), volume: market.qtyString(name, k.volume), timestamp: k.time },
      }));
      const quoteFrame = { type: 'quote', data: router.quote(name, t) };
      for (const s of sessions) {
        if (s.service !== 'marketdata' || !s.user) continue;
        if (s.bars.has(name)) {
          if (tooMany) s.send({ type: 'reset', symbol: name });
          for (const f of frames) s.send(f);
        }
        if (s.quotes.has(name)) s.send(quoteFrame);
      }
    }
    for (const name of depthSymbols) {
      const { delta } = bookFrame(name, false);
      if (!delta || (!delta.asks.length && !delta.bids.length)) continue;
      for (const s of sessions) if (s.service === 'trade' && s.user && s.depth.has(name)) s.send(delta);
    }
    for (const name of [...lastPushed.keys()]) if (!marketSymbols.has(name)) lastPushed.delete(name);
    for (const name of [...lastBook.keys()]) if (!depthSymbols.has(name)) lastBook.delete(name);
  }

  return {
    /**
     * Open a session for one connection.
     * @param {StreamService} service @param {Send} send @param {() => void} close
     */
    connect(service, send, close) {
      /** @type {Session} */
      const s = { service, send, user: null, expiresAt: 0, openedAt: realNow(), bars: new Map(), quotes: new Set(), depth: new Set(), close: () => {} };
      s.close = () => { if (sessions.delete(s)) close(); };
      sessions.add(s);
      return {
        /** @param {unknown} frame */
        receive: (frame) => { if (sessions.has(s)) receive(s, frame); },
        /** Call when the connection closes from the other side. */
        disconnect: () => { sessions.delete(s); },
      };
    },
    tick,
    sessionCount: () => sessions.size,
  };
}

/** @typedef {ReturnType<typeof createHub>} Hub */
