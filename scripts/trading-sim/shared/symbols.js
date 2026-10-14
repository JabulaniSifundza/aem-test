/**
 * The symbol catalogue (spec §2: BTCUSDT, ETHUSDT, SOLUSDT, SPY, QQQ) and trading sessions.
 *
 * Each symbol has three parts:
 * - what the chart library needs (the LibrarySymbolInfo fields, see toSymbolInfo),
 * - trading rules (tick, lot, leverage, commission, borrow fee),
 * - simulation settings (starting price, volatility, activity). Prices are simulated, not real.
 *
 * Stocks trade 09:30–16:00 New York time, Monday to Friday. Exchange holidays are not modelled.
 * Crypto trades around the clock; its trading day starts at 00:00 UTC.
 * The account is in USD; USDT is treated as equal to USD.
 */

export const DAY_MS = 86_400_000;

/**
 * @typedef {object} SymbolDef
 * @property {string} name
 * @property {string} description
 * @property {'crypto' | 'stock'} type
 * @property {string} exchange
 * @property {string} currency
 * @property {'24x7' | 'us-equity'} sessionKind
 * @property {string} tick           smallest price step
 * @property {string} lot            smallest quantity step
 * @property {string} minQty
 * @property {string} maxQty
 * @property {{ min: number, max: number, step: number, initial: number }} leverage
 * @property {string} maintenanceRatio  maintenance margin as a fraction of initial margin
 * @property {{ rate?: string, perUnit?: string, minimum?: string }} commission
 * @property {string} borrowRateAnnual  charged daily on short positions
 * @property {{ anchorPrice: number, annualVol: number, ticksPerMinute: [number, number],
 *              minuteVolume: number, levelSize: number }} sim
 */

/** @type {SymbolDef[]} */
const DEFS = [
  {
    name: 'BTCUSDT', description: 'Bitcoin / Tether', type: 'crypto', exchange: 'CRYPTO', currency: 'USDT',
    sessionKind: '24x7', tick: '0.1', lot: '0.001', minQty: '0.001', maxQty: '50',
    leverage: { min: 1, max: 100, step: 1, initial: 20 }, maintenanceRatio: '0.5',
    commission: { rate: '0.0004' }, borrowRateAnnual: '0.08',
    sim: { anchorPrice: 64000, annualVol: 0.5, ticksPerMinute: [30, 70], minuteVolume: 12, levelSize: 0.6 },
  },
  {
    name: 'ETHUSDT', description: 'Ethereum / Tether', type: 'crypto', exchange: 'CRYPTO', currency: 'USDT',
    sessionKind: '24x7', tick: '0.01', lot: '0.01', minQty: '0.01', maxQty: '1000',
    leverage: { min: 1, max: 100, step: 1, initial: 20 }, maintenanceRatio: '0.5',
    commission: { rate: '0.0004' }, borrowRateAnnual: '0.08',
    sim: { anchorPrice: 3200, annualVol: 0.65, ticksPerMinute: [25, 60], minuteVolume: 160, levelSize: 9 },
  },
  {
    name: 'SOLUSDT', description: 'Solana / Tether', type: 'crypto', exchange: 'CRYPTO', currency: 'USDT',
    sessionKind: '24x7', tick: '0.01', lot: '0.1', minQty: '0.1', maxQty: '20000',
    leverage: { min: 1, max: 50, step: 1, initial: 10 }, maintenanceRatio: '0.5',
    commission: { rate: '0.0004' }, borrowRateAnnual: '0.1',
    sim: { anchorPrice: 150, annualVol: 0.8, ticksPerMinute: [20, 50], minuteVolume: 2400, levelSize: 140 },
  },
  {
    name: 'SPY', description: 'SPDR S&P 500 ETF Trust', type: 'stock', exchange: 'NYSE Arca', currency: 'USD',
    sessionKind: 'us-equity', tick: '0.01', lot: '1', minQty: '1', maxQty: '100000',
    leverage: { min: 1, max: 4, step: 1, initial: 2 }, maintenanceRatio: '0.5',
    commission: { perUnit: '0.005', minimum: '1' }, borrowRateAnnual: '0.0025',
    sim: { anchorPrice: 580, annualVol: 0.16, ticksPerMinute: [30, 60], minuteVolume: 150000, levelSize: 900 },
  },
  {
    name: 'QQQ', description: 'Invesco QQQ Trust', type: 'stock', exchange: 'NASDAQ', currency: 'USD',
    sessionKind: 'us-equity', tick: '0.01', lot: '1', minQty: '1', maxQty: '100000',
    leverage: { min: 1, max: 4, step: 1, initial: 2 }, maintenanceRatio: '0.5',
    commission: { perUnit: '0.005', minimum: '1' }, borrowRateAnnual: '0.0025',
    sim: { anchorPrice: 500, annualVol: 0.22, ticksPerMinute: [30, 60], minuteVolume: 90000, levelSize: 600 },
  },
];

/** @type {Map<string, SymbolDef>} */
const BY_NAME = new Map(DEFS.map((d) => [d.name, d]));

/** Every symbol, in catalogue order. */
export const SYMBOLS = DEFS;

/** The spec's default watchlist (P-21). */
export const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SPY', 'QQQ'];

/** Exchanges and symbol types reported by onReady (spec §3, plus NYSE Arca for SPY). */
export const EXCHANGES = ['NASDAQ', 'NYSE Arca', 'CME', 'CRYPTO'];
export const SYMBOL_TYPES = ['crypto', 'stock', 'futures'];

