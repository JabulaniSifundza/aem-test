/**
 * Order preview (spec §4 previewOrder, requirement B-7): what an order would cost and risk before
 * it is placed. All money is Decimal.
 */
import { D, ZERO } from '../shared/decimal.js';
import {
  commissionFor, marginIncrease, summary, initialRate, liquidationPrice, borrowFeePerDay,
} from './account.js';
import { walkBook, averagePrice } from './matching.js';

/** @typedef {import('./account.js').Account} Account */
/** @typedef {import('./matching.js').DecBook} DecBook */
/** @typedef {import('./orders.js').Order} Order */
/** @typedef {import('../shared/decimal.js').Dec} Dec */

/** Warn when a limit or stop is further than this from the market. */
const FAR_FROM_MARKET = D('0.05');

/**
 * @param {object} input
 * @param {Account} input.account
 * @param {Pick<Order, 'symbol' | 'side' | 'type' | 'qty' | 'limitPrice' | 'stopPrice' | 'trailingStopPips'>} input.order
 * @param {DecBook} input.book
 * @param {Dec} input.last
 * @param {string} input.tick
 * @param {boolean} input.marketOpen
 * @param {(symbol: string) => string} input.markOf
 */
export function previewOrder({ account, order, book, last, tick, marketOpen, markOf }) {
  const qty = D(order.qty);
  /** @type {string[]} */
  const warnings = [];

  // The price the order is expected to fill at.
  let price;
  if (order.type === 'MARKET') {
    const walk = walkBook(book, order.side, qty);
    price = averagePrice(walk.fills) ?? last;
    if (walk.filled.lt(qty)) warnings.push(`Only ${walk.filled.toString()} can fill against the visible book; the rest would be cancelled.`);
  } else if (order.type === 'LIMIT' || order.type === 'STOP_LIMIT') {
    price = D(/** @type {string} */ (order.limitPrice));
  } else if (order.type === 'STOP') {
    price = D(/** @type {string} */ (order.stopPrice));
  } else {
    const distance = D(order.trailingStopPips ?? 0).mul(tick);
    price = order.side === 'SELL' ? last.minus(distance) : last.plus(distance);
  }

  const commission = commissionFor(order.symbol, qty, price);
  const increase = marginIncrease(account, order.symbol, order.side, qty, price);
  const marginRequired = increase.gt(0) ? increase : ZERO;
  const { freeMargin } = summary(account, markOf);
  const current = account.positions.get(order.symbol)?.qty ?? ZERO;
  const next = current.plus(order.side === 'BUY' ? qty : qty.neg());
  const liquidation = next.isZero() ? null : liquidationPrice(account, order.symbol, markOf, next);

  if (marginRequired.plus(commission).gt(freeMargin)) warnings.push('Not enough free margin: this order would be rejected.');
  if (!marketOpen) warnings.push(order.type === 'MARKET' ? 'The market is closed: market orders are rejected.' : 'The market is closed: the order will work when it opens.');
  if (!current.isZero() && !next.isZero() && current.isPos() !== next.isPos()) warnings.push('This order reverses your position.');
  if (order.type !== 'MARKET' && price.minus(last).abs().div(last).gt(FAR_FROM_MARKET)) warnings.push('The order price is more than 5% away from the last price.');
  if (liquidation && liquidation.minus(price).abs().div(price).lt(D('0.02'))) warnings.push('The estimated liquidation price is within 2% of the entry price.');

  return {
    commission: commission.toFixed(2),
    marginRequired: marginRequired.toFixed(2),
    initialMarginRate: initialRate(account, order.symbol).mul(100).toDecimalPlaces(4).toString(),
    estLiquidationPrice: liquidation ? liquidation.toDecimalPlaces(D(tick).decimalPlaces()).toString() : null,
    dailyBorrowFee: borrowFeePerDay(order.symbol, next, price).toFixed(2),
    estimatedPrice: price.toDecimalPlaces(D(tick).decimalPlaces()).toString(),
    warnings,
  };
}
