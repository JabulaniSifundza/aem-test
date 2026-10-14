/**
 * Display formatting. Prices use the symbol's tick (BTCUSDT 66,403.7; SPY 580.97), quantities its
 * lot. Values arrive as decimal strings and are formatted, never rounded, except where a column
 * explicitly shows fewer places (P&L in dollars).
 */
import { getSymbol, decimalsOf } from '../../shared/symbols.js';
import { D } from '../../shared/decimal.js';

/** @type {Map<string, Intl.NumberFormat>} */
const formats = new Map();
/** @param {number} places @param {boolean} [sign] */
function fmt(places, sign = false) {
  const key = `${places}:${sign}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: places, maximumFractionDigits: places, signDisplay: sign ? 'exceptZero' : 'auto' });
    formats.set(key, f);
  }
  return f;
}

/** @param {string} symbol */
export const priceDecimals = (symbol) => decimalsOf(getSymbol(symbol)?.tick ?? '0.01');
/** @param {string} symbol */
export const qtyDecimals = (symbol) => decimalsOf(getSymbol(symbol)?.lot ?? '1');

/**
 * Format a decimal string exactly: thousands separators, fixed places, true minus sign.
 * Intl would go through a float; this keeps the digits as given.
 * @param {string | number | null | undefined} value @param {number} places @param {boolean} [sign]
 */
export function formatDecimal(value, places, sign = false) {
  if (value === null || value === undefined || value === '') return '–';
  let d;
  try { d = D(value); } catch { return '–'; }
  const fixed = d.abs().toFixed(places);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac ? `${grouped}.${frac}` : grouped;
  if (d.isNeg() && !d.isZero()) return `−${body}`;
  if (sign && !d.isZero()) return `+${body}`;
  return body;
}

/** @param {string} symbol @param {string | number | null | undefined} value @param {boolean} [sign] */
export const formatPrice = (symbol, value, sign = false) => formatDecimal(value, priceDecimals(symbol), sign);
/** @param {string} symbol @param {string | number | null | undefined} value */
export const formatQty = (symbol, value) => formatDecimal(value, qtyDecimals(symbol));
/** @param {string | number | null | undefined} value @param {boolean} [sign] */
export const formatMoney = (value, sign = false) => {
  const s = formatDecimal(value, 2, sign);
  if (s === '–') return s;
  return s.startsWith('−') ? `−$${s.slice(1)}` : s.startsWith('+') ? `+$${s.slice(1)}` : `$${s}`;
};
/** @param {string | number | null | undefined} value */
export const formatPercent = (value) => (value === null || value === undefined ? '–' : `${formatDecimal(value, 2, true)}%`);

/** Compact volume: 1.32K, 4.5M. Display only. @param {number} n */
export function formatCompact(n) {
  if (!Number.isFinite(n)) return '–';
  return fmt(2).format(n >= 1e9 ? n / 1e9 : n >= 1e6 ? n / 1e6 : n >= 1e3 ? n / 1e3 : n).replace(/\.?0+$/, '') + (n >= 1e9 ? 'B' : n >= 1e6 ? 'M' : n >= 1e3 ? 'K' : '');
}

/** "+" or "−" class for a signed value: 'cme-gain' | 'cme-loss' | ''. @param {string | number | null | undefined} value */
export function signClass(value) {
  if (value === null || value === undefined || value === '') return '';
  try {
    const d = D(value);
    return d.isZero() ? '' : d.isPos() ? 'cme-gain' : 'cme-loss';
  } catch { return ''; }
}

const timeFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short' });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Header clock: "01:37:28 pm CDT 10/13/2026". @param {number} t */
export function formatClock(t) {
  const parts = timeFmt.formatToParts(new Date(t));
  const get = (/** @type {string} */ type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod').toLowerCase()} ${get('timeZoneName')} ${dateFmt.format(new Date(t))}`;
}
/** @param {number} t */
export const formatDateTime = (t) => dateTimeFmt.format(new Date(t));

/** Readable labels for protocol words. */
export const LABELS = {
  side: /** @type {Record<string, string>} */ ({ BUY: 'Buy', SELL: 'Sell' }),
  type: /** @type {Record<string, string>} */ ({ MARKET: 'Market', LIMIT: 'Limit', STOP: 'Stop', STOP_LIMIT: 'Stop limit', TRAILING_STOP: 'Trailing stop' }),
  status: /** @type {Record<string, string>} */ ({ PLACING: 'Placing', INACTIVE: 'Inactive', WORKING: 'Working', PARTIALLY_FILLED: 'Partly filled', FILLED: 'Filled', CANCELED: 'Cancelled', REJECTED: 'Rejected', EXPIRED: 'Expired' }),
  duration: /** @type {Record<string, string>} */ ({ DAY: 'Day', GTC: 'GTC', IOC: 'IOC', FOK: 'FOK' }),
};
