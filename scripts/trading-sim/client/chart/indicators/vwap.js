/** Volume-weighted average price, restarting each UTC day (each session for stocks). */
/** @type {import('./index.js').Indicator} */
export default {
  id: 'vwap', name: 'VWAP', pane: 'price', defaults: {},
  /** @param {import('./index.js').Bar[]} bars */
  compute(bars) {
    const out = new Array(bars.length).fill(null);
    let day = -1, pv = 0, vol = 0;
    for (let i = 0; i < bars.length; i += 1) {
      const b = bars[i];
      const d = Math.floor(b.time / 86_400_000);
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const typical = (b.high + b.low + b.close) / 3;
      pv += typical * b.volume; vol += b.volume;
      out[i] = vol ? pv / vol : null;
    }
    return { lines: [{ name: 'VWAP', values: out }] };
  },
};
