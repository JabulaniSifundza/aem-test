/**
 * The broker adapter (spec §4): the method names of the TradingView library's IBrokerTerminal,
 * over our transport. It keeps the orders, positions and executions cache, applies the gateway's
 * events (ORDER_UPDATED, POSITION_UPDATED, EXECUTION_FILLED, EQUITY_UPDATED) and reports every
 * change to the host. Order book depth (spec §5) also lives here, on the trading stream.
 *
 * Records use the protocol's shapes (docs/PROTOCOL.md: decimal strings, BUY/SELL, statuses in
 * capitals). client/broker/tv-mapping.js converts them for the licensed library.
 *
 * Correctness rules from spec §10:
 * - every order gets a UUID v4 client order id; a network failure retries with the same id, and the
 *   server de-duplicates it, so a retry can never place a second order
 * - P&L is computed with decimals from live quotes (P-4 "P&L updates")
 * - after the trading stream reconnects, orders, positions, executions and the account are reloaded
 *
 * Data flow: REST snapshots fill the cache once (reload); after that the trading stream's events
 * keep it current, and every change is forwarded to the host, which widgets listen to. Widgets
 * never call REST for orders or positions themselves.
 *
 * Costs: an order or position event is O(1) (Maps by id); a fill is O(1) (executions are kept
 * oldest first and appended); a quote is O(P) to re-price positions; executions() is O(E) for
 * the copy it returns; a depth frame is parsed once, then handed to each subscriber of its symbol.
 */
import { D } from '../../shared/decimal.js';
import { ApiError } from '../../shared/protocol.js';

/** @typedef {import('../transport/transport.js').Transport} Transport */
/** @typedef {import('./host.js').Host} Host */
/** @typedef {import('./host.js').Order} Order */
/** @typedef {import('./host.js').Position} Position */
/** @typedef {import('./host.js').Execution} Execution */
/** @typedef {import('../datafeed/datafeed.js').Datafeed} Datafeed */

/**
 * The order a ticket or ladder wants to place (the library's PreOrder, in protocol terms).
 * @typedef {object} PreOrder
 * @property {string} symbol
 * @property {'BUY' | 'SELL'} side
 * @property {'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | 'TRAILING_STOP'} type
 * @property {string} qty
 * @property {string | null} [limitPrice]
 * @property {string | null} [stopPrice]
 * @property {string | null} [stopLoss]
 * @property {string | null} [takeProfit]
 * @property {number | null} [trailingStopPips]
 * @property {'DAY' | 'GTC' | 'IOC' | 'FOK'} [duration]
 */

/** @typedef {{ price: number, volume: number }} DepthLevel */
/** @typedef {{ snapshot: boolean, asks: DepthLevel[], bids: DepthLevel[] }} DepthData */

const RETRIES = 2;

/**
 * @param {object} deps
 * @param {Transport} deps.transport
 * @param {Host} deps.host
 * @param {Datafeed} deps.datafeed   for live quotes (P&L)
 * @param {() => string} [deps.uuid]
 */
