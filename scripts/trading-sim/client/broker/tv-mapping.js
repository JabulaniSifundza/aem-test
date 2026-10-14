/**
 * Converts the broker's protocol records into the TradingView Charting Library's broker types,
 * for when the licensed library is plugged in (DECISIONS.md D6). Nothing in the app uses this
 * today; it documents and tests the mapping so the swap is mechanical.
 *
 * Enum values are those of the library's broker API (Side, OrderType, OrderStatus, ParentType,
 * StopType). Prices and quantities become numbers there, because the library expects numbers;
 * the server stays the source of truth for money.
 */

/** @typedef {import('./host.js').Order} Order */
/** @typedef {import('./host.js').Position} Position */
/** @typedef {import('./host.js').Execution} Execution */

export const TV = /** @type {const} */ ({
  Side: { Buy: 1, Sell: -1 },
  OrderType: { Limit: 1, Market: 2, Stop: 3, StopLimit: 4 },
  OrderStatus: { Canceled: 1, Filled: 2, Inactive: 3, Placing: 4, Rejected: 5, Working: 6 },
  ParentType: { Order: 1, Position: 2 },
  StopType: { StopLoss: 0, TrailingStop: 1 },
});

/** @param {string | null | undefined} v */
const num = (v) => (v === null || v === undefined ? undefined : Number(v));

const STATUS = /** @type {Record<Order['status'], number>} */ ({
  PLACING: TV.OrderStatus.Placing, INACTIVE: TV.OrderStatus.Inactive, WORKING: TV.OrderStatus.Working,
  PARTIALLY_FILLED: TV.OrderStatus.Working, FILLED: TV.OrderStatus.Filled, CANCELED: TV.OrderStatus.Canceled,
  REJECTED: TV.OrderStatus.Rejected, EXPIRED: TV.OrderStatus.Canceled,
});

const TYPE = /** @type {Record<Order['type'], number>} */ ({
  MARKET: TV.OrderType.Market, LIMIT: TV.OrderType.Limit, STOP: TV.OrderType.Stop,
  STOP_LIMIT: TV.OrderType.StopLimit, TRAILING_STOP: TV.OrderType.Stop,
});

/** @param {Order} o */
export function toTvOrder(o) {
  return {
    id: o.id,
    symbol: o.symbol,
    type: TYPE[o.type],
    side: o.side === 'BUY' ? TV.Side.Buy : TV.Side.Sell,
    qty: Number(o.qty),
    status: STATUS[o.status],
    limitPrice: num(o.limitPrice),
    stopPrice: num(o.stopPrice),
    avgPrice: num(o.avgFillPrice),
    filledQty: Number(o.filledQty),
    parentId: o.parentId ?? undefined,
    parentType: o.parentType === 'order' ? TV.ParentType.Order : o.parentType === 'position' ? TV.ParentType.Position : undefined,
    stopType: o.type === 'TRAILING_STOP' ? TV.StopType.TrailingStop : undefined,
    trailingStopPips: o.trailingStopPips ?? undefined,
    stopLoss: num(o.stopLoss),
    takeProfit: num(o.takeProfit),
    duration: { type: o.duration, ...(o.expiresAt ? { datetime: o.expiresAt } : {}) },
    message: o.message ? { text: o.message, type: o.status === 'REJECTED' ? 'error' : 'information' } : undefined,
  };
}

/** @param {Position} p */
export function toTvPosition(p) {
  return {
    id: p.id, symbol: p.symbol, qty: Number(p.qty), side: p.side === 'BUY' ? TV.Side.Buy : TV.Side.Sell,
    avgPrice: Number(p.avgPrice), stopLoss: num(p.stopLoss), takeProfit: num(p.takeProfit),
    trailingStopPips: p.trailingStopPips ?? undefined,
  };
}

/** @param {Execution} e */
export function toTvExecution(e) {
  return { symbol: e.symbol, price: Number(e.price), qty: Number(e.qty), side: e.side === 'BUY' ? TV.Side.Buy : TV.Side.Sell, time: e.time };
}

/**
 * The library's PreOrder → our PreOrder.
 * @param {{ symbol: string, type: number, side: number, qty: number, limitPrice?: number, stopPrice?: number, stopLoss?: number, takeProfit?: number, trailingStopPips?: number, stopType?: number, duration?: { type: string } }} pre
 * @returns {import('./broker.js').PreOrder}
 */
export function fromTvPreOrder(pre) {
  /** @param {number | undefined} v */
  const str = (v) => (v === undefined ? null : String(v));
  const types = /** @type {Record<number, import('./broker.js').PreOrder['type']>} */ ({ 1: 'LIMIT', 2: 'MARKET', 3: 'STOP', 4: 'STOP_LIMIT' });
  return {
    symbol: pre.symbol,
    side: pre.side === TV.Side.Buy ? 'BUY' : 'SELL',
    type: types[pre.type],
    qty: String(pre.qty),
    limitPrice: str(pre.limitPrice),
    stopPrice: str(pre.stopPrice),
    stopLoss: pre.stopType === TV.StopType.TrailingStop ? null : str(pre.stopLoss),
    takeProfit: str(pre.takeProfit),
    trailingStopPips: pre.trailingStopPips ?? null,
    duration: /** @type {import('./broker.js').PreOrder['duration']} */ (pre.duration?.type ?? 'GTC'),
  };
}
