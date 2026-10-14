/**
 * The simulated market: price history, live ticks and the order book for every symbol.
 *
 * Everything is a pure function of (seed, symbol, time), so history never changes on reload,
 * live ticks always agree with the bars built from them, and tests are repeatable.
 *
 * How prices are made, from coarse to fine:
 * 1. Daily closes: a mean-reverting random walk that starts at the symbol's anchor price at the
 *    start of history and wanders around it, so prices stay plausible over the years.
 *    Stocks open with an overnight gap; crypto opens at the previous close.
 * 2. Minute closes: a Brownian bridge from the day's open to its close, so minutes always add up
 *    to the day. Each minute gets a high, low, volume and number of trades.
 * 3. Ticks: generated inside each minute so that they start at its open, touch its high and low,
 *    and end at its close. A minute bar built from ticks equals the minute's anchor exactly.
 * Prices are integers counted in ticks inside this module; quantities are integers counted in lots.
 *
 * User orders do not move the simulated market (no market impact).
 */
import { DAY_MS, getSymbol, sessionOn, isTradingDay, dayIndexOf, decimalsOf } from '../shared/symbols.js';
import { barStart, parseResolution, MINUTE_MS } from '../shared/resolution.js';
import { stream } from './random.js';
import { DEPTH_LEVELS } from '../shared/protocol.js';

/** History starts on 1 Oct 2023, at each symbol's anchor price. */
export const HISTORY_START_DAY = dayIndexOf(Date.UTC(2023, 9, 1));
/** How far (in log terms) prices typically stray from the anchor. */
const PRICE_RANGE = 0.35;

/** Share of a stock's daily move that happens overnight, as the opening gap. */
const GAP_SHARE = 0.3;
/** Minute anchors kept in memory (days). */
const DAY_CACHE_SIZE = 40;

/** @typedef {import('../shared/symbols.js').SymbolDef} SymbolDef */
/** @typedef {{ time: number, open: number, high: number, low: number, close: number, volume: number }} Bar  prices in ticks, volume in lots */
/** @typedef {{ time: number, price: number, volume: number, side: 'buy' | 'sell' }} Tick */
/** @typedef {{ bids: Array<[number, number]>, asks: Array<[number, number]> }} Book  [price in ticks, size in lots], best first */

/**
 * @typedef {object} SymbolModel
 * @property {SymbolDef} def
 * @property {number} tick          tick size as a number (for logs and ratios only, never for money)
 * @property {number} lot           lot size as a number
 * @property {number} priceDecimals
 * @property {number} qtyDecimals
 * @property {number} minutesPerDay
 * @property {number} dailyVol      standard deviation of a day's log return
 * @property {{ first: number, logs: number[] }} closes   log close per day from HISTORY_START_DAY
 * @property {Map<number, Float64Array>} minuteCache     day → 6 numbers per minute: o h l c v n
 * @property {Map<number, Bar>} dayCache                  full days only
 * @property {Map<number, Tick[]>} tickCache             recent minutes' ticks
 */

/**
 * @param {{ seed?: string }} [options]
 */
