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
 *
 * Caches (all per symbol, all bounded): daily log closes (grow once to "today", then O(1)),
 * minute anchors and their running day totals for DAY_CACHE_SIZE days, ticks for the most
 * recent TICK_CACHE_SIZE minutes, finished day bars, and the last order book computed.
 *
 * Complexity (M = minutes in a session, K = ticks in a minute, B = bars returned, L = depth levels):
 *   bars(minute resolutions)   O(M per day visited + B)      days are generated once and cached
 *   bars(day/week/month)       O(days visited)               finished days are cached
 *   ticksBetween(a, b)         O(minutes in (a, b] + ticks returned)
 *   lastTick(t)                O(K)
 *   dayStats(t)                O(K)                           running totals, not a loop over M
 *   book(t)                    O(L), O(1) when asked again for the same instant
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
/** Minutes whose ticks are kept in memory. */
const TICK_CACHE_SIZE = 256;

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
 * @property {Map<number, DayTotals>} totalsCache        day → running high, low and volume per minute
 * @property {Map<number, Bar>} dayCache                  full days only
 * @property {Map<number, Tick[]>} tickCache             recent minutes' ticks
 * @property {{ key: string, book: Book } | null} lastBook the last book computed (books are asked for
 *           several times per instant: matching, the depth stream, quotes)
 */

/**
 * Running totals over a day's minutes: entry i covers minutes 0..i, so the bar of the first k
 * minutes is read in O(1) instead of merging k minute bars.
 * @typedef {{ high: Float64Array, low: Float64Array, volume: Float64Array }} DayTotals
 */

/**
 * Put a value in a bounded cache, evicting the oldest entry (insertion order) when full.
 * @template K, V @param {Map<K, V>} cache @param {K} key @param {V} value @param {number} limit
 */
function remember(cache, key, value, limit) {
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(/** @type {K} */ (oldest));
  }
  return value;
}

/**
 * @param {{ seed?: string }} [options]
 */
