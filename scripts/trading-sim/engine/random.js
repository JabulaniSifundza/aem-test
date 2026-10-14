/**
 * Seeded random numbers, so the simulated market is the same every time for the same seed:
 * the chart's history never changes when you reload, and tests are repeatable.
 */

/**
 * A 32-bit hash of any number of strings and integers (FNV-1a, then mixed).
 * @param {...(string | number)} parts
 */
export function hash(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x7c; // separator
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * A small, fast generator (mulberry32). Returns numbers in [0, 1).
 * @param {number} seed
 */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A generator seeded from parts, with helpers.
 * @param {...(string | number)} parts
 */
export function stream(...parts) {
  const next = rng(hash(...parts));
  /** @type {number | null} */
  let spare = null;
  return {
    next,
    /** Standard normal (Box–Muller). */
    normal() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    /** Integer in [lo, hi]. @param {number} lo @param {number} hi */
    int(lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); },
  };
}
