/** Relative strength index (Wilder's smoothing), in its own pane from 0 to 100. */
/** @type {import('./index.js').Indicator} */
export default {
  id: 'rsi', name: 'RSI', pane: 'oscillator', defaults: { length: 14 }, range: [0, 100], levels: [30, 70],
  /** @param {import('./index.js').Bar[]} bars @param {{ length: number }} p */
  compute(bars, { length }) {
    const out = new Array(bars.length).fill(null);
    let gain = 0, loss = 0;
    for (let i = 1; i < bars.length; i += 1) {
      const ch = bars[i].close - bars[i - 1].close;
      const g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= length) { gain += g; loss += l; if (i === length) { gain /= length; loss /= length; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); } continue; }
      gain = (gain * (length - 1) + g) / length;
      loss = (loss * (length - 1) + l) / length;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return { lines: [{ name: `RSI ${length}`, values: out }] };
  },
};