export function createMarket({ seed = 'trading-sim' } = {}) {
  /** @type {Map<string, SymbolModel>} */
  const models = new Map();

  /** The symbol's model, created on first use. O(1). @param {string} name */
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
      totalsCache: new Map(),
      dayCache: new Map(),
      tickCache: new Map(),
      lastBook: null,
    };
    models.set(def.name, m);
    return m;
  }

  // ------------------------------------------------------------------ daily closes

  /**
   * Log close of a day: L(d) = L(d-1) + σ·z − κ·(L(d-1) − anchor), on trading days only.
   * κ is chosen so prices typically stay within PRICE_RANGE of the anchor.
   * Each day depends on the one before, so the series is extended up to `day` once and kept:
   * O(days since the last call), then O(1). About a thousand numbers per symbol.
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
      // Volatility regimes of 20 days make calm and busy periods, like real markets.
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
   * O(M) to build, then cached (least recently used goes first). A typed array keeps a 24-hour
   * day at 69 KB and avoids 1,440 small objects.
   * @param {SymbolModel} m @param {number} day
   */
  function minutesOf(m, day) {
    const cached = m.minuteCache.get(day);
    if (cached) { m.minuteCache.delete(day); m.minuteCache.set(day, cached); return cached; } // refresh LRU position

    const n = m.minutesPerDay;
    const close = closeLog(m, day);
    let prev = day - 1;
    while (prev > HISTORY_START_DAY && !isTradingDay(m.def, prev)) prev -= 1;
    const prevClose = day > HISTORY_START_DAY ? closeLog(m, prev) : close;
    const crypto = m.def.sessionKind === '24x7';
    const openLog = crypto ? prevClose : prevClose + GAP_SHARE * (close - prevClose)
      + 0.15 * m.dailyVol * stream(seed, m.def.name, 'gap', day).normal();

    // Brownian bridge from openLog to close over n minutes: a random walk with its end pinned,
    // walk[i] − f·walk[n] goes from 0 to 0, and the drift term carries the open to the close.
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
      const wick = sigma * Math.exp(log) / m.tick * 0.8; // wicks scale with one minute's volatility, in ticks
      const h = Math.max(o, c) + Math.floor(Math.abs(r.normal()) * wick);
      const l = Math.max(1, Math.min(o, c) - Math.floor(Math.abs(r.normal()) * wick));
      const trades = r.int(tMin, tMax);
      const x = i / (n - 1);
      const shape = crypto ? 1 : 0.6 + 1.6 * (2 * x - 1) ** 2; // U-shaped day for stocks
      const volume = Math.max(trades, Math.round(lotsPerMinute * shape * Math.exp(0.5 * r.normal() - 0.125)));
      out.set([o, h, l, c, volume, trades], i * 6);
      prevTicks = c;
    }
    return remember(m.minuteCache, day, out, DAY_CACHE_SIZE);
  }

  /** Running high/low/volume over a day's minutes. O(M) once per day, cached. @param {SymbolModel} m @param {number} day */
  function totalsOf(m, day) {
    const cached = m.totalsCache.get(day);
    if (cached) return cached;
    const a = minutesOf(m, day);
    const n = m.minutesPerDay;
    const totals = { high: new Float64Array(n), low: new Float64Array(n), volume: new Float64Array(n) };
    let high = -Infinity, low = Infinity, volume = 0;
    for (let i = 0; i < n; i += 1) {
      high = Math.max(high, a[i * 6 + 1]);
      low = Math.min(low, a[i * 6 + 2]);
      volume += a[i * 6 + 4];
      totals.high[i] = high;
      totals.low[i] = low;
      totals.volume[i] = volume;
    }
    return remember(m.totalsCache, day, totals, DAY_CACHE_SIZE);
  }

  /**
   * The ticks inside one minute, in time order. O(K) to build, then cached. Callers must not
   * change the array (it is shared).
   * @param {SymbolModel} m @param {number} day @param {number} i
   * @returns {Tick[]}
   */
  function ticksOfMinute(m, day, i) {
    const key = day * 1440 + i;
    return m.tickCache.get(key) ?? remember(m.tickCache, key, makeTicks(m, day, i), TICK_CACHE_SIZE);
  }

  /**
   * Generate one minute's ticks so they reproduce its anchor exactly: first at the open, last at
   * the close, the high and the low each touched once, volumes summing to the minute's volume.
   * O(K log K) for the sorted times.
   * @param {SymbolModel} m @param {number} day @param {number} i @returns {Tick[]}
   */
  function makeTicks(m, day, i) {
    const a = minutesOf(m, day);
    const [o, h, l, c, volume, n] = a.subarray(i * 6, i * 6 + 6);
    const start = minuteTime(m, day, i);
    const r = stream(seed, m.def.name, 'ticks', day, i);
    const count = Math.max(4, n); // minutes always have at least 4 trades (ticksPerMinute)

    const times = Array.from({ length: count }, () => Math.floor(r.next() * MINUTE_MS)).sort((x, y) => x - y);
    times[0] = 0;

    // Price anchors: open first, close last, high and low somewhere in between. Prices between
    // anchors are a noisy straight line, clamped to [low, high] so no tick breaks the bar.
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
    // The minute in progress: only the ticks that have happened.
    const ticks = ticksOfMinute(m, day, i).filter((t) => t.time <= now);
    return aggregateTicks(start, ticks);
  }

  // ------------------------------------------------------------------ bars

  /**
   * One trading day's bar up to now: the finished minutes from the running totals (O(1)), plus
   * the minute in progress from its ticks (O(K)). Finished days are cached for good.
   * This runs for every quote push, so it must not loop over the day's minutes.
   * @param {SymbolModel} m @param {number} day @param {number} now
   * @returns {Bar | null}
   */
  function dayBar(m, day, now) {
    const session = sessionOn(m.def, day);
    if (!session || session.open > now) return null;
    // Only a finished session may come from the cache: the same day asked for at an earlier
    // `now` (a chart replaying history) is still in progress.
    const finished = session.close <= now;
    const cached = finished ? m.dayCache.get(day) : undefined;
    if (cached) return cached;
    const a = minutesOf(m, day);
    const totals = totalsOf(m, day);
    const n = m.minutesPerDay;
    const done = Math.min(n, Math.floor((now - session.open) / MINUTE_MS)); // finished minutes
    /** @type {Bar | null} */
    let bar = done > 0 ? {
      time: day * DAY_MS, open: a[0], high: totals.high[done - 1], low: totals.low[done - 1],
      close: a[(done - 1) * 6 + 3], volume: totals.volume[done - 1],
    } : null;
    if (done === n) {
      if (finished && bar) m.dayCache.set(day, bar); // bounded by the days of history
      return bar;
    }
    const current = minuteBar(m, day, done, now);
    if (current) bar = bar ? merge(bar, current) : { ...current, time: day * DAY_MS };
    return bar;
  }

  /**
   * Bars for a resolution, oldest first, with start times in [from, to). With countback, returns
   * the last `countback` bars that start before `to`, however far back that is.
   * Nothing after `now` is ever returned. Times are milliseconds.
   *
   * Walks back from `to` one day at a time and collects newest first, so a countback request
   * stops as soon as it has enough bars; the result is reversed once at the end (building it
   * with unshift would copy the array on every step: O(B²)).
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

    if (unit === 'minute') {
      /** @type {Bar[][]} one chunk per day, newest day first */
      const days = [];
      let count = 0;
      for (let day = dayIndexOf(end - 1); day >= HISTORY_START_DAY && count < want; day -= 1) {
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
        const chunk = keep.slice(Math.max(0, keep.length - (want - count)));
        days.push(chunk);
        count += chunk.length;
      }
      return days.reverse().flat();
    }

    // Daily, weekly and monthly bars, built from day bars. `rev` is newest first; its last
    // entry is the earliest bar so far, which the next (older) day may extend.
    /** @type {Bar[]} */
    const rev = [];
    for (let day = dayIndexOf(end - 1); day >= HISTORY_START_DAY; day -= 1) {
      if (unit === 'day' && day * DAY_MS < lowest) break;
      const b = dayBar(m, day, now);
      if (!b || b.time >= end) continue;
      const start = barStart(b.time, resolution);
      const earliest = rev[rev.length - 1];
      if (earliest && earliest.time === start) { rev[rev.length - 1] = { ...merge(b, earliest), time: start }; continue; }
      if (rev.length === want || start < lowest) break; // the bar before this one was complete
      rev.push({ ...b, time: start });
    }
    return rev.reverse();
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
      // Only the first and last minutes are partial; the filter is cheap for the ones between.
      for (const tick of ticksOfMinute(m, day, i)) if (tick.time > after && tick.time <= until) out.push(tick);
    }
    return out;
  }

  /**
   * The last trade at or before t (from the previous session when the market is closed).
   * Called for every mark price, quote and book, so it scans one minute's ticks backwards
   * without allocating. O(K); a minute always has a tick at its first millisecond, so at most
   * two minutes are looked at.
   * @param {string} name @param {number} t
   * @returns {Tick}
   */
  function lastTick(name, t) {
    const m = model(name);
    // Ten days back covers the longest market closure (a long weekend plus holidays).
    for (let day = dayIndexOf(t), n = 0; n < 10; day -= 1, n += 1) {
      const session = sessionOn(m.def, day);
      if (!session || session.open > t) continue;
      const last = Math.min(m.minutesPerDay - 1, Math.floor((Math.min(t, session.close - 1) - session.open) / MINUTE_MS));
      for (let i = last; i >= 0; i -= 1) {
        const ticks = ticksOfMinute(m, day, i);
        for (let k = ticks.length - 1; k >= 0; k -= 1) if (ticks[k].time <= t) return ticks[k];
      }
    }
    throw new RangeError(`No trades for ${name} before ${new Date(t).toISOString()}`);
  }

  /**
   * Today's session numbers for the quote: open, high, low, last, previous close, volume.
   * "Today" is the latest session that has opened. O(K) (see dayBar).
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
   *
   * The book depends only on the last trade and the two-second window, so the last result is
   * kept and returned again for the same pair: matching, the depth stream and quotes all ask
   * for the same instant. The result is shared: treat it as read-only. O(L), or O(K) on a hit.
   * @param {string} name @param {number} t
   * @returns {Book}
   */
  function book(name, t) {
    const m = model(name);
    const last = lastTick(name, t);
    const second = Math.floor(t / 2000);
    const key = `${second}:${last.time}:${last.price}`;
    if (m.lastBook?.key === key) return m.lastBook.book;
    const spread = 1 + (stream(seed, m.def.name, 'spread', second).next() < 0.15 ? 1 : 0);
    const bestAsk = last.side === 'buy' ? last.price : last.price + spread;
    const bestBid = bestAsk - spread;
    const base = m.def.sim.levelSize / m.lot;
    // A level's size = base × depth factor × a lasting size for that price × a drift that
    // changes every two seconds, so the ladder looks alive without flickering.
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
    m.lastBook = { key, book: result };
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
    /** Start of the first session in history (charts stop asking for older bars there). @param {string} name @param {number} t */
    historyStart: (name, t) => {
      const m = model(name);
      for (let d = HISTORY_START_DAY; d < dayIndexOf(t) + 1; d += 1) { const s = sessionOn(m.def, d); if (s) return s.open; }
      return HISTORY_START_DAY * DAY_MS;
    },
  };
}

/** @typedef {ReturnType<typeof createMarket>} Market */

/** Combine two consecutive bars into one. @param {Bar} a earlier @param {Bar} b later */
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

/**
 * Integer units → fixed-point string, exactly (no floating-point formatting: 1234 units at 2
 * places is "12.34"). @param {number} units @param {number} places
 */
function unitsToString(units, places) {
  const negative = units < 0;
  const digits = String(Math.abs(Math.round(units))).padStart(places + 1, '0');
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return negative ? `-${text}` : text;
}
