/**
 * Volume profile (VPVR): volume traded at each price over the visible range, drawn as horizontal
 * bars on the price axis. Uses the finer bars from getVolumeProfileResolutionBars when available.
 */
/** @type {import('./index.js').Indicator} */
export default {
  id: 'volume-profile', name: 'Volume profile', pane: 'profile', defaults: { rows: 40 },
  /**
   * @param {import('./index.js').Bar[]} bars @param {{ rows: number }} p
   * @returns {{ lines: [], profile: { low: number, step: number, volumes: number[], poc: number } | null }}
   */
  compute(bars, { rows }) {
    if (!bars.length) return { lines: [], profile: null };
    let low = Infinity, high = -Infinity;
    for (const b of bars) { low = Math.min(low, b.low); high = Math.max(high, b.high); }
    const step = (high - low) / rows || 1;
    const volumes = new Array(rows).fill(0);
    for (const b of bars) {
      // Spread each bar's volume evenly over the rows its range covers.
      const a = Math.min(rows - 1, Math.floor((b.low - low) / step));
      const z = Math.min(rows - 1, Math.floor((b.high - low) / step));
      const share = b.volume / (z - a + 1);
      for (let r = a; r <= z; r += 1) volumes[r] += share;
    }
    const poc = volumes.indexOf(Math.max(...volumes));
    return { lines: [], profile: { low, step, volumes, poc } };
  },
};
