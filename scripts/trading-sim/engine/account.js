/**
 * Account arithmetic: balance, positions (netting: one per symbol), fills, P&L, margin,
 * leverage and liquidation price. All money is Decimal (requirement SEC-4).
 *
 * Definitions used throughout:
 * - initial margin rate = 1 / leverage; margin for a position = |qty| × mark × rate
 * - maintenance margin = initial margin × the symbol's maintenance ratio
 * - equity = balance + unrealized P&L; free margin = equity − margin used
 * - commission and borrow fees are charged to the balance
 */
import { D, ZERO, ONE } from '../shared/decimal.js';
import { getSymbol } from '../shared/symbols.js';

/** @typedef {import('../shared/decimal.js').Dec} Dec */
/** @typedef {import('../shared/decimal.js').DecLike} DecLike */
/** @typedef {import('../shared/protocol.js').Side} Side */

/**
 * @typedef {object} Position
 * @property {string} symbol
 * @property {Dec} qty        signed: positive long, negative short
 * @property {Dec} avgPrice
 * @property {Dec} realizedPL  since the position was opened
 * @property {number} openedAt
 * @property {number} updatedAt
 */

/**
 * @typedef {object} Account
 * @property {string} user
 * @property {string} currency
 * @property {Dec} balance
 * @property {Dec} startingBalance
 * @property {Map<string, Position>} positions
 * @property {Map<string, number>} leverage   per symbol, when changed from the default
 */

/**
 * @param {string} user
 * @param {DecLike} startingBalance
 * @returns {Account}
 */
export function createAccount(user, startingBalance) {
  return { user, currency: 'USD', balance: D(startingBalance), startingBalance: D(startingBalance), positions: new Map(), leverage: new Map() };
}

/** @param {string} symbol */
function def(symbol) {
  const s = getSymbol(symbol);
  if (!s) throw new RangeError(`Unknown symbol: ${symbol}`);
  return s;
}

/** @param {Account} account @param {string} symbol */
export function leverageOf(account, symbol) {
  return account.leverage.get(symbol) ?? def(symbol).leverage.initial;
}

/** Initial margin rate (0.05 at 20×). @param {Account} account @param {string} symbol */
export function initialRate(account, symbol) {
  return ONE.div(leverageOf(account, symbol));
}

/** @param {Account} account @param {string} symbol */
export function maintenanceRate(account, symbol) {
  return initialRate(account, symbol).mul(def(symbol).maintenanceRatio);
}

/**
 * Commission for a fill: a rate of notional (crypto) or per unit with a minimum (stocks).
 * @param {string} symbol @param {DecLike} qty @param {DecLike} price
 */
export function commissionFor(symbol, qty, price) {
  const c = def(symbol).commission;
  const q = D(qty).abs();
  if (c.rate) return q.mul(D(price)).mul(c.rate).toDecimalPlaces(2);
  const fee = q.mul(c.perUnit ?? 0);
  const minimum = D(c.minimum ?? 0);
  return (fee.lt(minimum) ? minimum : fee).toDecimalPlaces(2);
}

/**
 * Daily borrow fee on a short position (0 for longs): |qty| × price × annual rate / 360.
 * @param {string} symbol @param {DecLike} signedQty @param {DecLike} price
 */
export function borrowFeePerDay(symbol, signedQty, price) {
  const q = D(signedQty);
  if (q.gte(0)) return ZERO;
  return q.abs().mul(D(price)).mul(def(symbol).borrowRateAnnual).div(360).toDecimalPlaces(2);
}

/** @param {Position} p @param {DecLike} mark */
export function unrealizedPL(p, mark) {
  return D(mark).minus(p.avgPrice).mul(p.qty);
}

/**
 * Apply a fill to the account: update the position (netting), realize P&L on the closed part,
 * charge commission.
 * @param {Account} account
 * @param {{ symbol: string, side: Side, qty: DecLike, price: DecLike, time: number }} fill
 * @returns {{ position: Position, realizedPL: Dec, commission: Dec, closedQty: Dec, reversed: boolean, closed: boolean }}
 */
