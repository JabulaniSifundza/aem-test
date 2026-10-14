/** Bollinger Bands: a moving average with bands k standard deviations away. */
/** @type {import('./index.js').Indicator} */
export default {
  id: 'bollinger', name: 'Bollinger Bands', pane: 'price', defaults: { length: 20, k: 2 },
  /** @param {import('./index.js').Bar[]} bars @param {{ length: number, k: number }} p */
  compute(bars, { length, k }) {
    const mid = new Array(bars.length).fill(null), up = new Array(bars.length).fill(null), lo = new Array(bars.length).fill(null);
    for (let i = length - 1; i < bars.length; i += 1) {
      let sum = 0;
      for (let j = i - length + 1; j <= i; j += 1) sum += bars[j].close;
      const mean = sum / length;
      let sq = 0;
      for (let j = i - length + 1; j <= i; j += 1) sq += (bars[j].close - mean) ** 2;
      const sd = Math.sqrt(sq / length);
      mid[i] = mean; up[i] = mean + k * sd; lo[i] = mean - k * sd;
    }
    return { lines: [{ name: `BB ${length} upper`, values: up }, { name: `BB ${length}`, values: mid }, { name: `BB ${length} lower`, values: lo }] };
  },
};
