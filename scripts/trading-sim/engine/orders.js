/**
 * Orders: the record, validation of a new or modified order (requirement O-6), and status changes
 * through the transition table in shared/protocol.js (O-10).
 *
 * Order records are plain objects with decimals as strings, so they go on the wire unchanged.
 */
import { D, isDecimal, onTick } from '../shared/decimal.js';
import { getSymbol } from '../shared/symbols.js';
import { SIDES, ORDER_TYPES, DURATIONS, canTransition, isFinal } from '../shared/protocol.js';

/** @typedef {import('../shared/protocol.js').Side} Side */
/** @typedef {import('../shared/protocol.js').OrderType} OrderType */
/** @typedef {import('../shared/protocol.js').Duration} Duration */
/** @typedef {import('../shared/protocol.js').OrderStatus} OrderStatus */

/**
 * @typedef {object} Order
 * @property {string} id
 * @property {string} clientOrderId
 * @property {string} symbol
 * @property {Side} side
 * @property {OrderType} type
 * @property {string} qty
 * @property {string} filledQty
 * @property {string | null} avgFillPrice
 * @property {string | null} limitPrice
 * @property {string | null} stopPrice          for trailing stops: the current stop level
 * @property {number | null} trailingStopPips   trail distance in ticks
 * @property {string | null} stopLoss           requested bracket (parent orders)
 * @property {string | null} takeProfit         requested bracket (parent orders)
 * @property {Duration} duration
 * @property {number | null} expiresAt          DAY orders: the session close
 * @property {OrderStatus} status
 * @property {string | null} parentId           brackets: the parent order or position id
 * @property {'order' | 'position' | null} parentType
 * @property {'stopLoss' | 'takeProfit' | null} bracket
 * @property {boolean} triggered                stop and stop-limit orders, once the stop traded
 * @property {string | null} message            reason for a rejection, cancellation or expiry
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * The fields a client sends to place an order (spec §4 placeOrder payload).
 * @typedef {object} OrderRequest
 * @property {string} clientOrderId
 * @property {string} symbol
 * @property {string} side
 * @property {string} type
 * @property {string | number} qty
 * @property {string | number | null} [limitPrice]
 * @property {string | number | null} [stopPrice]
 * @property {string | number | null} [stopLoss]
 * @property {string | number | null} [takeProfit]
 * @property {number | null} [trailingStopPips]
 * @property {string} [duration]
 * @property {string} [confirmId]
 */

/** @typedef {{ bid: string, ask: string, last: string }} QuoteRef */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {unknown} v */
const present = (v) => v !== undefined && v !== null && v !== '';

/**
 * Check an order request and return a normalised copy or the reasons it is invalid.
 * Prices must be on the symbol's tick; quantities on its lot. Bracket prices must sit on the
 * right side of the expected entry price.
 * @param {OrderRequest} req
 * @param {{ quote: QuoteRef, marketOpen: boolean }} context
 * @returns {{ ok: true, value: Omit<Order, 'id' | 'status' | 'filledQty' | 'avgFillPrice' | 'expiresAt' | 'parentId' | 'parentType' | 'bracket' | 'triggered' | 'message' | 'createdAt' | 'updatedAt'> } | { ok: false, errors: string[] }}
 */