export function createBroker({ transport, host, datafeed, uuid = () => globalThis.crypto.randomUUID() }) {
  const rest = transport.rest.trade;
  const stream = transport.streams.trade;
  /** @type {Map<string, Order>} */
  const orders = new Map();
  /** @type {Map<string, Position>} */
  const positions = new Map();
  /** Oldest first, so a fill is an O(1) push; readers get newest first. @type {Execution[]} */
  let executions = [];
  /** @type {import('./host.js').Equity & Record<string, string>} */
  let account = { equity: '0', unrealizedPL: '0' };
  /** @type {Map<string, number>} last mark per symbol from quotes */
  const marks = new Map();
  /** @type {Map<string, { symbol: string, callback: (d: DepthData) => void }>} */
  const depthSubs = new Map();
  /** @type {Map<string, () => void>} */
  const depthStops = new Map();
  /** Depth subscribers per symbol: the stream subscription ends with the last one. @type {Map<string, number>} */
  const depthCount = new Map();
  let depthSeq = 0;
  /** @type {Promise<void> | null} */
  let loading = null;
  let quoteGuid = '';

  // ------------------------------------------------------------------ live updates

  stream.onFrame((frame) => {
    switch (frame.type) {
      case 'ORDER_UPDATED': {
        const previous = orders.get(frame.order.id);
        orders.set(frame.order.id, frame.order);
        host.orderUpdate(frame.order);
        notifyOrder(previous, frame.order);
        break;
      }
      case 'POSITION_UPDATED':
        if (D(frame.position.qty).isZero()) positions.delete(frame.position.id);
        else positions.set(frame.position.id, frame.position);
        host.positionUpdate(frame.position);
        watchQuotes();
        break;
      case 'EXECUTION_FILLED':
        executions.push(frame.execution);
        host.executionUpdate(frame.execution);
        break;
      case 'EQUITY_UPDATED': {
        const { type: _type, ...rest } = frame;
        account = { ...account, ...rest };
        host.equityUpdate(account);
        break;
      }
      case 'l2': {
        /** @param {[string, string]} level */
        const level = ([price, volume]) => ({ price: Number(price), volume: Number(volume) });
        /** @type {DepthData} */
        const data = { snapshot: Boolean(frame.isSnapshot), asks: frame.asks.map(level), bids: frame.bids.map(level) };
        for (const sub of depthSubs.values()) if (sub.symbol === frame.symbol) sub.callback(data);
        break;
      }
      case 'error':
        if (frame.code === 'unauthorized' || frame.code === 'token_expired') host.connectionStatusUpdate('disconnected');
        break;
      default:
        break;
    }
  });
  stream.onStatus((s) => host.connectionStatusUpdate(s === 'open' ? 'connected' : s === 'connecting' ? 'connecting' : 'disconnected'));
  stream.onReconnect(() => { reload().catch(() => {}); });

  /** Toasts for the moments a trader needs to know about. @param {Order | undefined} previous @param {Order} order */
  function notifyOrder(previous, order) {
    if (previous?.status === order.status) return;
    const what = `${order.side === 'BUY' ? 'Buy' : 'Sell'} ${order.qty} ${order.symbol}`;
    if (order.status === 'FILLED') host.showNotification('Order filled', `${what} at ${order.avgFillPrice}`, 'success');
    else if (order.status === 'REJECTED') host.showNotification('Order rejected', order.message ?? what, 'error');
    else if ((order.status === 'CANCELED' || order.status === 'EXPIRED') && order.message && order.message !== 'Cancelled' && order.parentType === null) {
      host.showNotification(order.status === 'EXPIRED' ? 'Order expired' : 'Order cancelled', `${what}: ${order.message}`, 'info');
    }
  }

  /**
   * Recompute P&L from the latest marks, with decimals, between the server's equity events (which
   * come at most twice a second). Only positions whose P&L changed are reported. O(P).
   */
  function recomputePL() {
    let total = D(0);
    for (const p of positions.values()) {
      const mark = marks.get(p.symbol);
      if (mark === undefined) { total = total.plus(p.unrealizedPL); continue; }
      const sign = p.side === 'BUY' ? 1 : -1;
      const pl = D(String(mark)).minus(p.avgPrice).mul(p.qty).mul(sign).toFixed(2);
      if (pl !== p.unrealizedPL) {
        const next = { ...p, markPrice: String(mark), unrealizedPL: pl };
        positions.set(p.id, next);
        host.plUpdate(p.id, pl);
      }
      total = total.plus(pl);
    }
    if (positions.size && account.balance !== undefined) {
      const equity = D(account.balance).plus(total);
      account = {
        ...account, unrealizedPL: total.toFixed(2), equity: equity.toFixed(2),
        ...(account.marginUsed !== undefined ? { freeMargin: equity.minus(account.marginUsed).toFixed(2) } : {}),
      };
      host.equityUpdate(account);
    }
  }

  /**
   * Keep one quote subscription on exactly the symbols held. The id encodes the symbol set, so
   * an unchanged set costs nothing and a changed one swaps the subscription. O(P log P).
   */
  function watchQuotes() {
    const symbols = [...new Set([...positions.values()].map((p) => p.symbol))].sort();
    const guid = `broker-pl:${symbols.join(',')}`;
    if (guid === quoteGuid) return;
    if (quoteGuid) datafeed.unsubscribeQuotes(quoteGuid);
    quoteGuid = symbols.length ? guid : '';
    if (!symbols.length) return;
    datafeed.subscribeQuotes(symbols, [], (quotes) => {
      for (const q of quotes) if (q.s === 'ok' && q.v.lp !== undefined) marks.set(q.n, Number(q.v.lp));
      recomputePL();
    }, guid);
  }

  /**
   * Load everything from the snapshots (start-up, reconnect, account reset). Concurrent callers
   * share one load. Events that arrive during the load may be overwritten by the snapshot, which
   * is newer or equal, so nothing is lost.
   */
  function reload() {
    loading ??= (async () => {
      const [o, p, e, a] = await Promise.all([rest.get('/orders'), rest.get('/positions'), rest.get('/executions'), rest.get('/account')]);
      orders.clear();
      for (const x of o) orders.set(x.id, x);
      positions.clear();
      for (const x of p) positions.set(x.id, x);
      executions = [...e].reverse(); // the server sends newest first
      account = a;
      host.reset();
      host.equityUpdate(account);
      watchQuotes();
    })().finally(() => { loading = null; });
    return loading;
  }

  /**
   * POST with retries on network failure only. Safe because the client order id makes the server
   * return the first order instead of placing another.
   * @param {string} path @param {object} body
   */
  async function postIdempotent(path, body) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await rest.post(path, body);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 0 || attempt >= RETRIES) throw error;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }

  /** @param {PreOrder} pre */
  const payloadOf = (pre) => ({
    symbol: pre.symbol, side: pre.side, type: pre.type, qty: pre.qty,
    limitPrice: pre.limitPrice ?? null, stopPrice: pre.stopPrice ?? null, stopLoss: pre.stopLoss ?? null,
    takeProfit: pre.takeProfit ?? null, trailingStopPips: pre.trailingStopPips ?? null, duration: pre.duration ?? 'GTC',
  });

  return {
    /** Connect the trading stream and load the account. Resolves when the first snapshot is in. */
    async connect() {
      stream.open();
      await reload();
    },

    /** 1 = connected (the library's ConnectionStatus.Connected). */
    connectionStatus: () => (stream.status === 'open' ? 1 : stream.status === 'connecting' ? 2 : 3),

    orders: async () => [...orders.values()],
    positions: async () => [...positions.values()],
    /** Newest first. @param {string} [symbol] */
    executions: async (symbol) => (symbol ? executions.filter((x) => x.symbol === symbol) : [...executions]).reverse(),
    closedPositions: () => rest.get('/positions', { query: { status: 'closed' } }),
    account: () => ({ ...account }),
    /** Re-read the account from the server. */
    refreshAccount: async () => { account = await rest.get('/account'); host.equityUpdate(account); return account; },
    resetAccount: async () => { await rest.post('/account/reset', {}); await reload(); },

    /**
     * The account manager's structure (spec §7): summary fields, and the columns of the orders,
     * positions and executions pages. Widgets render from this.
     */
    accountManagerInfo() {
      return {
        accountTitle: 'Practice account',
        summary: [
          { id: 'balance', title: 'Balance' }, { id: 'equity', title: 'Equity' }, { id: 'unrealizedPL', title: 'Unrealized P&L' },
          { id: 'marginUsed', title: 'Margin used' }, { id: 'freeMargin', title: 'Free margin' },
        ],
        orderColumns: [
          { id: 'id', label: 'Order ID' }, { id: 'symbol', label: 'Symbol' }, { id: 'side', label: 'Side' }, { id: 'type', label: 'Type' },
          { id: 'qty', label: 'Qty' }, { id: 'limitPrice', label: 'Limit' }, { id: 'stopPrice', label: 'Stop' }, { id: 'status', label: 'Status' },
        ],
        positionColumns: [
          { id: 'symbol', label: 'Symbol' }, { id: 'side', label: 'Side' }, { id: 'qty', label: 'Size' }, { id: 'avgPrice', label: 'Entry' },
          { id: 'markPrice', label: 'Mark' }, { id: 'unrealizedPL', label: 'Unrealized P&L' }, { id: 'stopLoss', label: 'Stop loss' }, { id: 'takeProfit', label: 'Take profit' },
        ],
        executionColumns: [
          { id: 'id', label: 'Execution ID' }, { id: 'orderId', label: 'Order ID' }, { id: 'symbol', label: 'Symbol' }, { id: 'side', label: 'Side' },
          { id: 'price', label: 'Price' }, { id: 'qty', label: 'Qty' }, { id: 'time', label: 'Time' },
        ],
      };
    },

    /**
     * @param {PreOrder} pre @param {string} [confirmId] from previewOrder
     * @returns {Promise<{ orderId: string }>}
     */
    placeOrder(pre, confirmId) {
      return postIdempotent('/orders', { clientOrderId: uuid(), ...payloadOf(pre), ...(confirmId ? { confirmId } : {}) });
    },

    /**
     * Costs and risks before placing (spec §4): the library's OrderPreviewResult.
     * @param {PreOrder} pre
     */
    async previewOrder(pre) {
      const p = await rest.post('/orders/preview', payloadOf(pre));
      return {
        sections: [{
          rows: [
            { title: 'Estimated commission', value: `$${p.commission}` },
            { title: 'Estimated margin required', value: `$${p.marginRequired}` },
            { title: 'Initial margin %', value: `${p.initialMarginRate}%` },
            { title: 'Estimated liquidation price', value: p.estLiquidationPrice ?? 'N/A' },
            { title: 'Borrow fee / day', value: `$${p.dailyBorrowFee}` },
          ],
        }],
        confirmId: /** @type {string} */ (p.confirmId),
        warnings: /** @type {string[]} */ (p.warnings ?? []),
        raw: p,
      };
    },

    /**
     * @param {Pick<Order, 'id'> & Partial<Pick<Order, 'qty' | 'limitPrice' | 'stopPrice' | 'stopLoss' | 'takeProfit' | 'trailingStopPips'>>} order
     */
    async modifyOrder(order) {
      /** @type {Record<string, unknown>} */
      const changes = {};
      for (const k of /** @type {const} */ (['qty', 'limitPrice', 'stopPrice', 'stopLoss', 'takeProfit', 'trailingStopPips'])) if (k in order) changes[k] = order[k];
      await rest.patch(`/orders/${encodeURIComponent(order.id)}`, changes);
    },

    /** @param {string} orderId */
    async cancelOrder(orderId) { await rest.del(`/orders/${encodeURIComponent(orderId)}`); },

    /** @param {string} [symbol] @param {'BUY' | 'SELL'} [side] @param {string[]} [orderIds] */
    async cancelOrders(symbol, side, orderIds) { await rest.post('/orders/batch-cancel', { symbol, side, orderIds }); },

    /** @param {string} positionId @param {string} [amount] a partial quantity */
    async closePosition(positionId, amount) { await rest.post(`/positions/${encodeURIComponent(positionId)}/close`, { amount }); },

    /** @param {string} positionId */
    async reversePosition(positionId) { await rest.post(`/positions/${encodeURIComponent(positionId)}/reverse`, {}); },

    /** @param {string} positionId @param {{ stopLoss?: string | null, takeProfit?: string | null, trailingStopPips?: number | null }} brackets */
    async editPositionBrackets(positionId, brackets) { await rest.put(`/positions/${encodeURIComponent(positionId)}/brackets`, brackets); },

    /** @param {{ symbol: string }} params @returns {Promise<{ min: number, max: number, step: number, current: number }>} */
    leverageInfo: ({ symbol }) => rest.get('/leverage', { query: { symbol } }),

    /** @param {{ symbol: string, leverage: number }} params */
    setLeverage: (params) => rest.post('/leverage', params),

    /**
     * Order book depth (spec §5): a snapshot, then incremental updates (volume 0 removes a level).
     * @param {string} symbol @param {(d: DepthData) => void} callback
     * @returns {string} subscription id
     */
    subscribeDepth(symbol, callback) {
      stream.open();
      depthSeq += 1;
      const id = `DOM_${symbol}_${depthSeq}`;
      depthSubs.set(id, { symbol, callback });
      depthCount.set(symbol, (depthCount.get(symbol) ?? 0) + 1);
      // (Re)subscribing also makes the server send a fresh snapshot, which a new subscriber needs.
      depthStops.set(symbol, stream.subscribe(`l2:${symbol}`, { action: 'subscribe_l2', symbol, depthLevels: 25 }, { action: 'unsubscribe_l2', symbol }));
      return id;
    },

    /** @param {string} subscriptionId */
    unsubscribeDepth(subscriptionId) {
      const sub = depthSubs.get(subscriptionId);
      if (!sub) return;
      depthSubs.delete(subscriptionId);
      const left = (depthCount.get(sub.symbol) ?? 1) - 1;
      if (left > 0) { depthCount.set(sub.symbol, left); return; }
      depthCount.delete(sub.symbol);
      depthStops.get(sub.symbol)?.();
      depthStops.delete(sub.symbol);
    },
  };
}

/** @typedef {ReturnType<typeof createBroker>} Broker */
