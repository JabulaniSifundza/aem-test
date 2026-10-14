/**
 * Fill rules (spec §6, requirements O-1 to O-5). Pure functions over a book and a trade.
 *
 * - Market orders, and stops once triggered, take liquidity level by level from the best price
 *   (O-1). What the 25 visible levels can't fill is cancelled.
 * - A marketable limit order does the same but stops at its limit price (O-2).
 * - A resting limit order fills when the book crosses its price (at the book's prices, never worse
 *   than the limit) or when a trade prints at its price (up to that trade's size).
 * - Stops trigger on a trade at or through the stop price (O-3, O-4).
 * - Trailing stops follow the market by a fixed distance and never move back (O-5).
 */
import { D, ZERO } from '../shared/decimal.js';

/** @typedef {import('../shared/decimal.js').Dec} Dec */
/** @typedef {import('../shared/protocol.js').Side} Side */
/** @typedef {{ price: Dec, size: Dec }} Level */
/** @typedef {{ bids: Level[], asks: Level[] }} DecBook */
/** @typedef {{ price: Dec, qty: Dec }} Fill */

/**
 * Take liquidity from the opposite side of the book.
 * @param {DecBook} book @param {Side} side @param {Dec} qty @param {Dec | null} [limit]
 * @returns {{ fills: Fill[], filled: Dec }}
 */
export function walkBook(book, side, qty, limit = null) {
  const levels = side === 'BUY' ? book.asks : book.bids;
  /** @type {Fill[]} */
  const fills = [];
  let left = qty;
  for (const level of levels) {
    if (left.lte(0)) break;
    if (limit && (side === 'BUY' ? level.price.gt(limit) : level.price.lt(limit))) break;
    const take = left.lt(level.size) ? left : level.size;
    fills.push({ price: level.price, qty: take });
    left = left.minus(take);
  }
  return { fills, filled: qty.minus(left) };
}

/** Quantity available at or better than a limit (or in the whole book). @param {DecBook} book @param {Side} side @param {Dec | null} limit */
export function available(book, side, limit) {
  return walkBook(book, side, D('1e30'), limit).filled;
}

/**
 * Fills for a resting limit order on a new trade.
 * @param {DecBook} book @param {Side} side @param {Dec} limit @param {Dec} remaining
 * @param {{ price: Dec, volume: Dec }} trade
 * @returns {Fill[]}
 */
export function restingLimitFills(book, side, limit, remaining, trade) {
  const best = side === 'BUY' ? book.asks[0]?.price : book.bids[0]?.price;
  const crossed = best && (side === 'BUY' ? best.lte(limit) : best.gte(limit));
  if (crossed) return walkBook(book, side, remaining, limit).fills;
  const printed = side === 'BUY' ? trade.price.lte(limit) : trade.price.gte(limit);
  if (!printed || trade.volume.lte(0)) return [];
  return [{ price: limit, qty: remaining.lt(trade.volume) ? remaining : trade.volume }];
}

/**
 * True when a trade at `price` triggers a stop on this side: a buy stop at or above, a sell stop
 * at or below.
 * @param {Side} side @param {Dec} stop @param {Dec} price
 */
export function stopTriggered(side, stop, price) {
  return side === 'BUY' ? price.gte(stop) : price.lte(stop);
}

/**
 * The trailing stop level after a trade: a sell stop rises with the price, a buy stop falls with it.
 * @param {Side} side @param {Dec | null} current @param {Dec} price @param {Dec} distance
 */
export function trailStop(side, current, price, distance) {
  const candidate = side === 'SELL' ? price.minus(distance) : price.plus(distance);
  if (!current) return candidate;
  return side === 'SELL' ? (candidate.gt(current) ? candidate : current) : (candidate.lt(current) ? candidate : current);
}

/** Volume-weighted average price of fills. @param {Fill[]} fills */
export function averagePrice(fills) {
  let qty = ZERO, value = ZERO;
  for (const f of fills) { qty = qty.plus(f.qty); value = value.plus(f.qty.mul(f.price)); }
  return qty.isZero() ? null : value.div(qty);
}