export function applyFill(account, { symbol, side, qty, price, time }) {
  const signed = side === 'BUY' ? D(qty) : D(qty).neg();
  const px = D(price);
  const existing = account.positions.get(symbol);
  const before = existing ? existing.qty : ZERO;
  const after = before.plus(signed);
  let realized = ZERO;
  let closedQty = ZERO;
  /** @type {Position} */
  let position;

  if (!existing || before.isZero()) {
    position = { symbol, qty: signed, avgPrice: px, realizedPL: ZERO, openedAt: time, updatedAt: time };
  } else if (before.isPos() === signed.isPos()) {
    // Adding to the position: weighted average entry.
    const avg = existing.avgPrice.mul(before.abs()).plus(px.mul(signed.abs())).div(after.abs());
    position = { ...existing, qty: after, avgPrice: avg, updatedAt: time };
  } else {
    // Reducing, closing or reversing.
    closedQty = signed.abs().lt(before.abs()) ? signed.abs() : before.abs();
    realized = px.minus(existing.avgPrice).mul(closedQty).mul(before.isPos() ? 1 : -1);
    if (after.isZero()) {
      position = { ...existing, qty: ZERO, realizedPL: existing.realizedPL.plus(realized), updatedAt: time };
    } else if (after.isPos() === before.isPos()) {
      position = { ...existing, qty: after, realizedPL: existing.realizedPL.plus(realized), updatedAt: time };
    } else {
      position = { symbol, qty: after, avgPrice: px, realizedPL: ZERO, openedAt: time, updatedAt: time };
    }
  }

  const commission = commissionFor(symbol, qty, px);
  account.balance = account.balance.plus(realized).minus(commission);
  if (position.qty.isZero()) account.positions.delete(symbol);
  else account.positions.set(symbol, position);
  const reversed = !before.isZero() && !after.isZero() && before.isPos() !== after.isPos();
  return { position, realizedPL: realized, commission, closedQty, reversed, closed: after.isZero() && !before.isZero() };
}

/**
 * @param {Account} account
 * @param {(symbol: string) => DecLike} markOf  current mark price per symbol
 */
export function summary(account, markOf) {
  let unrealized = ZERO;
  let marginUsed = ZERO;
  let maintenance = ZERO;
  for (const p of account.positions.values()) {
    const mark = D(markOf(p.symbol));
    unrealized = unrealized.plus(unrealizedPL(p, mark));
    const notional = p.qty.abs().mul(mark);
    marginUsed = marginUsed.plus(notional.mul(initialRate(account, p.symbol)));
    maintenance = maintenance.plus(notional.mul(maintenanceRate(account, p.symbol)));
  }
  const equity = account.balance.plus(unrealized);
  return { balance: account.balance, equity, unrealizedPL: unrealized, marginUsed, maintenanceMargin: maintenance, freeMargin: equity.minus(marginUsed) };
}

/**
 * Margin needed for a position of `qty` (signed) at `price`.
 * @param {Account} account @param {string} symbol @param {DecLike} qty @param {DecLike} price
 */
export function marginFor(account, symbol, qty, price) {
  return D(qty).abs().mul(D(price)).mul(initialRate(account, symbol));
}

/**
 * Extra initial margin an order would need: margin of the resulting position minus margin of the
 * current one (zero or negative when the order reduces the position).
 * @param {Account} account @param {string} symbol @param {Side} side @param {DecLike} qty @param {DecLike} price
 */
export function marginIncrease(account, symbol, side, qty, price) {
  const current = account.positions.get(symbol)?.qty ?? ZERO;
  const next = current.plus(side === 'BUY' ? D(qty) : D(qty).neg());
  return marginFor(account, symbol, next, price).minus(marginFor(account, symbol, current, price));
}

/**
 * The mark price of `symbol` at which equity would fall to the maintenance margin, other
 * positions held at their current marks. Null when there is no position or no such price.
 *
 * With equity E at mark m and other positions' maintenance M_other:
 * Long q:  E + q(p − m) = M_other + q·p·r   →  p = (M_other − E + q·m) / (q(1 − r))
 * Short q: E − q(p − m) = M_other + q·p·r   →  p = (E + q·m − M_other) / (q(1 + r))
 * For a hypothetical size (a preview), E is today's equity: the new size moves from the mark too.
 * @param {Account} account
 * @param {string} symbol
 * @param {(symbol: string) => DecLike} markOf
 * @param {Dec} [signedQty]  a hypothetical position size (for previews); defaults to the current one
 */
export function liquidationPrice(account, symbol, markOf, signedQty) {
  const position = account.positions.get(symbol);
  const qty = signedQty ?? position?.qty ?? ZERO;
  if (qty.isZero()) return null;
  const s = summary(account, markOf);
  const mark = D(markOf(symbol));
  const r = maintenanceRate(account, symbol);
  // Equity moves with the whole position from the current mark, whatever its entry price.
  const currentQty = position?.qty ?? ZERO;
  const maintenanceOther = s.maintenanceMargin.minus(currentQty.abs().mul(mark).mul(r));
  const E = s.equity;
  const q = qty.abs();
  const p = qty.isPos()
    ? maintenanceOther.minus(E).plus(q.mul(mark)).div(q.mul(ONE.minus(r)))
    : E.plus(q.mul(mark)).minus(maintenanceOther).div(q.mul(ONE.plus(r)));
  return p.gt(0) ? p : null;
}
