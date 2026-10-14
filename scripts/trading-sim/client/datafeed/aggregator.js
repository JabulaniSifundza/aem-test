/**
 * Builds the live bar from ticks (spec §3, requirement M-7): a tick inside the current bar updates
 * its high, low, close and volume; a tick past the bar's end starts a new bar. Intraday bars of
 * stocks are counted from the session open, like the bars from /history.
 */
import { barStart, isIntraday } from '../../shared/resolution.js';
import { getSymbol, sessionAt, lastSession } from '../../shared/symbols.js';

/** @typedef {{ time: number, open: number, high: number, low: number, close: number, volume: number }} ChartBar */
/** @typedef {{ price: number, volume: number, timestamp: number }} ChartTick */

/**
 * @param {string} symbol
 * @param {string} resolution
 * @param {ChartBar | null} lastBar  the newest bar from getBars, if any
 */
export function createBarAggregator(symbol, resolution, lastBar) {
  const def = getSymbol(symbol);
  const intraday = isIntraday(resolution);
  /** @type {ChartBar | null} */
  let bar = lastBar ? { ...lastBar } : null;

  /** @param {number} t */
  function startOf(t) {
    if (!intraday) return barStart(t, resolution);
    const session = def ? (sessionAt(def, t) ?? lastSession(def, t)) : null;
    return barStart(t, resolution, session ? session.open : undefined);
  }

  return {
    /**
     * Apply a tick; returns the bar to send to the chart, or null for a tick older than the bar.
     * @param {ChartTick} tick
     * @returns {ChartBar | null}
     */
    update(tick) {
      const start = startOf(tick.timestamp);
      if (bar && start < bar.time) return null;
      if (!bar || start > bar.time) {
        bar = { time: start, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: tick.volume };
      } else {
        bar = {
          ...bar, high: Math.max(bar.high, tick.price), low: Math.min(bar.low, tick.price),
          close: tick.price, volume: round(bar.volume + tick.volume),
        };
      }
      return { ...bar };
    },
    current: () => (bar ? { ...bar } : null),
  };
}

/** Keeps sums of decimal volumes tidy (0.1 + 0.2). Display only; money never comes here. @param {number} n */
const round = (n) => Math.round(n * 1e8) / 1e8;
