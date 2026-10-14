import { ema } from './ema.js';

/** MACD: fast EMA minus slow EMA, its signal line and the histogram, in its own pane. */
/** @type {import('./index.js').Indicator} */
export default {
  id: 'macd', name: 'MACD', pane: 'oscillator', defaults: { fast: 12, slow: 26, signal: 9 }, levels: [0],
  /** @param {import('./index.js').Bar[]} bars @param {{ fast: number, slow: number, signal: number }} p */
  compute(bars, { fast, slow, signal }) {
    const closes = bars.map((b) => b.close);
    const f = ema(closes, fast), s = ema(closes, slow);
    const macd = closes.map((_, i) => (f[i] === null || s[i] === null ? null : /** @type {number} */ (f[i]) - /** @type {number} */ (s[i])));
    const sig = ema(macd, signal);
    const hist = macd.map((m, i) => (m === null || sig[i] === null ? null : m - /** @type {number} */ (sig[i])));
    return { lines: [{ name: 'MACD', values: macd }, { name: 'Signal', values: sig }], histogram: { name: 'Histogram', values: hist } };
  },
};
