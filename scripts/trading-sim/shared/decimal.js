/**
 * Exact decimal arithmetic for prices, quantities and money (spec §10, requirement SEC-4).
 * This is the only file that imports decimal.js; everything else imports D() from here.
 * On the wire, decimals travel as strings ("64250.50"), never as JS numbers.
 */
import Decimal from '../vendor/decimal.js';

/** A precision and rounding that comfortably covers crypto quantities times prices. */
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** @typedef {InstanceType<typeof Dec>} Dec */
/** @typedef {string | number | Dec} DecLike */

/**
 * Make a decimal. Accepts strings, integers and decimals. Floats are converted through their
 * shortest string form, so 0.1 stays 0.1.
 * @param {DecLike} value
 * @returns {Dec}
 */
export function D(value) {
  if (value instanceof Dec) return value;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`Not a number: ${value}`);
  return new Dec(value);
}

export const ZERO = D(0);
export const ONE = D(1);

/**
 * True if the value parses as a finite decimal.
 * @param {unknown} value
 */
export function isDecimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  if (typeof value === 'string' && !/^-?\d+(\.\d+)?$/.test(value.trim())) return false;
  try { return D(value).isFinite(); } catch { return false; }
}

/**
 * Round a price to the nearest multiple of the tick size.
 * @param {DecLike} price
 * @param {DecLike} tick
 */
export function roundToTick(price, tick) {
  const t = D(tick);
  return D(price).div(t).toDecimalPlaces(0, Dec.ROUND_HALF_UP).mul(t);
}

/**
 * True if the price is an exact multiple of the tick size.
 * @param {DecLike} price
 * @param {DecLike} tick
 */
export function onTick(price, tick) {
  return D(price).mod(D(tick)).isZero();
}

/**
 * Format a decimal as a fixed-point string with the given number of places.
 * @param {DecLike} value
 * @param {number} places
 */
export function fixed(value, places) {
  return D(value).toFixed(places, Dec.ROUND_HALF_UP);
}

/**
 * Number of decimal places in a tick or step size ("0.01" → 2, "1" → 0).
 * @param {DecLike} step
 */
export function placesOf(step) {
  return D(step).decimalPlaces();
}

/** @param {DecLike[]} values */
export function sum(values) {
  return values.reduce((/** @type {Dec} */ acc, v) => acc.plus(D(v)), ZERO);
}

/** @param {DecLike} a @param {DecLike} b */
export const max = (a, b) => (D(a).gte(D(b)) ? D(a) : D(b));
/** @param {DecLike} a @param {DecLike} b */
export const min = (a, b) => (D(a).lte(D(b)) ? D(a) : D(b));