export function createMarket({ seed = 'trading-sim' } = {}) {
  /** @type {Map<string, SymbolModel>} */
  const models = new Map();

  /** @param {string} name */
  function model(name) {
    let m = models.get(name);
    if (m) return m;
    const def = getSymbol(name);
    if (!def) throw new RangeError(`Unknown symbol: ${name}`);
    const crypto = def.sessionKind === '24x7';
    m = {
      def,
      tick: Number(def.tick),
      lot: Number(def.lot),
      priceDecimals: decimalsOf(def.tick),
      qtyDecimals: decimalsOf(def.lot),
      minutesPerDay: crypto ? 1440 : 390,
      dailyVol: def.sim.annualVol / Math.sqrt(crypto ? 365 : 252),
      closes: { first: HISTORY_START_DAY, logs: [] },
      minuteCache: new Map(),
      dayCache: new Map(),
      tickCache: new Map(),
    };
    models.set(def.name, m);
    return m;
  }

  // ------------------------------------------------------------------ daily closes

  /**
   * Log close of a day: L(d) = L(d-1) + σ·z − κ·(L(d-1) − anchor), on trading days only.
   * κ is chosen so prices typically stay within PRICE_RANGE of the anchor.
   * @param {SymbolModel} m @param {number} day
   */
  function closeLog(m, day) {
    if (day < HISTORY_START_DAY) throw new RangeError('Before the start of history');
    const { logs } = m.closes;
    const anchor = Math.log(m.def.sim.anchorPrice);
    const kappa = m.dailyVol ** 2 / (2 * PRICE_RANGE ** 2);
    if (logs.length === 0) logs.push(anchor);
    while (HISTORY_START_DAY + logs.length <= day) {
      const d = HISTORY_START_DAY + logs.length;
      const prev = logs[logs.length - 1];
      if (!isTradingDay(m.def, d)) { logs.push(prev); continue; }
      const regime = Math.exp(0.35 * stream(seed, m.def.name, 'regime', Math.floor(d / 20)).normal());
      const z = stream(seed, m.def.name, 'day', d).normal();
      logs.push(prev + m.dailyVol * regime * z - kappa * (prev - anchor));
    }
    return logs[day - HISTORY_START_DAY];
  }

  /** @param {SymbolModel} m @param {number} logPrice */
  const toTicks = (m, logPrice) => Math.max(1, Math.round(Math.exp(logPrice) / m.tick));

  // ------------------------------------------------------------------ minutes

  /** Start of minute i of a trading day. @param {SymbolModel} m @param {number} day @param {number} i */
  function minuteTime(m, day, i) {
    const session = sessionOn(m.def, day);
    if (!session) throw new RangeError('Not a trading day');
    return session.open + i * MINUTE_MS;
  }

  /**
   * Minute anchors for a trading day: Float64Array of [open, high, low, close, volume, trades] × minutes.
   * @param {SymbolModel} m @param {number} day
   */
  function minutesOf(m, day) {
    const cached = m.minuteCache.get(day);
    if (cached) { m.minuteCache.delete(day); m.minuteCache.set(day, cached); return cached; }

    const n = m.minutesPerDay;
    const close = closeLog(m, day);
    let prev = day - 1;
    while (prev > HISTORY_START_DAY && !isTradingDay(m.def, prev)) prev -= 1;
    const prevClose = day > HISTORY_START_DAY ? closeLog(m, prev) : close;
    const crypto = m.def.sessionKind === '24x7';
    const openLog = crypto ? prevClose : prevClose + GAP_SHARE * (close - prevClose)
      + 0.15 * m.dailyVol * stream(seed, m.def.name, 'gap', day).normal();

    // Brownian bridge from openLog to close over n minutes.
    const r = stream(seed, m.def.name, 'minutes', day);
    const sigma = m.dailyVol * (crypto ? 1 : Math.sqrt(1 - GAP_SHARE)) / Math.sqrt(n);
    const walk = new Float64Array(n + 1);
    for (let i = 1; i <= n; i += 1) walk[i] = walk[i - 1] + sigma * r.normal();
    const out = new Float64Array(n * 6);
    let prevTicks = toTicks(m, openLog);
    const [tMin, tMax] = m.def.sim.ticksPerMinute;
    const lotsPerMinute = m.def.sim.minuteVolume / m.lot;
    for (let i = 0; i < n; i += 1) {
      const f = (i + 1) / n;
      const log = openLog + walk[i + 1] - f * walk[n] + f * (close - openLog);
      const c = i === n - 1 ? toTicks(m, close) : toTicks(m, log);
      const o = prevTicks;
      const wick = sigma * Math.exp(log) / m.tick * 0.8;
      const h = Math.max(o, c) + Math.floor(Math.abs(r.normal()) * wick);
      const l = Math.max(1, Math.min(o, c) - Math.floor(Math.abs(r.normal()) * wick));
      const trades = r.int(tMin, tMax);
      const x = i / (n - 1);
      const shape = crypto ? 1 : 0.6 + 1.6 * (2 * x - 1) ** 2; // U-shaped day for stocks
      const volume = Math.max(trades, Math.round(lotsPerMinute * shape * Math.exp(0.5 * r.normal() - 0.125)));
      out.set([o, h, l, c, volume, trades], i * 6);
      prevTicks = c;
    }
    m.minuteCache.set(day, out);
    if (m.minuteCache.size > DAY_CACHE_SIZE) {
      const oldest = m.minuteCache.keys().next().value;
      if (oldest !== undefined) m.minuteCache.delete(oldest);
    }
    return out;
  }

  /**
   * The ticks inside one minute, in time order.
   * @param {SymbolModel} m @param {number} day @param {number} i
   * @returns {Tick[]}
   */
  function ticksOfMinute(m, day, i) {
    const key = day * 1440 + i;
    const hit = m.tickCache.get(key);
    if (hit) return hit;
    const ticks = makeTicks(m, day, i);
    m.tickCache.set(key, ticks);
    if (m.tickCache.size > 256) {
      const oldest = m.tickCache.keys().next().value;
      if (oldest !== undefined) m.tickCache.delete(oldest);
    }
    return ticks;
  }

  /** @param {SymbolModel} m @param {number} day @param {number} i @returns {Tick[]} */
  function makeTicks(m, day, i) {
    const a = minutesOf(m, day);
    const [o, h, l, c, volume, n] = a.subarray(i * 6, i * 6 + 6);
    const start = minuteTime(m, day, i);
    const r = stream(seed, m.def.name, 'ticks', day, i);
    const count = Math.max(4, n); // minutes always have at least 4 trades (ticksPerMinute)

    const times = Array.from({ length: count }, () => Math.floor(r.next() * MINUTE_MS)).sort((x, y) => x - y);
    times[0] = 0;

    // Price anchors: open first, close last, high and low somewhere in between.
    const highFirst = r.next() < 0.5;
    const i1 = 1 + Math.floor(r.next() * Math.max(1, count - 2));
    let i2 = 1 + Math.floor(r.next() * Math.max(1, count - 2));
    if (i2 === i1) i2 = i1 + 1 < count - 1 ? i1 + 1 : Math.max(1, i1 - 1);
    const [ia, ib] = i1 < i2 ? [i1, i2] : [i2, i1];
    /** @type {Array<[number, number]>} */
    const anchors = [[0, o], [ia, highFirst ? h : l], [ib, highFirst ? l : h], [count - 1, c]];

    const prices = new Array(count);
    for (let k = 0; k < anchors.length - 1; k += 1) {
      const [ja, pa] = anchors[k];
      const [jb, pb] = anchors[k + 1];
      for (let j = ja; j <= jb; j += 1) {
        const f = jb === ja ? 0 : (j - ja) / (jb - ja);
        const noise = (j === ja || j === jb) ? 0 : r.normal() * Math.max(1, (h - l) / 6);
        prices[j] = Math.min(h, Math.max(l, Math.round(pa + f * (pb - pa) + noise)));
      }
    }
    for (const [j, p] of anchors) prices[j] = p;

    // Split the minute's volume across the ticks; the last tick takes the remainder.
    const weights = Array.from({ length: count }, () => 0.2 + r.next());
    const total = weights.reduce((x, y) => x + y, 0);
    let left = volume;
    /** @type {Tick[]} */
    const ticks = [];
    for (let j = 0; j < count; j += 1) {
      const size = j === count - 1 ? left : Math.max(1, Math.min(left - (count - 1 - j), Math.floor(volume * weights[j] / total)));
      left -= size;
      const prevPrice = j === 0 ? o : prices[j - 1];
      const side = prices[j] > prevPrice ? 'buy' : prices[j] < prevPrice ? 'sell' : (r.next() < 0.5 ? 'buy' : 'sell');
      ticks.push({ time: start + times[j], price: prices[j], volume: size, side });
    }
    return ticks;
  }

  /**
   * Minute bar of the minute, built from its ticks up to `now` (equal to the anchor when complete).
   * @param {SymbolModel} m @param {number} day @param {number} i @param {number} now
   * @returns {Bar | null}
   */
  function minuteBar(m, day, i, now) {
    const start = minuteTime(m, day, i);
    if (start > now) return null;
    if (start + MINUTE_MS <= now) {
      // A complete minute equals its anchor (its ticks are built to match it exactly).
      const a = minutesOf(m, day);
      return { time: start, open: a[i * 6], high: a[i * 6 + 1], low: a[i * 6 + 2], close: a[i * 6 + 3], volume: a[i * 6 + 4] };
    }
    const ticks = ticksOfMinute(m, day, i).filter((t) => t.time <= now);
    return aggregateTicks(start, ticks);
  }

  // ------------------------------------------------------------------ bars

  /**
   * One trading day's bar, from its minutes up to now.
   * @param {SymbolModel} m @param {number} day @param {number} now
   * @returns {Bar | null}
   */
  function dayBar(m, day, now) {
    const session = sessionOn(m.def, day);
    if (!session || session.open > now) return null;
    const complete = session.close <= now;
    if (complete) {
      const cached = m.dayCache.get(day);
      if (cached) return cached;
    }
    if (complete) {
      const a = minutesOf(m, day);
      let high = -Infinity, low = Infinity, volume = 0;
      for (let i = 0; i < m.minutesPerDay; i += 1) {
        high = Math.max(high, a[i * 6 + 1]);
        low = Math.min(low, a[i * 6 + 2]);
        volume += a[i * 6 + 4];
      }
      const full = { time: day * DAY_MS, open: a[0], high, low, close: a[(m.minutesPerDay - 1) * 6 + 3], volume };
      m.dayCache.set(day, full);
      return full;
    }
    /** @type {Bar | null} */
    let bar = null;
    for (let i = 0; i < m.minutesPerDay; i += 1) {
      const b = minuteBar(m, day, i, now);
      if (!b) break;
      bar = bar ? merge(bar, b) : { ...b, time: day * DAY_MS };
    }
    return bar;
  }

  /**
   * Bars for a resolution, oldest first, with start times in [from, to). With countback, returns
   * the last `countback` bars that start before `to`, however far back that is.
   * Nothing after `now` is ever returned. Times are milliseconds.
   * @param {string} name @param {string} resolution
   * @param {{ from?: number, to: number, countback?: number, now: number }} range
   * @returns {Bar[]}
   */
  function bars(name, resolution, { from = 0, to, countback, now }) {
    const m = model(name);
    const { unit } = parseResolution(resolution);
    const end = Math.min(to, now + 1);
    const want = countback && countback > 0 ? countback : Infinity;
    const lowest = want === Infinity ? from : -Infinity;
    /** @type {Bar[]} */
    const out = [];

    if (unit === 'minute') {
      for (let day = dayIndexOf(end - 1); day >= HISTORY_START_DAY && out.length < want; day -= 1) {
        const session = sessionOn(m.def, day);
        if (!session || session.open >= end) continue;
        if (session.close <= lowest) break;
        /** @type {Bar[]} */
        const dayBars = [];
        for (let i = 0; i < m.minutesPerDay; i += 1) {
          const t = session.open + i * MINUTE_MS;
          if (t >= end) break;
          const b = minuteBar(m, day, i, now);
          if (!b) break;
          const start = barStart(t, resolution, session.open);
          const last = dayBars[dayBars.length - 1];
          if (last && last.time === start) dayBars[dayBars.length - 1] = merge(last, b);
          else dayBars.push({ ...b, time: start });
        }
        const keep = dayBars.filter((b) => b.time >= lowest);
        out.unshift(...keep.slice(Math.max(0, keep.length - (want - out.length))));
      }
      return out;
    }

    // Daily, weekly and monthly bars, built from day bars, newest first.
    for (let day = dayIndexOf(end - 1); day >= HISTORY_START_DAY; day -= 1) {
      if (unit === 'day' && day * DAY_MS < lowest) break;
      const b = dayBar(m, day, now);
      if (!b || b.time >= end) continue;
      const start = barStart(b.time, resolution);
      if (out[0] && out[0].time === start) { out[0] = { ...merge(b, out[0]), time: start }; continue; }
      if (out.length === want || start < lowest) break; // the bar before this one was complete
      out.unshift({ ...b, time: start });
    }
    return out;
  }

  // ------------------------------------------------------------------ live data

  /**
   * Ticks with after < time <= until, oldest first, for one symbol.
   * @param {string} name @param {number} after @param {number} until
   */
  function ticksBetween(name, after, until) {
    const m = model(name);
    /** @type {Tick[]} */
    const out = [];
    if (until <= after) return out;
    for (let t = Math.floor(after / MINUTE_MS) * MINUTE_MS; t <= until; t += MINUTE_MS) {
      const day = dayIndexOf(t);
      const session = sessionOn(m.def, day);
      if (!session || t < session.open || t >= session.close || day < HISTORY_START_DAY) continue;
      const i = Math.round((t - session.open) / MINUTE_MS);
      for (const tick of ticksOfMinute(m, day, i)) if (tick.time > after && tick.time <= until) out.push(tick);
    }
    return out;
  }

  /**
   * The last trade at or before t (from the previous session when the market is closed).
   * @param {string} name @param {number} t
   * @returns {Tick}
   */
  function lastTick(name, t) {
    const m = model(name);
    for (let day = dayIndexOf(t), n = 0; n < 10; day -= 1, n += 1) {
      const session = sessionOn(m.def, day);
      if (!session || session.open > t) continue;
      const last = Math.min(m.minutesPerDay - 1, Math.floor((Math.min(t, session.close - 1) - session.open) / MINUTE_MS));
      for (let i = last; i >= 0; i -= 1) {
        const ticks = ticksOfMinute(m, day, i).filter((k) => k.time <= t);
        if (ticks.length) return ticks[ticks.length - 1];
      }
    }
    throw new RangeError(`No trades for ${name} before ${new Date(t).toISOString()}`);
  }

  /**
   * Today's session numbers for the quote: open, high, low, last, previous close, volume.
   * "Today" is the latest session that has opened.
   * @param {string} name @param {number} t
   */
  function dayStats(name, t) {
    const m = model(name);
    let day = dayIndexOf(t);
    let bar = dayBar(m, day, t);
    while (!bar) { day -= 1; bar = dayBar(m, day, t); }
    let prev = day - 1;
    while (!isTradingDay(m.def, prev)) prev -= 1;
    const prevBar = dayBar(m, prev, t);
    return { day, open: bar.open, high: bar.high, low: bar.low, last: lastTick(name, t).price, volume: bar.volume, prevClose: prevBar ? prevBar.close : bar.open };
  }

  /**
   * The order book at time t: DEPTH_LEVELS levels each side around the last trade.
   * Sizes are stable for a price and drift every two seconds.
   * @param {string} name @param {number} t
   * @returns {Book}
   */
  function book(name, t) {
    const m = model(name);
    const last = lastTick(name, t);
    const second = Math.floor(t / 2000);
    const spread = 1 + (stream(seed, m.def.name, 'spread', second).next() < 0.15 ? 1 : 0);
    const bestAsk = last.side === 'buy' ? last.price : last.price + spread;
    const bestBid = bestAsk - spread;
    const base = m.def.sim.levelSize / m.lot;
    /** @param {number} price @param {number} k @param {string} side */
    const size = (price, k, side) => {
      const stable = Math.exp(0.6 * stream(seed, m.def.name, 'level', side, price).normal());
      const drift = Math.exp(0.35 * stream(seed, m.def.name, 'level', side, price, second).normal());
      return Math.max(1, Math.round(base * (1 + 0.12 * k) * stable * drift));
    };
    /** @type {Book} */
    const result = { bids: [], asks: [] };
    for (let k = 0; k < DEPTH_LEVELS; k += 1) {
      result.asks.push([bestAsk + k, size(bestAsk + k, k, 'ask')]);
      if (bestBid - k > 0) result.bids.push([bestBid - k, size(bestBid - k, k, 'bid')]);
    }
    return result;
  }

  // ------------------------------------------------------------------ formatting

  /** Price in ticks → decimal string. @param {string} name @param {number} ticks */
  function priceString(name, ticks) {
    const m = model(name);
    return unitsToString(ticks * Math.round(m.tick * 10 ** m.priceDecimals), m.priceDecimals);
  }

  /** Quantity in lots → decimal string. @param {string} name @param {number} lots */
  function qtyString(name, lots) {
    const m = model(name);
    return unitsToString(lots * Math.round(m.lot * 10 ** m.qtyDecimals), m.qtyDecimals);
  }

  return {
    seed,
    model,
    bars,
    ticksBetween,
    lastTick,
    dayStats,
    book,
    priceString,
    qtyString,
    /** @param {string} name @param {number} t */
    historyStart: (name, t) => {
      const m = model(name);
      for (let d = HISTORY_START_DAY; d < dayIndexOf(t) + 1; d += 1) { const s = sessionOn(m.def, d); if (s) return s.open; }
      return HISTORY_START_DAY * DAY_MS;
    },
  };
}

/** @typedef {ReturnType<typeof createMarket>} Market */

/** @param {Bar} a earlier @param {Bar} b later */
function merge(a, b) {
  return { time: a.time, open: a.open, high: Math.max(a.high, b.high), low: Math.min(a.low, b.low), close: b.close, volume: a.volume + b.volume };
}

/** @param {number} start @param {Tick[]} ticks @returns {Bar | null} */
function aggregateTicks(start, ticks) {
  if (!ticks.length) return null;
  let high = -Infinity, low = Infinity, volume = 0;
  for (const t of ticks) { high = Math.max(high, t.price); low = Math.min(low, t.price); volume += t.volume; }
  return { time: start, open: ticks[0].price, high, low, close: ticks[ticks.length - 1].price, volume };
}

/** Integer units → fixed-point string, exactly. @param {number} units @param {number} places */
function unitsToString(units, places) {
  const negative = units < 0;
  const digits = String(Math.abs(Math.round(units))).padStart(places + 1, '0');
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return negative ? `-${text}` : text;
}
