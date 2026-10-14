/**
 * Bollinger Bands: a moving average with bands k standard deviations away (population standard
 * deviation, as most charting packages use).
 *
 * O(n): one pass with a rolling sum and sum of squares, adding the bar entering the window and
 * removing the one leaving it (recomputing each window would be O(n·length)). The sums are taken
 * about the first close (shift), so squares stay small and the variance keeps its precision at
 * prices like 60,000; without the shift, sumSq/n − mean² would cancel away most of the digits.
 * An exact re-sum every `length` bars keeps rounding from accumulating (still O(n) overall).
 */
/** @type {import('./index.js').Indicator} */
export default {
  id: 'bollinger', name: 'Bollinger Bands', pane: 'price', defaults: { length: 20, k: 2 },
  /** @param {import('./index.js').Bar[]} bars @param {{ length: number, k: number }} p */
  compute(bars, { length, k }) {
    const n = bars.length;
    const mid = new Array(n).fill(null), up = new Array(n).fill(null), lo = new Array(n).fill(null);
    if (!n || length < 1) return { lines: [{ name: `BB ${length} upper`, values: up }, { name: `BB ${length}`, values: mid }, { name: `BB ${length} lower`, values: lo }] };
    const shift = bars[0].close;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) {
      const x = bars[i].close - shift;
      sum += x;
      sumSq += x * x;
      if (i >= length) {
        const y = bars[i - length].close - shift;
        sum -= y;
        sumSq -= y * y;
      }
      if (i < length - 1) continue;
      if (i % length === 0) {
        // Re-sum the window exactly once every `length` bars, so rounding from the adds and
        // removes can't build up over a long series. O(length) every length bars: O(1) amortised.
        sum = 0;
        sumSq = 0;
        for (let j = i - length + 1; j <= i; j += 1) { const z = bars[j].close - shift; sum += z; sumSq += z * z; }
      }
      const mean = sum / length;
      const sd = Math.sqrt(Math.max(0, sumSq / length - mean * mean)); // max: rounding can dip below 0
      mid[i] = mean + shift; up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
    }
    return { lines: [{ name: `BB ${length} upper`, values: up }, { name: `BB ${length}`, values: mid }, { name: `BB ${length} lower`, values: lo }] };
  },
};
