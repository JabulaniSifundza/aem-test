/**
 * The REST routes of docs/PROTOCOL.md, without HTTP. The Node mock server and the browser
 * loopback both call handle(); so do the contract tests. A real backend replaces this whole
 * layer, keeping the same paths and shapes.
 *
 * Routes never trust the client for identity: `user` comes from the verified token. The chart
 * storage API carries client and user in the query, as in the spec; the user must match the token.
 */
import { ApiError, SERVICES } from '../shared/protocol.js';
import { SYMBOLS, EXCHANGES, SYMBOL_TYPES, getSymbol, toSymbolInfo, isOpen } from '../shared/symbols.js';
import { RESOLUTIONS, isSupported, normalizeResolution, parseResolution } from '../shared/resolution.js';
import { D } from '../shared/decimal.js';
import { headlines } from '../engine/news.js';

/** @typedef {import('../shared/protocol.js').Service} Service */
/** @typedef {{ service: Service, method: string, path: string, query?: Record<string, string>, body?: any, user: string }} Request */
/** @typedef {{ status: number, body: any }} Response */

const MAX_PROFILE_BARS = 20_000;

/**
 * @param {object} deps
 * @param {import('../engine/market.js').Market} deps.market
 * @param {import('../engine/gateway.js').Gateway} deps.gateway
 * @param {import('../engine/store.js').Store} deps.store
 * @param {() => number} deps.now
 * @param {(error: unknown) => void} [deps.onError]  unexpected errors (default: console.error)
 */
