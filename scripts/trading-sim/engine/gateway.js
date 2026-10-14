/**
 * The simulated execution gateway: accounts, orders, fills, brackets, sessions and fees, driven by
 * the simulated market. It has no I/O: callers pass the current time and listen for events.
 * service/router.js and service/hub.js put it behind the REST and WebSocket protocol.
 *
 * Rules implemented here (see docs/REQUIREMENTS.md):
 * - netting: one position per symbol; fills add, reduce, close or reverse it (P-11)
 * - brackets: stop loss and take profit start Inactive on the parent order, become Working
 *   position brackets when it fills, always cover the whole position, and cancel each other (O-7..9)
 * - time in force: DAY expires at the session close, IOC fills what it can at once, FOK all or
 *   nothing, GTC stays (O-11)
 * - risk: an order that needs more margin than is free is rejected; if equity falls to the
 *   maintenance margin, the account is liquidated at market (O-12)
 * - client order ids are de-duplicated (SEC-3); previews issue a confirm id valid for 60 seconds
 */
import { D, ZERO } from '../shared/decimal.js';
import { getSymbol, isOpen, nextClose, dayIndexOf, SYMBOLS } from '../shared/symbols.js';
import { GATEWAY_EVENTS, ApiError } from '../shared/protocol.js';
import {
  createAccount, applyFill, summary, marginIncrease, commissionFor, leverageOf, liquidationPrice,
  borrowFeePerDay, unrealizedPL,
} from './account.js';
import { validateOrder, transition, isLive, remaining } from './orders.js';
import { walkBook, restingLimitFills, stopTriggered, trailStop, available, averagePrice } from './matching.js';
import { previewOrder } from './preview.js';

/** @typedef {import('./market.js').Market} Market */
/** @typedef {import('./orders.js').Order} Order */
/** @typedef {import('./orders.js').OrderRequest} OrderRequest */
/** @typedef {import('./account.js').Account} Account */
/** @typedef {import('./matching.js').DecBook} DecBook */
/** @typedef {import('./matching.js').Fill} Fill */
/** @typedef {import('../shared/decimal.js').Dec} Dec */
/** @typedef {import('../shared/protocol.js').Side} Side */

/**
 * @typedef {object} Execution
 * @property {string} id
 * @property {string} orderId
 * @property {string} symbol
 * @property {Side} side
 * @property {string} price
 * @property {string} qty
 * @property {string} commission
 * @property {string} realizedPL
 * @property {'open' | 'close' | 'reverse'} effect   opened/added to, reduced/closed, or reversed the position
 * @property {number} time
 */

/**
 * A position as sent to clients. qty is unsigned; side says long (BUY) or short (SELL).
 * A position update with qty "0" means the position closed.
 * @typedef {object} PositionWire
 * @property {string} id               the symbol (netting: one position per symbol)
 * @property {string} symbol
 * @property {Side} side
 * @property {string} qty
 * @property {string} avgPrice
 * @property {string} markPrice
 * @property {string} unrealizedPL
 * @property {string} realizedPL
 * @property {string | null} stopLoss
 * @property {string | null} takeProfit
 * @property {number | null} trailingStopPips
 * @property {number} leverage
 * @property {string} margin
 * @property {string | null} liquidationPrice
 * @property {number | null} openedAt
 * @property {number} updatedAt
 */

/**
 * @typedef {object} ClosedPosition
 * @property {string} symbol
 * @property {Side} side
 * @property {string} qty        largest size held
 * @property {string} avgPrice
 * @property {string} exitPrice
 * @property {string} realizedPL
 * @property {number} openedAt
 * @property {number} closedAt
 */

/**
 * @typedef {object} UserState
 * @property {Account} account
 * @property {Map<string, Order>} orders
 * @property {Map<string, string>} byClientId
 * @property {Execution[]} executions
 * @property {ClosedPosition[]} closed
 * @property {Map<string, Dec>} peakQty        largest size of each open position
 * @property {Map<string, { key: string, expiresAt: number }>} previews
 * @property {string} lastEquity
 * @property {number} lastEquityAt
 */

/**
 * @typedef {{ user: string, type: 'ORDER_UPDATED', order: Order }
 *  | { user: string, type: 'POSITION_UPDATED', position: PositionWire }
 *  | { user: string, type: 'EXECUTION_FILLED', execution: Execution }
 *  | { user: string, type: 'EQUITY_UPDATED', equity: string, unrealizedPL: string, balance: string, marginUsed: string, freeMargin: string }} GatewayEvent
 */

const PREVIEW_TTL_MS = 60_000;
const EQUITY_EVENT_MS = 500;

/**
 * @param {object} options
 * @param {Market} options.market
 * @param {string} [options.startingBalance]
 * @param {() => string} [options.uuid]   source of confirm ids (defaults to crypto.randomUUID)
 */