/**
 * @param {string} name
 * @returns {SymbolDef | undefined}
 */
export function getSymbol(name) {
  return BY_NAME.get(String(name).toUpperCase().replace(/^[A-Z ]+:/, ''));
}

/** Number of decimal places of a step such as "0.01". @param {string} step */
export function decimalsOf(step) {
  const i = step.indexOf('.');
  return i < 0 ? 0 : step.length - i - 1;
}

/**
 * The LibrarySymbolInfo shape the TradingView datafeed returns from resolveSymbol (spec §3).
 * @param {SymbolDef} s
 * @param {string[]} resolutions
 */
export function toSymbolInfo(s, resolutions) {
  const priceDecimals = decimalsOf(s.tick);
  return {
    name: s.name,
    ticker: s.name,
    full_name: `${s.exchange}:${s.name}`,
    description: s.description,
    type: s.type,
    exchange: s.exchange,
    listed_exchange: s.exchange,
    currency_code: s.currency,
    session: s.sessionKind === '24x7' ? '24x7' : '0930-1600',
    session_display: s.sessionKind === '24x7' ? '24x7' : '09:30–16:00 ET, Mon–Fri',
    timezone: s.sessionKind === '24x7' ? 'Etc/UTC' : 'America/New_York',
    minmov: Math.round(Number(s.tick) * 10 ** priceDecimals),
    pricescale: 10 ** priceDecimals,
    min_tick: s.tick,
    lot_size: s.lot,
    volume_precision: decimalsOf(s.lot),
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    visible_plots_set: 'ohlcv',
    supported_resolutions: resolutions,
    data_status: 'streaming',
  };
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * Minutes a time zone is ahead of UTC at a given instant (New York: -240 or -300).
 * @param {string} timeZone
 * @param {number} utcMs
 */
export function tzOffsetMinutes(timeZone, utcMs) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  /** @type {Record<string, number>} */
  const p = {};
  for (const part of f.formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/**
 * The UTC instant of a wall-clock time in a time zone on a given UTC calendar day.
 * @param {string} timeZone @param {number} dayIndex days since 1970-01-01 @param {number} hour @param {number} minute
 */
function zonedTime(timeZone, dayIndex, hour, minute) {
  // Treat the wall-clock time as UTC, subtract the zone's offset, then correct once with the
  // offset at the result: the second pass matters only on daylight-saving change days.
  const wall = dayIndex * DAY_MS + (hour * 60 + minute) * 60_000;
  let utc = wall - tzOffsetMinutes(timeZone, wall) * 60_000;
  utc = wall - tzOffsetMinutes(timeZone, utc) * 60_000;
  return utc;
}

/** @param {number} t */
export const dayIndexOf = (t) => Math.floor(t / DAY_MS);

/**
 * True if the symbol trades on this calendar day (UTC date; for US equities the New York date
 * of the session is the same).
 * @param {SymbolDef} s @param {number} dayIndex
 */
export function isTradingDay(s, dayIndex) {
  if (s.sessionKind === '24x7') return true;
  const weekday = (dayIndex + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  return weekday !== 0 && weekday !== 6;
}

/**
 * Session times per calendar day. Intl formatting is slow (microseconds per call) and sessions
 * are asked for constantly, so each day is worked out once. Grows by one entry per day touched:
 * a few thousand entries at most.
 * @type {Map<string, {open: number, close: number}>}
 */
const sessionCache = new Map();

/**
 * Open and close of the session on a calendar day, or null when the market is shut all day.
 * @param {SymbolDef} s @param {number} dayIndex
 * @returns {{ open: number, close: number } | null}
 */
export function sessionOn(s, dayIndex) {
  if (!isTradingDay(s, dayIndex)) return null;
  if (s.sessionKind === '24x7') return { open: dayIndex * DAY_MS, close: (dayIndex + 1) * DAY_MS };
  const key = `${s.sessionKind}:${dayIndex}`;
  let session = sessionCache.get(key);
  if (!session) {
    session = {
      open: zonedTime('America/New_York', dayIndex, 9, 30),
      close: zonedTime('America/New_York', dayIndex, 16, 0),
    };
    sessionCache.set(key, session);
  }
  return session;
}

/**
 * The session that contains time t, or null if the market is closed at t.
 * @param {SymbolDef} s @param {number} t
 */
export function sessionAt(s, t) {
  const day = dayIndexOf(t);
  const session = sessionOn(s, day);
  if (session && t >= session.open && t < session.close) return { day, ...session };
  return null;
}

/** @param {SymbolDef} s @param {number} t */
export const isOpen = (s, t) => sessionAt(s, t) !== null;

/**
 * The most recent session that opened at or before t (the current one if open).
 * @param {SymbolDef} s @param {number} t
 */
export function lastSession(s, t) {
  for (let day = dayIndexOf(t), n = 0; n < 10; day -= 1, n += 1) {
    const session = sessionOn(s, day);
    if (session && session.open <= t) return { day, ...session };
  }
  throw new Error(`No session found for ${s.name}`);
}

/**
 * The next session close strictly after t (when DAY orders expire).
 * @param {SymbolDef} s @param {number} t
 */
export function nextClose(s, t) {
  for (let day = dayIndexOf(t), n = 0; n < 10; day += 1, n += 1) {
    const session = sessionOn(s, day);
    if (session && session.close > t) return session.close;
  }
  throw new Error(`No session close found for ${s.name}`);
}