export function validateOrder(req, { quote, marketOpen }) {
  /** @type {string[]} */
  const errors = [];
  const s = getSymbol(String(req.symbol ?? ''));
  if (!s) return { ok: false, errors: [`Unknown symbol "${req.symbol}"`] };
  if (typeof req.clientOrderId !== 'string' || !UUID_V4.test(req.clientOrderId)) errors.push('clientOrderId must be a UUID v4');
  const side = /** @type {Side} */ (String(req.side ?? '').toUpperCase());
  if (!SIDES.includes(side)) errors.push('side must be BUY or SELL');
  const type = /** @type {OrderType} */ (String(req.type ?? '').toUpperCase());
  if (!ORDER_TYPES.includes(type)) errors.push(`type must be one of ${ORDER_TYPES.join(', ')}`);
  const duration = /** @type {Duration} */ (String(req.duration ?? 'GTC').toUpperCase());
  if (!DURATIONS.includes(duration)) errors.push(`duration must be one of ${DURATIONS.join(', ')}`);

  /** @param {string} field @param {unknown} value @param {boolean} required */
  const price = (field, value, required) => {
    if (!present(value)) { if (required) errors.push(`${field} is required for ${type} orders`); return null; }
    if (!isDecimal(value) || D(/** @type {string} */ (value)).lte(0)) { errors.push(`${field} must be a positive number`); return null; }
    const p = D(/** @type {string} */ (value));
    if (!onTick(p, s.tick)) { errors.push(`${field} must be a multiple of the tick size ${s.tick}`); return null; }
    return p;
  };

  let qty = null;
  if (!isDecimal(req.qty) || D(req.qty).lte(0)) errors.push('qty must be a positive number');
  else {
    qty = D(req.qty);
    if (!onTick(qty, s.lot)) errors.push(`qty must be a multiple of the lot size ${s.lot}`);
    if (qty.lt(s.minQty)) errors.push(`qty must be at least ${s.minQty}`);
    if (qty.gt(s.maxQty)) errors.push(`qty must be at most ${s.maxQty}`);
  }

  const needsLimit = type === 'LIMIT' || type === 'STOP_LIMIT';
  const needsStop = type === 'STOP' || type === 'STOP_LIMIT';
  const limitPrice = needsLimit ? price('limitPrice', req.limitPrice, true) : null;
  const stopPrice = needsStop ? price('stopPrice', req.stopPrice, true) : null;
  // trailingStopPips is the trail of a TRAILING_STOP order, or, on any other type, a trailing
  // stop-loss bracket (as in the TradingView broker API).
  let trailingStopPips = null;
  if (type === 'TRAILING_STOP' || present(req.trailingStopPips)) {
    if (!Number.isInteger(Number(req.trailingStopPips)) || Number(req.trailingStopPips) <= 0) errors.push('trailingStopPips must be a whole number of ticks above zero');
    else trailingStopPips = Number(req.trailingStopPips);
  }
  if (type === 'MARKET' && !marketOpen) errors.push('The market is closed; market orders cannot be placed now');

  const last = D(quote.last);
  if (stopPrice && side === 'BUY' && stopPrice.lte(last)) errors.push(`A buy stop must be above the last price (${quote.last})`);
  if (stopPrice && side === 'SELL' && stopPrice.gte(last)) errors.push(`A sell stop must be below the last price (${quote.last})`);

  // Brackets (spec §6): stop loss and take profit must sit either side of the entry.
  const stopLoss = price('stopLoss', req.stopLoss, false);
  const takeProfit = price('takeProfit', req.takeProfit, false);
  if (stopLoss && trailingStopPips && type !== 'TRAILING_STOP') errors.push('Give a stop loss price or a trailing stop, not both');
  const entry = limitPrice ?? stopPrice ?? D(side === 'BUY' ? quote.ask : quote.bid);
  if (stopLoss && side === 'BUY' && stopLoss.gte(entry)) errors.push(`Stop loss must be below the entry price (${entry.toString()})`);
  if (stopLoss && side === 'SELL' && stopLoss.lte(entry)) errors.push(`Stop loss must be above the entry price (${entry.toString()})`);
  if (takeProfit && side === 'BUY' && takeProfit.lte(entry)) errors.push(`Take profit must be above the entry price (${entry.toString()})`);
  if (takeProfit && side === 'SELL' && takeProfit.gte(entry)) errors.push(`Take profit must be below the entry price (${entry.toString()})`);

  if (errors.length || !qty) return { ok: false, errors };
  return {
    ok: true,
    value: {
      clientOrderId: req.clientOrderId,
      symbol: s.name,
      side,
      type,
      qty: qty.toString(),
      limitPrice: limitPrice?.toString() ?? null,
      stopPrice: stopPrice?.toString() ?? null,
      trailingStopPips,
      stopLoss: stopLoss?.toString() ?? null,
      takeProfit: takeProfit?.toString() ?? null,
      duration,
    },
  };
}

/**
 * Move an order to a new status, enforcing the transition table. Returns a new record.
 * @param {Order} order @param {OrderStatus} status @param {number} now @param {string | null} [message]
 * @returns {Order}
 */
export function transition(order, status, now, message = null) {
  if (!canTransition(order.status, status)) {
    throw new Error(`Order ${order.id} cannot go from ${order.status} to ${status}`);
  }
  return { ...order, status, updatedAt: now, message: message ?? order.message };
}

/** Orders that can still fill or be cancelled. @param {Order} order */
export const isLive = (order) => !isFinal(order.status) && order.status !== 'PLACING';

/** Quantity still to fill. @param {Order} order */
export const remaining = (order) => D(order.qty).minus(order.filledQty);