export function createGateway({ market, startingBalance = '100000', uuid = () => globalThis.crypto.randomUUID() }) {
  /** @type {Map<string, UserState>} */
  const users = new Map();
  /** @type {Set<(event: GatewayEvent) => void>} */
  const listeners = new Set();
  let orderSeq = 0;
  let executionSeq = 0;
  /** @type {number | null} */
  let lastStep = null;

  // ----------------------------------------------------------------------- helpers

  /** @param {string} user */
  function userState(user) {
    let u = users.get(user);
    if (!u) {
      u = {
        account: createAccount(user, startingBalance), orders: new Map(), byClientId: new Map(), executions: [],
        closed: [], peakQty: new Map(), previews: new Map(), lastEquity: '', lastEquityAt: 0,
      };
      users.set(user, u);
    }
    return u;
  }

  /** @param {GatewayEvent} event */
  function emit(event) { for (const l of listeners) l(event); }

  /** @param {string} symbol */
  function symbolDef(symbol) {
    const s = getSymbol(symbol);
    if (!s) throw new ApiError(404, 'unknown_symbol', `Unknown symbol "${symbol}"`);
    return s;
  }

  /** @param {string} symbol @param {number} now */
  function bookAt(symbol, now) {
    const b = market.book(symbol, now);
    /** @param {[number, number]} l */
    const level = ([p, q]) => ({ price: D(market.priceString(symbol, p)), size: D(market.qtyString(symbol, q)) });
    return /** @type {DecBook} */ ({ bids: b.bids.map(level), asks: b.asks.map(level) });
  }

  /** @param {string} symbol @param {number} now */
  function quoteRef(symbol, now) {
    const b = market.book(symbol, now);
    return {
      bid: market.priceString(symbol, b.bids[0][0]),
      ask: market.priceString(symbol, b.asks[0][0]),
      last: market.priceString(symbol, market.lastTick(symbol, now).price),
    };
  }

  /** @param {number} now */
  const marks = (now) => {
    /** @type {Map<string, string>} */
    const cache = new Map();
    return (/** @type {string} */ symbol) => {
      let m = cache.get(symbol);
      if (!m) { m = market.priceString(symbol, market.lastTick(symbol, now).price); cache.set(symbol, m); }
      return m;
    };
  };

  /**
   * The wire shape of a position for events and snapshots.
   * @param {UserState} u @param {string} symbol @param {(s: string) => string} markOf @param {number} now
   * @returns {PositionWire}
   */
  function positionWire(u, symbol, markOf, now) {
    const p = u.account.positions.get(symbol);
    const brackets = [...u.orders.values()].filter((o) => isLive(o) && o.parentType === 'position' && o.parentId === symbol);
    const sl = brackets.find((o) => o.bracket === 'stopLoss');
    const tp = brackets.find((o) => o.bracket === 'takeProfit');
    if (!p) {
      return {
        id: symbol, symbol, side: /** @type {Side} */ ('BUY'), qty: '0', avgPrice: '0', markPrice: markOf(symbol), unrealizedPL: '0',
        realizedPL: '0', stopLoss: null, takeProfit: null, trailingStopPips: null, leverage: leverageOf(u.account, symbol),
        margin: '0', liquidationPrice: null, openedAt: null, updatedAt: now,
      };
    }
    const mark = D(markOf(symbol));
    const places = D(symbolDef(symbol).tick).decimalPlaces();
    const liq = liquidationPrice(u.account, symbol, markOf);
    return {
      id: symbol,
      symbol,
      side: /** @type {Side} */ (p.qty.isPos() ? 'BUY' : 'SELL'),
      qty: p.qty.abs().toString(),
      avgPrice: p.avgPrice.toDecimalPlaces(places + 2).toString(),
      markPrice: mark.toString(),
      unrealizedPL: unrealizedPL(p, mark).toFixed(2),
      realizedPL: p.realizedPL.toFixed(2),
      stopLoss: sl ? (sl.stopPrice ?? null) : null,
      takeProfit: tp ? tp.limitPrice : null,
      trailingStopPips: sl?.type === 'TRAILING_STOP' ? sl.trailingStopPips : null,
      leverage: leverageOf(u.account, symbol),
      margin: p.qty.abs().mul(mark).div(leverageOf(u.account, symbol)).toFixed(2),
      liquidationPrice: liq ? liq.toDecimalPlaces(places).toString() : null,
      openedAt: p.openedAt,
      updatedAt: p.updatedAt,
    };
  }

  /** @param {UserState} u @param {Order} order */
  function save(u, order) {
    u.orders.set(order.id, order);
    emit({ user: u.account.user, type: 'ORDER_UPDATED', order });
    return order;
  }

  /** @param {UserState} u @param {number} now @param {boolean} [force] */
  function emitEquity(u, now, force = false) {
    const s = summary(u.account, marks(now));
    const equity = s.equity.toFixed(2);
    if (!force && (equity === u.lastEquity || now - u.lastEquityAt < EQUITY_EVENT_MS)) return;
    u.lastEquity = equity;
    u.lastEquityAt = now;
    emit({
      user: u.account.user, type: 'EQUITY_UPDATED', equity, unrealizedPL: s.unrealizedPL.toFixed(2),
      balance: s.balance.toFixed(2), marginUsed: s.marginUsed.toFixed(2), freeMargin: s.freeMargin.toFixed(2),
    });
  }

  /**
   * A new order record.
   * @param {Omit<Order, 'id' | 'status' | 'filledQty' | 'avgFillPrice' | 'expiresAt' | 'triggered' | 'message' | 'createdAt' | 'updatedAt' | 'parentId' | 'parentType' | 'bracket'> & Partial<Order>} fields
   * @param {number} now
   * @returns {Order}
   */
  function newOrder(fields, now) {
    orderSeq += 1;
    return {
      id: `ord-${String(orderSeq).padStart(6, '0')}`,
      status: 'PLACING', filledQty: '0', avgFillPrice: null, expiresAt: null, triggered: false, message: null,
      parentId: null, parentType: null, bracket: null, createdAt: now, updatedAt: now,
      ...fields,
    };
  }

  // ----------------------------------------------------------------------- fills

  /**
   * Apply fills to an order, the account and the position, then sync brackets.
   * Fills that would need more margin than is free are not applied; the order is cancelled.
   * @param {UserState} u @param {Order} order @param {Fill[]} fills @param {number} now
   * @returns {Order}
   */
  function fillOrder(u, order, fills, now) {
    let current = order;
    const markOf = marks(now);
    for (const fill of fills) {
      if (fill.qty.lte(0)) continue;
      const extra = marginIncrease(u.account, order.symbol, order.side, fill.qty, fill.price);
      if (extra.gt(0)) {
        const free = summary(u.account, markOf).freeMargin;
        if (extra.plus(commissionFor(order.symbol, fill.qty, fill.price)).gt(free)) {
          return finish(u, current, now, 'Not enough free margin to fill the rest of this order', true);
        }
      }
      const prior = u.account.positions.get(order.symbol);
      const result = applyFill(u.account, { symbol: order.symbol, side: order.side, qty: fill.qty, price: fill.price, time: now });
      executionSeq += 1;
      /** @type {Execution} */
      const execution = {
        id: `exe-${String(executionSeq).padStart(6, '0')}`, orderId: order.id, symbol: order.symbol, side: order.side,
        price: fill.price.toString(), qty: fill.qty.toString(), commission: result.commission.toFixed(2),
        realizedPL: result.realizedPL.toFixed(2), effect: result.reversed ? 'reverse' : result.closedQty.gt(0) ? 'close' : 'open', time: now,
      };
      u.executions.push(execution);
      trackClosed(u, prior, result, fill.price, now);

      const filled = D(current.filledQty).plus(fill.qty);
      const prevValue = D(current.avgFillPrice ?? 0).mul(current.filledQty);
      const avg = prevValue.plus(fill.price.mul(fill.qty)).div(filled);
      const status = filled.gte(current.qty) ? 'FILLED' : 'PARTIALLY_FILLED';
      current = save(u, { ...transition(current, status, now), filledQty: filled.toString(), avgFillPrice: avg.toDecimalPlaces(8).toString() });
      emit({ user: u.account.user, type: 'EXECUTION_FILLED', execution });
      activateBrackets(u, current, now);
      syncBrackets(u, order.symbol, now);
      emit({ user: u.account.user, type: 'POSITION_UPDATED', position: positionWire(u, order.symbol, markOf, now) });
    }
    emitEquity(u, now, true);
    return current;
  }

  /**
   * Remember the largest size of each position, and record a position when it closes or
   * reverses (the Positions widget's "Closed" filter).
   * @param {UserState} u @param {import('./account.js').Position | undefined} prior the position before the fill
   * @param {ReturnType<typeof applyFill>} result @param {Dec} price @param {number} now
   */
  function trackClosed(u, prior, result, price, now) {
    const symbol = result.position.symbol;
    if (prior && (result.closed || result.reversed)) {
      u.closed.unshift({
        symbol, side: prior.qty.isPos() ? 'BUY' : 'SELL', qty: (u.peakQty.get(symbol) ?? prior.qty.abs()).toString(),
        avgPrice: prior.avgPrice.toString(), exitPrice: price.toString(),
        realizedPL: prior.realizedPL.plus(result.realizedPL).toFixed(2), openedAt: prior.openedAt, closedAt: now,
      });
      u.peakQty.delete(symbol);
    }
    const size = result.position.qty.abs();
    if (size.gt(u.peakQty.get(symbol) ?? ZERO)) u.peakQty.set(symbol, size);
  }

  /**
   * End an order: cancel what is left (or expire it). Brackets that never activated go with it.
   * @param {UserState} u @param {Order} order @param {number} now @param {string} message @param {boolean} [cancel]
   */
  function finish(u, order, now, message, cancel = true) {
    if (!isLive(order)) return order;
    const done = save(u, transition(order, cancel ? 'CANCELED' : 'EXPIRED', now, message));
    if (D(done.filledQty).isZero()) {
      for (const child of u.orders.values()) {
        if (child.parentId === done.id && child.parentType === 'order' && isLive(child)) {
          save(u, transition(child, 'CANCELED', now, 'Parent order did not fill'));
        }
      }
    }
    return done;
  }

  /**
   * When a parent order fills, its brackets become the position's brackets, replacing any
   * existing ones, as long as the position is now on the order's side.
   * @param {UserState} u @param {Order} parent @param {number} now
   */
  function activateBrackets(u, parent, now) {
    const children = [...u.orders.values()].filter((o) => o.parentId === parent.id && o.parentType === 'order' && o.status === 'INACTIVE');
    if (!children.length) return;
    const position = u.account.positions.get(parent.symbol);
    const sameSide = position && (position.qty.isPos() === (parent.side === 'BUY'));
    if (!sameSide) {
      for (const c of children) save(u, transition(c, 'CANCELED', now, 'The fill did not open a position for this bracket'));
      return;
    }
    for (const o of u.orders.values()) {
      if (isLive(o) && o.parentType === 'position' && o.parentId === parent.symbol) save(u, transition(o, 'CANCELED', now, 'Replaced by new brackets'));
    }
    const fillPrice = D(parent.avgFillPrice ?? 0);
    const tick = D(symbolDef(parent.symbol).tick);
    for (const c of children) {
      const activated = { ...transition(c, 'WORKING', now), parentType: /** @type {const} */ ('position'), parentId: parent.symbol, qty: position.qty.abs().toString() };
      if (activated.type === 'TRAILING_STOP') {
        activated.stopPrice = trailStop(activated.side, null, fillPrice, D(activated.trailingStopPips ?? 0).mul(tick)).toString();
      }
      save(u, activated);
    }
  }

  /**
   * Keep position brackets covering exactly the open position; cancel them when it closes or
   * reverses (one bracket filling closes the position, which cancels the other: OCO).
   * @param {UserState} u @param {string} symbol @param {number} now
   */
  function syncBrackets(u, symbol, now) {
    const position = u.account.positions.get(symbol);
    for (const o of [...u.orders.values()]) {
      if (!isLive(o) || o.parentType !== 'position' || o.parentId !== symbol) continue;
      const closing = position && (position.qty.isPos() ? o.side === 'SELL' : o.side === 'BUY');
      if (!position || !closing) { save(u, transition(o, 'CANCELED', now, position ? 'Position reversed' : 'Position closed')); continue; }
      const qty = D(o.filledQty).plus(position.qty.abs()).toString();
      if (qty !== o.qty) save(u, { ...o, qty, updatedAt: now });
    }
  }

  // ----------------------------------------------------------------------- execution

  /**
   * Try to execute an order against the market at a trade. First executability also applies
   * IOC/FOK; market-like orders cancel what the book can't fill.
   * @param {UserState} u @param {Order} order @param {{ price: Dec, volume: Dec, time: number }} trade
   * @param {() => DecBook} getBook
   * @param {boolean} first true when the order is being placed or has just triggered
   */
  function execute(u, order, trade, getBook, first) {
    let o = order;
    const now = trade.time;
    if (o.status === 'INACTIVE') return o;
    const tick = D(symbolDef(o.symbol).tick);

    if (o.type === 'TRAILING_STOP') {
      const stop = trailStop(o.side, o.stopPrice ? D(o.stopPrice) : null, trade.price, D(o.trailingStopPips ?? 0).mul(tick));
      if (o.stopPrice !== stop.toString()) o = save(u, { ...o, stopPrice: stop.toString(), updatedAt: now });
    }
    if ((o.type === 'STOP' || o.type === 'STOP_LIMIT' || o.type === 'TRAILING_STOP') && !o.triggered) {
      if (!stopTriggered(o.side, D(/** @type {string} */ (o.stopPrice)), trade.price)) return o;
      o = save(u, { ...o, triggered: true, updatedAt: now });
      first = true;
    }

    const marketLike = o.type === 'MARKET' || o.type === 'STOP' || o.type === 'TRAILING_STOP';
    const limit = marketLike ? null : D(/** @type {string} */ (o.limitPrice));
    const left = remaining(o);
    const book = getBook();

    if (first && o.duration === 'FOK' && available(book, o.side, limit).lt(left)) {
      return finish(u, o, now, 'Fill or kill: not enough liquidity to fill the whole order');
    }
    /** @type {Fill[]} */
    let fills;
    if (marketLike) fills = walkBook(book, o.side, left).fills;
    else if (first) fills = walkBook(book, o.side, left, limit).fills;
    else fills = restingLimitFills(book, o.side, /** @type {Dec} */ (limit), left, trade);

    if (fills.length) o = fillOrder(u, o, fills, now);
    if (isLive(o) && (marketLike || (first && o.duration === 'IOC'))) {
      o = finish(u, o, now, marketLike ? 'Not enough liquidity in the book; the rest was cancelled' : 'Immediate or cancel: the unfilled part was cancelled');
    }
    return o;
  }

  /** @param {string} symbol @param {number} now */
  function tradeAt(symbol, now) {
    const t = market.lastTick(symbol, now);
    return { price: D(market.priceString(symbol, t.price)), volume: ZERO, time: now };
  }

  // ----------------------------------------------------------------------- time

  /**
   * Advance the gateway to `now`: run every trade since the last step through the live orders,
   * then expire DAY orders, charge borrow fees, check margin and publish equity.
   * @param {number} now
   */
  function step(now) {
    const from = lastStep ?? now;
    lastStep = Math.max(from, now);
    if (now <= from) return;

    /** @type {Set<string>} */
    const active = new Set();
    for (const u of users.values()) for (const o of u.orders.values()) if (isLive(o) && o.status !== 'INACTIVE') active.add(o.symbol);
    /** @type {Array<{ symbol: string, price: number, volume: number, time: number }>} */
    const trades = [];
    for (const symbol of active) for (const t of market.ticksBetween(symbol, from, now)) trades.push({ symbol, ...t });
    trades.sort((a, b) => a.time - b.time);

    for (const t of trades) {
      const trade = { price: D(market.priceString(t.symbol, t.price)), volume: D(market.qtyString(t.symbol, t.volume)), time: t.time };
      /** @type {DecBook | null} */
      let book = null;
      const getBook = () => (book ??= bookAt(t.symbol, t.time));
      for (const u of users.values()) {
        const live = [...u.orders.values()].filter((o) => o.symbol === t.symbol && isLive(o) && o.status !== 'INACTIVE');
        for (const o of live) {
          const latest = u.orders.get(o.id);
          if (latest && isLive(latest)) execute(u, latest, trade, getBook, false);
        }
      }
    }

    for (const u of users.values()) {
      for (const o of [...u.orders.values()]) {
        if (isLive(o) && o.expiresAt !== null && o.expiresAt <= now) finish(u, o, now, 'Day order expired at the session close', false);
      }
      chargeBorrowFees(u, from, now);
      checkMargin(u, now);
      if (u.account.positions.size) emitEquity(u, now);
    }
  }

  /** Borrow fees on short positions, once per UTC day crossed. @param {UserState} u @param {number} from @param {number} now */
  function chargeBorrowFees(u, from, now) {
    const days = dayIndexOf(now) - dayIndexOf(from);
    if (days <= 0 || !u.account.positions.size) return;
    const markOf = marks(now);
    let total = ZERO;
    for (const p of u.account.positions.values()) total = total.plus(borrowFeePerDay(p.symbol, p.qty, markOf(p.symbol)).mul(days));
    if (total.gt(0)) {
      u.account.balance = u.account.balance.minus(total);
      emitEquity(u, now, true);
    }
  }

  /** Liquidate at market if equity has fallen to the maintenance margin. @param {UserState} u @param {number} now */
  function checkMargin(u, now) {
    if (!u.account.positions.size) return;
    const s = summary(u.account, marks(now));
    if (s.equity.gt(s.maintenanceMargin)) return;
    for (const o of [...u.orders.values()]) if (isLive(o)) finish(u, o, now, 'Cancelled by liquidation');
    for (const p of [...u.account.positions.values()]) {
      const def = symbolDef(p.symbol);
      if (!isOpen(def, now)) continue;
      const order = save(u, newOrder({
        clientOrderId: uuid(), symbol: p.symbol, side: p.qty.isPos() ? 'SELL' : 'BUY', type: 'MARKET', qty: p.qty.abs().toString(),
        limitPrice: null, stopPrice: null, trailingStopPips: null, stopLoss: null, takeProfit: null, duration: 'IOC',
        message: 'Liquidation: equity fell to the maintenance margin',
      }, now));
      const working = save(u, transition(order, 'WORKING', now));
      execute(u, working, tradeAt(p.symbol, now), () => bookAt(p.symbol, now), true);
    }
  }

  // ----------------------------------------------------------------------- commands

  /**
   * @param {string} user @param {OrderRequest} req @param {number} now
   * @param {string | null} [note] why the gateway placed it (position commands, liquidation)
   * @returns {{ orderId: string }}
   */
  function placeOrder(user, req, now, note = null) {
    step(now);
    const u = userState(user);
    const existing = typeof req.clientOrderId === 'string' ? u.byClientId.get(req.clientOrderId) : undefined;
    if (existing) {
      const order = /** @type {Order} */ (u.orders.get(existing));
      if (order.status === 'REJECTED') throw new ApiError(400, 'order_rejected', order.message ?? 'Order rejected');
      return { orderId: existing };
    }
    const def = symbolDef(String(req.symbol));
    const quote = quoteRef(def.name, now);
    const marketOpen = isOpen(def, now);
    const v = validateOrder(req, { quote, marketOpen });
    if (!v.ok) {
      const malformed = !getSymbol(String(req.symbol)) || v.errors.some((e) => e.startsWith('clientOrderId'));
      if (malformed) throw new ApiError(400, 'invalid_order', v.errors.join('; '));
      return reject(u, req, v.errors.join('; '), now);
    }
    const value = v.value;
    if (req.confirmId) {
      const preview = u.previews.get(req.confirmId);
      u.previews.delete(req.confirmId);
      if (!preview || preview.expiresAt < now) return reject(u, req, 'The preview has expired; preview the order again', now);
      if (preview.key !== previewKey(value)) return reject(u, req, 'The order changed after it was previewed; preview it again', now);
    }

    // Risk check (O-12) at the expected fill price.
    const expected = value.limitPrice ?? value.stopPrice ?? (value.side === 'BUY' ? quote.ask : quote.bid);
    const extra = marginIncrease(u.account, value.symbol, value.side, value.qty, expected);
    const free = summary(u.account, marks(now)).freeMargin;
    if (extra.gt(0) && extra.plus(commissionFor(value.symbol, value.qty, expected)).gt(free)) {
      return reject(u, req, `Not enough free margin: this order needs ${extra.toFixed(2)} and ${free.toFixed(2)} is free`, now);
    }

    const isTrailingOrder = value.type === 'TRAILING_STOP';
    let order = save(u, newOrder({
      ...value,
      stopPrice: isTrailingOrder ? trailStop(value.side, null, D(quote.last), D(value.trailingStopPips ?? 0).mul(def.tick)).toString() : value.stopPrice,
      expiresAt: value.duration === 'DAY' ? nextClose(def, now) : null,
      message: note,
    }, now));
    u.byClientId.set(order.clientOrderId, order.id);
    createBrackets(u, order, now);
    order = save(u, transition(order, 'WORKING', now));
    if (marketOpen) execute(u, order, tradeAt(def.name, now), () => bookAt(def.name, now), true);
    else if (value.duration === 'IOC' || value.duration === 'FOK') finish(u, order, now, 'The market is closed; immediate orders cannot fill');
    return { orderId: order.id };
  }

  /**
   * Record a REJECTED order (so it shows in the Orders history) and fail the request.
   * @param {UserState} u @param {OrderRequest} req @param {string} message @param {number} now
   * @returns {never}
   */
  function reject(u, req, message, now) {
    const s = getSymbol(String(req.symbol));
    const order = save(u, newOrder({
      clientOrderId: req.clientOrderId, symbol: s ? s.name : String(req.symbol),
      side: /** @type {Side} */ (String(req.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY'),
      type: /** @type {any} */ (String(req.type ?? 'MARKET').toUpperCase()), qty: String(req.qty ?? '0'),
      limitPrice: req.limitPrice == null ? null : String(req.limitPrice), stopPrice: req.stopPrice == null ? null : String(req.stopPrice),
      trailingStopPips: req.trailingStopPips ?? null, stopLoss: req.stopLoss == null ? null : String(req.stopLoss),
      takeProfit: req.takeProfit == null ? null : String(req.takeProfit), duration: /** @type {any} */ (String(req.duration ?? 'GTC').toUpperCase()),
    }, now));
    u.byClientId.set(order.clientOrderId, order.id);
    save(u, transition(order, 'REJECTED', now, message));
    throw new ApiError(400, 'order_rejected', message);
  }

  /** @param {UserState} u @param {Order} parent @param {number} now */
  function createBrackets(u, parent, now) {
    const opposite = parent.side === 'BUY' ? 'SELL' : 'BUY';
    const base = { side: /** @type {Side} */ (opposite), qty: parent.qty, duration: /** @type {const} */ ('GTC'), stopLoss: null, takeProfit: null, parentId: parent.id, parentType: /** @type {const} */ ('order') };
    const trailingBracket = parent.type !== 'TRAILING_STOP' && parent.trailingStopPips;
    if (parent.stopLoss || trailingBracket) {
      save(u, { ...newOrder({
        ...base, clientOrderId: uuid(), symbol: parent.symbol, bracket: 'stopLoss',
        type: trailingBracket ? 'TRAILING_STOP' : 'STOP', limitPrice: null,
        stopPrice: trailingBracket ? null : parent.stopLoss, trailingStopPips: trailingBracket ? parent.trailingStopPips : null,
      }, now), status: 'INACTIVE' });
    }
    if (parent.takeProfit) {
      save(u, { ...newOrder({
        ...base, clientOrderId: uuid(), symbol: parent.symbol, bracket: 'takeProfit', type: 'LIMIT',
        limitPrice: parent.takeProfit, stopPrice: null, trailingStopPips: null,
      }, now), status: 'INACTIVE' });
    }
  }

  /** @param {Pick<Order, 'symbol' | 'side' | 'type' | 'qty' | 'limitPrice' | 'stopPrice' | 'trailingStopPips' | 'stopLoss' | 'takeProfit' | 'duration'>} o */
  function previewKey(o) {
    return JSON.stringify([o.symbol, o.side, o.type, o.qty, o.limitPrice, o.stopPrice, o.trailingStopPips, o.stopLoss, o.takeProfit, o.duration]);
  }

  /** @param {string} user @param {OrderRequest} req @param {number} now */
  function preview(user, req, now) {
    step(now);
    const u = userState(user);
    const def = symbolDef(String(req.symbol));
    const quote = quoteRef(def.name, now);
    const marketOpen = isOpen(def, now);
    const v = validateOrder({ ...req, clientOrderId: req.clientOrderId ?? uuid() }, { quote, marketOpen: true });
    if (!v.ok) throw new ApiError(400, 'invalid_order', v.errors.join('; '));
    const result = previewOrder({
      account: u.account, order: v.value, book: bookAt(def.name, now), last: D(quote.last), tick: def.tick, marketOpen, markOf: marks(now),
    });
    const confirmId = uuid();
    u.previews.set(confirmId, { key: previewKey(v.value), expiresAt: now + PREVIEW_TTL_MS });
    for (const [id, p] of u.previews) if (p.expiresAt < now) u.previews.delete(id);
    return { ...result, confirmId };
  }

  /**
   * @param {string} user @param {string} id
   * @param {{ qty?: string | number, limitPrice?: string | number | null, stopPrice?: string | number | null, stopLoss?: string | number | null, takeProfit?: string | number | null, trailingStopPips?: number | null }} changes
   * @param {number} now
   */
  function modifyOrder(user, id, changes, now) {
    step(now);
    const u = userState(user);
    const order = u.orders.get(id);
    if (!order) throw new ApiError(404, 'unknown_order', `No order ${id}`);
    if (!isLive(order)) throw new ApiError(409, 'order_final', `Order ${id} is ${order.status.toLowerCase()} and can't be changed`);
    const def = symbolDef(order.symbol);
    /** @param {keyof typeof changes} k @param {unknown} fallback */
    const pick = (k, fallback) => (k in changes ? changes[k] : fallback);
    const isBracket = order.parentType !== null;
    const req = {
      clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, type: order.type,
      qty: isBracket ? order.qty : /** @type {string} */ (pick('qty', order.qty)),
      limitPrice: /** @type {string | null} */ (pick('limitPrice', order.limitPrice)),
      stopPrice: order.type === 'TRAILING_STOP' ? null : /** @type {string | null} */ (pick('stopPrice', order.stopPrice)),
      trailingStopPips: /** @type {number | null} */ (pick('trailingStopPips', order.trailingStopPips)),
      stopLoss: isBracket ? null : /** @type {string | null} */ (pick('stopLoss', order.stopLoss)),
      takeProfit: isBracket ? null : /** @type {string | null} */ (pick('takeProfit', order.takeProfit)),
      duration: order.duration,
    };
    const quote = quoteRef(def.name, now);
    // A triggered stop-limit is a plain limit now; its stop no longer matters.
    const v = validateOrder(order.triggered && order.type === 'STOP_LIMIT' ? { ...req, type: 'LIMIT' } : req, { quote, marketOpen: true });
    if (!v.ok) throw new ApiError(400, 'invalid_order', v.errors.join('; '));
    if (D(v.value.qty).lte(order.filledQty)) throw new ApiError(400, 'invalid_order', `qty must be more than the ${order.filledQty} already filled`);
    const updated = save(u, {
      ...order, qty: v.value.qty, limitPrice: v.value.limitPrice,
      stopPrice: order.type === 'TRAILING_STOP' ? order.stopPrice : v.value.stopPrice,
      trailingStopPips: v.value.trailingStopPips, stopLoss: v.value.stopLoss, takeProfit: v.value.takeProfit, updatedAt: now,
    });
    if (!isBracket && D(order.filledQty).isZero()) {
      for (const c of [...u.orders.values()]) if (c.parentId === order.id && c.parentType === 'order' && isLive(c)) save(u, transition(c, 'CANCELED', now, 'Brackets changed'));
      createBrackets(u, updated, now);
    }
    if (isOpen(def, now) && updated.status !== 'INACTIVE') {
      // A limit moved through the market fills now, at the book's prices.
      execute(u, updated, tradeAt(def.name, now), () => bookAt(def.name, now), false);
    }
    return { status: 'ok' };
  }

  /** @param {string} user @param {string} id @param {number} now */
  function cancelOrder(user, id, now) {
    step(now);
    const u = userState(user);
    const order = u.orders.get(id);
    if (!order) throw new ApiError(404, 'unknown_order', `No order ${id}`);
    if (!isLive(order)) throw new ApiError(409, 'order_final', `Order ${id} is already ${order.status.toLowerCase()}`);
    finish(u, order, now, 'Cancelled');
    if (order.parentType === 'position') emit({ user, type: 'POSITION_UPDATED', position: positionWire(u, order.symbol, marks(now), now) });
    return { status: 'ok' };
  }

  /** @param {string} user @param {{ symbol?: string, side?: string, orderIds?: string[] }} filter @param {number} now */
  function cancelOrders(user, { symbol, side, orderIds }, now) {
    step(now);
    const u = userState(user);
    const ids = orderIds && orderIds.length ? new Set(orderIds) : null;
    let count = 0;
    for (const o of [...u.orders.values()]) {
      if (!isLive(o) || o.parentType !== null) continue;
      if (ids && !ids.has(o.id)) continue;
      if (symbol && o.symbol !== getSymbol(symbol)?.name) continue;
      if (side && o.side !== side.toUpperCase()) continue;
      finish(u, o, now, 'Cancelled');
      count += 1;
    }
    return { status: 'ok', cancelled: count };
  }

  /** @param {string} user @param {string} positionId @param {string | number | null | undefined} amount @param {number} now */
  function closePosition(user, positionId, amount, now) {
    step(now);
    const u = userState(user);
    const p = u.account.positions.get(String(positionId).toUpperCase());
    if (!p) throw new ApiError(404, 'unknown_position', `No open position ${positionId}`);
    const qty = amount === undefined || amount === null || amount === '' ? p.qty.abs() : D(amount);
    if (qty.lte(0) || qty.gt(p.qty.abs())) throw new ApiError(400, 'invalid_amount', `amount must be between 0 and ${p.qty.abs().toString()}`);
    marketOrder(u, p.symbol, p.qty.isPos() ? 'SELL' : 'BUY', qty, now, 'Close position');
    return { status: 'ok' };
  }

  /** @param {string} user @param {string} positionId @param {number} now */
  function reversePosition(user, positionId, now) {
    step(now);
    const u = userState(user);
    const p = u.account.positions.get(String(positionId).toUpperCase());
    if (!p) throw new ApiError(404, 'unknown_position', `No open position ${positionId}`);
    marketOrder(u, p.symbol, p.qty.isPos() ? 'SELL' : 'BUY', p.qty.abs().mul(2), now, 'Reverse position');
    return { status: 'ok' };
  }

  /**
   * A market order placed by the gateway for a position command (it goes through placeOrder's checks).
   * @param {UserState} u @param {string} symbol @param {Side} side @param {Dec} qty @param {number} now @param {string} reason
   */
  function marketOrder(u, symbol, side, qty, now, reason) {
    return placeOrder(u.account.user, { clientOrderId: uuid(), symbol, side, type: 'MARKET', qty: qty.toString(), duration: 'IOC' }, now, reason);
  }

  /**
   * Replace a position's brackets.
   * @param {string} user @param {string} positionId
   * @param {{ stopLoss?: string | number | null, takeProfit?: string | number | null, trailingStopPips?: number | null }} brackets
   * @param {number} now
   */
  function editPositionBrackets(user, positionId, brackets, now) {
    step(now);
    const u = userState(user);
    const p = u.account.positions.get(String(positionId).toUpperCase());
    if (!p) throw new ApiError(404, 'unknown_position', `No open position ${positionId}`);
    const def = symbolDef(p.symbol);
    const long = p.qty.isPos();
    const quote = quoteRef(def.name, now);
    // Validate as if placing an order on the position's side at the market.
    const v = validateOrder({
      clientOrderId: uuid(), symbol: def.name, side: long ? 'BUY' : 'SELL', type: 'MARKET', qty: def.lot,
      stopLoss: brackets.stopLoss ?? null, takeProfit: brackets.takeProfit ?? null, trailingStopPips: brackets.trailingStopPips ?? null,
    }, { quote: { ...quote, bid: quote.last, ask: quote.last }, marketOpen: true });
    if (!v.ok) throw new ApiError(400, 'invalid_brackets', v.errors.join('; '));
    for (const o of [...u.orders.values()]) {
      if (isLive(o) && o.parentType === 'position' && o.parentId === def.name) save(u, transition(o, 'CANCELED', now, 'Brackets changed'));
    }
    const holder = newOrder({ ...v.value, qty: p.qty.abs().toString(), duration: 'GTC' }, now);
    createBrackets(u, holder, now);
    for (const c of [...u.orders.values()]) {
      if (c.parentId === holder.id) {
        const activated = { ...transition(c, 'WORKING', now), parentType: /** @type {const} */ ('position'), parentId: def.name };
        if (activated.type === 'TRAILING_STOP') {
          activated.stopPrice = trailStop(activated.side, null, D(quote.last), D(activated.trailingStopPips ?? 0).mul(def.tick)).toString();
        }
        save(u, activated);
      }
    }
    emit({ user, type: 'POSITION_UPDATED', position: positionWire(u, def.name, marks(now), now) });
    return { status: 'ok' };
  }

  /** @param {string} user @param {string} symbol */
  function leverageInfo(user, symbol) {
    const def = symbolDef(symbol);
    const u = userState(user);
    return { symbol: def.name, min: def.leverage.min, max: def.leverage.max, step: def.leverage.step, current: leverageOf(u.account, def.name) };
  }

  /** @param {string} user @param {{ symbol: string, leverage: number }} params @param {number} now */
  function setLeverage(user, { symbol, leverage }, now) {
    step(now);
    const def = symbolDef(symbol);
    const u = userState(user);
    const n = Number(leverage);
    const { min, max, step: stepSize } = def.leverage;
    if (!Number.isFinite(n) || n < min || n > max || (n - min) % stepSize !== 0) {
      throw new ApiError(400, 'invalid_leverage', `Leverage for ${def.name} must be between ${min} and ${max} in steps of ${stepSize}`);
    }
    const previous = leverageOf(u.account, def.name);
    u.account.leverage.set(def.name, n);
    if (summary(u.account, marks(now)).freeMargin.lt(0)) {
      u.account.leverage.set(def.name, previous);
      throw new ApiError(400, 'invalid_leverage', `Not enough free margin to lower leverage to ${n}×`);
    }
    if (u.account.positions.has(def.name)) emit({ user, type: 'POSITION_UPDATED', position: positionWire(u, def.name, marks(now), now) });
    emitEquity(u, now, true);
    return { leverage: n, title: `${def.name} leverage`, info: `Initial margin ${D(100).div(n).toDecimalPlaces(2).toString()}%` };
  }

  // ----------------------------------------------------------------------- snapshots

  /** @param {string} user @param {number} now */
  function account(user, now) {
    step(now);
    const u = userState(user);
    const s = summary(u.account, marks(now));
    return {
      currency: u.account.currency,
      startingBalance: u.account.startingBalance.toFixed(2),
      balance: s.balance.toFixed(2),
      equity: s.equity.toFixed(2),
      unrealizedPL: s.unrealizedPL.toFixed(2),
      profitLoss: s.equity.minus(u.account.startingBalance).toFixed(2),
      marginUsed: s.marginUsed.toFixed(2),
      maintenanceMargin: s.maintenanceMargin.toFixed(2),
      freeMargin: s.freeMargin.toFixed(2),
    };
  }

  /** @param {string} user @param {number} now */
  function orders(user, now) {
    step(now);
    return [...userState(user).orders.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  /** Open positions. @param {string} user @param {number} now */
  function positions(user, now) {
    step(now);
    const u = userState(user);
    const markOf = marks(now);
    return [...u.account.positions.keys()].map((symbol) => positionWire(u, symbol, markOf, now));
  }

  /** Positions closed (or reversed) in this session, newest first. @param {string} user @param {number} now */
  function closedPositions(user, now) {
    step(now);
    return [...userState(user).closed];
  }

  /** @param {string} user @param {number} now */
  function executions(user, now) {
    step(now);
    return [...userState(user).executions].reverse();
  }

  /** Start the practice account again: cancel orders, drop positions, restore the balance. @param {string} user @param {number} now */
  function resetAccount(user, now) {
    step(now);
    users.delete(user);
    const u = userState(user);
    emitEquity(u, now, true);
    return { status: 'ok' };
  }

  return {
    step,
    /** @param {(event: GatewayEvent) => void} listener */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    placeOrder, preview, modifyOrder, cancelOrder, cancelOrders,
    closePosition, reversePosition, editPositionBrackets,
    leverageInfo, setLeverage,
    account, orders, positions, closedPositions, executions, resetAccount,
    /** Average price for a hypothetical market order (used by the ticket's estimate). @param {string} symbol @param {Side} side @param {string} qty @param {number} now */
    estimate(symbol, side, qty, now) {
      const p = averagePrice(walkBook(bookAt(symbol, now), side, D(qty)).fills);
      return p ? p.toString() : null;
    },
    symbols: () => SYMBOLS.map((s) => s.name),
  };
}

/** @typedef {ReturnType<typeof createGateway>} Gateway */
export { GATEWAY_EVENTS };
