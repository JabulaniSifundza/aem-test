/**
 * The indicator registry (DECISIONS D6). Each indicator is one file: an id, a name, the pane it
 * draws in, default parameters and a pure compute(bars, params) function. Add one by adding a file
 * and a line below; the chart and its menu pick it up.
 *
 * Every compute is a single pass, O(n) in bars: SMA and Bollinger use rolling window sums, EMA,
 * RSI (Wilder) and MACD are recursive, VWAP accumulates per day. The volume profile is
 * O(n · rows) because a bar's volume is spread over the price rows it spans (rows defaults to 40).
 * The chart recomputes indicators when bars load and when the live bar changes.
 */
import sma from './sma.js';
import ema from './ema.js';
import vwap from './vwap.js';
import bollinger from './bollinger.js';
import rsi from './rsi.js';
import macd from './macd.js';
import volumeProfile from './volume-profile.js';

/** @typedef {{ time: number, open: number, high: number, low: number, close: number, volume: number }} Bar */
/**
 * @typedef {object} Indicator
 * @property {string} id
 * @property {string} name
 * @property {'price' | 'oscillator' | 'profile'} pane
 * @property {Record<string, number>} defaults
 * @property {[number, number]} [range]
 * @property {number[]} [levels]
 * @property {(bars: Bar[], params: any) => { lines: Array<{ name: string, values: Array<number | null> }>, histogram?: { name: string, values: Array<number | null> }, profile?: any }} compute
 */

/** @type {Indicator[]} */
export const INDICATORS = [sma, ema, vwap, bollinger, rsi, macd, volumeProfile];

/** @param {string} id */
export const getIndicator = (id) => INDICATORS.find((i) => i.id === id);
