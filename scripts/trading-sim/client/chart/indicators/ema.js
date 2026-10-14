/** Exponential moving average of closes. */
export function ema(/** @type {Array<number | null>} */ values, /** @type {number} */ length) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (length + 1);
  let prev = null;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === null) continue;
    if (prev === null) {
      seed += v; count += 1;
      if (count === length) { prev = seed / length; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** @type {import('./index.js').Indicator} */
export default {
  id: 'ema', name: 'Exponential moving average', pane: 'price', defaults: { length: 50 },
  /** @param {import('./index.js').Bar[]} bars @param {{ length: number }} p */
  compute(bars, { length }) {
    return { lines: [{ name: `EMA ${length}`, values: ema(bars.map((b) => b.close), length) }] };
  },
};