export function createRouter({ market, gateway, store, now, onError = (e) => console.error(e) }) {
  /** @param {string | undefined} value @param {string} name */
  function required(value, name) {
    if (value === undefined || value === '') throw new ApiError(400, 'missing_parameter', `${name} is required`);
    return value;
  }

  /** @param {string | undefined} name */
  function symbolOf(name) {
    const s = getSymbol(required(name, 'symbol'));
    if (!s) throw new ApiError(404, 'unknown_symbol', `Unknown symbol "${name}"`);
    return s;
  }

  /** @param {string | undefined} value @param {string} name */
  function int(value, name) {
    const n = Number(required(value, name));
    if (!Number.isFinite(n)) throw new ApiError(400, 'bad_parameter', `${name} must be a number`);
    return Math.trunc(n);
  }

  /** Bar with decimal strings; time in milliseconds. @param {string} symbol @param {import('../engine/market.js').Bar} b */
  const barWire = (symbol, b) => ({
    time: b.time, open: market.priceString(symbol, b.open), high: market.priceString(symbol, b.high),
    low: market.priceString(symbol, b.low), close: market.priceString(symbol, b.close), volume: market.qtyString(symbol, b.volume),
  });

  /** The TradingView quote shape (spec §3 getQuotes). @param {string} name @param {number} t */
  function quote(name, t) {
    const s = getSymbol(name);
    if (!s) return { n: name, s: 'error', v: {} };
    const stats = market.dayStats(s.name, t);
    const book = market.book(s.name, t);
    const lp = D(market.priceString(s.name, stats.last));
    const prev = D(market.priceString(s.name, stats.prevClose));
    const ch = lp.minus(prev);
    return {
      n: s.name,
      s: 'ok',
      v: {
        short_name: s.name, exchange: s.exchange, description: s.description, type: s.type,
        lp: lp.toString(), ch: ch.toString(), chp: ch.div(prev).mul(100).toDecimalPlaces(2).toString(),
        bid: market.priceString(s.name, book.bids[0][0]), bid_size: market.qtyString(s.name, book.bids[0][1]),
        ask: market.priceString(s.name, book.asks[0][0]), ask_size: market.qtyString(s.name, book.asks[0][1]),
        spread: market.priceString(s.name, book.asks[0][0] - book.bids[0][0]),
        open_price: market.priceString(s.name, stats.open), high_price: market.priceString(s.name, stats.high),
        low_price: market.priceString(s.name, stats.low), prev_close_price: prev.toString(),
        volume: market.qtyString(s.name, stats.volume), market_open: isOpen(s, t), time: market.lastTick(s.name, t).time,
      },
    };
  }

  // ------------------------------------------------------------------ market data

  /** @param {string} method @param {string} path @param {Record<string, string>} q @param {string} user */
  function marketdata(method, path, q, user) {
    if (method !== 'GET') return null;
    const t = now();
    switch (path) {
      case '/config':
        return {
          supported_resolutions: RESOLUTIONS,
          exchanges: EXCHANGES.map((e) => ({ value: e, name: e, desc: e })),
          symbols_types: SYMBOL_TYPES.map((s) => ({ name: s, value: s })),
          supports_marks: true, supports_timescale_marks: true, supports_time: true,
        };
      case '/symbols':
        return toSymbolInfo(symbolOf(q.symbol), RESOLUTIONS);
      case '/search': {
        const text = (q.query ?? '').trim().toUpperCase();
        return SYMBOLS
          .filter((s) => (!text || s.name.includes(text) || s.description.toUpperCase().includes(text))
            && (!q.type || s.type === q.type) && (!q.exchange || s.exchange === q.exchange))
          .slice(0, Number(q.limit) || 30)
          .map((s) => ({ symbol: s.name, full_name: `${s.exchange}:${s.name}`, description: s.description, exchange: s.exchange, ticker: s.name, type: s.type }));
      }
      case '/history': {
        const s = symbolOf(q.symbol);
        const resolution = required(q.resolution, 'resolution');
        if (!isSupported(resolution)) throw new ApiError(400, 'bad_resolution', `Unsupported resolution "${resolution}"`);
        const from = int(q.from, 'from') * 1000;
        const to = int(q.to, 'to') * 1000;
        const countback = q.countback ? int(q.countback, 'countback') : undefined;
        const bars = market.bars(s.name, normalizeResolution(resolution), { from, to, countback, now: t });
        return { bars: bars.map((b) => barWire(s.name, b)), noData: bars.length === 0 };
      }
      case '/volume-profile-bars': {
        const s = symbolOf(q.symbol);
        const from = int(q.from, 'from') * 1000;
        const to = int(q.to, 'to') * 1000;
        // 1-minute bars, coarsened if the range would be too large to send.
        let resolution = '1';
        for (const r of ['1', '5', '15', '60', '240']) {
          resolution = r;
          if ((to - from) / (parseResolution(r).count * 60_000) <= MAX_PROFILE_BARS) break;
        }
        return { resolution, bars: market.bars(s.name, resolution, { from, to, now: t }).map((b) => barWire(s.name, b)) };
      }
      case '/quotes':
        return required(q.symbols, 'symbols').split(',').filter(Boolean).slice(0, 50).map((n) => quote(n.trim(), t));
      case '/time':
        return { time: Math.floor(t / 1000) };
      case '/marks': {
        // The user's executions on the chart (P-10).
        const s = symbolOf(q.symbol);
        const from = int(q.from, 'from') * 1000;
        const to = int(q.to, 'to') * 1000;
        return gateway.executions(user, t)
          .filter((e) => e.symbol === s.name && e.time >= from && e.time <= to)
          .map((e) => ({
            id: e.id, time: Math.floor(e.time / 1000), color: e.side === 'BUY' ? 'blue' : 'red',
            text: `${e.side === 'BUY' ? 'Bought' : 'Sold'} ${e.qty} at ${e.price}`, label: e.side === 'BUY' ? 'B' : 'S', labelFontColor: 'white', minSize: 14,
          }));
      }
      case '/timescale_marks': {
        const s = symbolOf(q.symbol);
        return headlines(market, { symbol: s.name, from: int(q.from, 'from') * 1000, to: int(q.to, 'to') * 1000, now: t })
          .map((h) => ({ id: h.id, time: Math.floor(h.time / 1000), color: 'blue', label: 'N', tooltip: [h.title] }));
      }
      case '/news':
        return headlines(market, { symbol: q.symbol, from: t - 7 * 86_400_000, to: t, now: t, limit: Number(q.limit) || 30 });
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ trading

  /** @param {string} method @param {string} path @param {Record<string, string>} q @param {any} body @param {string} user */
  function trade(method, path, q, body, user) {
    const t = now();
    const parts = path.split('/').filter(Boolean);
    const [head, id, action] = parts;
    const b = body ?? {};
    if (method === 'GET' && path === '/account') return gateway.account(user, t);
    if (method === 'POST' && path === '/account/reset') return gateway.resetAccount(user, t);
    if (method === 'GET' && path === '/orders') return gateway.orders(user, t);
    if (method === 'GET' && path === '/positions') return q.status === 'closed' ? gateway.closedPositions(user, t) : gateway.positions(user, t);
    if (method === 'GET' && path === '/executions') return gateway.executions(user, t);
    if (method === 'POST' && path === '/orders') return gateway.placeOrder(user, b, t);
    if (method === 'POST' && path === '/orders/preview') return gateway.preview(user, b, t);
    if (method === 'POST' && path === '/orders/batch-cancel') return gateway.cancelOrders(user, b, t);
    if (head === 'orders' && id && parts.length === 2) {
      if (method === 'PATCH') return gateway.modifyOrder(user, id, b, t);
      if (method === 'DELETE') return gateway.cancelOrder(user, id, t);
    }
    if (head === 'positions' && id && parts.length === 3) {
      if (method === 'POST' && action === 'close') return gateway.closePosition(user, id, b.amount, t);
      if (method === 'POST' && action === 'reverse') return gateway.reversePosition(user, id, t);
      if (method === 'PUT' && action === 'brackets') return gateway.editPositionBrackets(user, id, b, t);
    }
    if (path === '/leverage' && method === 'GET') return gateway.leverageInfo(user, required(q.symbol, 'symbol'));
    if (path === '/leverage' && method === 'POST') return gateway.setLeverage(user, b, t);
    return null;
  }

  // ------------------------------------------------------------------ chart storage

  /** @param {string} method @param {string} path @param {Record<string, string>} q @param {any} body @param {string} user */
  function storage(method, path, q, body, user) {
    const client = required(q.client, 'client');
    const owner = required(q.user, 'user');
    if (owner !== user) throw new ApiError(403, 'forbidden', 'The user in the request does not match the signed-in user');
    const b = body ?? {};
    if (path === '/1.1/charts') {
      if (method === 'GET' && q.chart) {
        const chart = store.getChart(client, owner, Number(q.chart));
        if (!chart) throw new ApiError(404, 'not_found', 'Chart not found');
        return { status: 'ok', data: chart };
      }
      if (method === 'GET') return { status: 'ok', data: store.listCharts(client, owner) };
      if (method === 'POST') {
        const id = store.saveChart(client, owner, { name: b.name, content: b.content, symbol: b.symbol, resolution: b.resolution }, q.chart ? Number(q.chart) : undefined);
        if (id === null) throw new ApiError(404, 'not_found', 'Chart not found');
        return { status: 'ok', id };
      }
      if (method === 'DELETE') {
        if (!store.deleteChart(client, owner, Number(required(q.chart, 'chart')))) throw new ApiError(404, 'not_found', 'Chart not found');
        return { status: 'ok' };
      }
    }
    if (path === '/1.1/study_templates') {
      if (method === 'GET' && q.template) {
        const template = store.getTemplate(client, owner, q.template);
        if (!template) throw new ApiError(404, 'not_found', 'Template not found');
        return { status: 'ok', data: template };
      }
      if (method === 'GET') return { status: 'ok', data: store.listTemplates(client, owner) };
      if (method === 'POST') { store.saveTemplate(client, owner, { name: b.name, content: b.content }); return { status: 'ok' }; }
      if (method === 'DELETE') {
        if (!store.deleteTemplate(client, owner, required(q.template, 'template'))) throw new ApiError(404, 'not_found', 'Template not found');
        return { status: 'ok' };
      }
    }
    return null;
  }

  return {
    /**
     * @param {Request} req
     * @returns {Response}
     */
    handle(req) {
      const q = req.query ?? {};
      try {
        if (!SERVICES.includes(req.service)) throw new ApiError(404, 'not_found', `Unknown service ${req.service}`);
        const method = req.method.toUpperCase();
        let result;
        if (req.service === 'marketdata') result = marketdata(method, req.path, q, req.user);
        else if (req.service === 'trade') result = trade(method, req.path, q, req.body, req.user);
        else result = storage(method, req.path, q, req.body, req.user);
        if (result === null || result === undefined) throw new ApiError(404, 'not_found', `No route ${method} ${req.path}`);
        return { status: 200, body: result };
      } catch (error) {
        if (error instanceof ApiError) return { status: error.status, body: { message: error.message, code: error.code } };
        if (error instanceof RangeError) return { status: 400, body: { message: error.message, code: 'bad_request' } };
        onError(error);
        return { status: 500, body: { message: 'Internal error', code: 'internal' } };
      }
    },
    quote,
  };
}

/** @typedef {ReturnType<typeof createRouter>} Router */
