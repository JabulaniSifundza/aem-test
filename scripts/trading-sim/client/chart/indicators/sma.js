/** Simple moving average of closes. */
/** @type {import('./index.js').Indicator} */
export default {
  id: 'sma', name: 'Moving average', pane: 'price', defaults: { length: 20 },
  /** @param {import('./index.js').Bar[]} bars @param {{ length: number }} p */
  compute(bars, { length }) {
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i += 1) {
      sum += bars[i].close;
      if (i >= length) sum -= bars[i - length].close;
      if (i >= length - 1) out[i] = sum / length;
    }
    return { lines: [{ name: `MA ${length}`, values: out }] };
  },
};
