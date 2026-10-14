/**
 * Chart arithmetic shared by every adapter: nice axis steps, time labels, and the mapping between
 * bar times and the bar-index x axis. Pure functions, unit-tested. Display only: nothing here
 * touches money.
 */

/**
 * Round tick values covering [min, max] with about `count` steps of 1, 2, 2.5 or 5 × 10^n.
 * @param {number} min @param {number} max @param {number} count
 * @returns {number[]}
 */
export function niceTicks(min, max, count) {
  if (!(max > min) || !(count > 0)) return Number.isFinite(min) ? [min] : [];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/**
 * Ticks for a log scale: nice steps chosen in log space, rounded to two significant figures, so a
 * narrow range still gets several labels.
 * @param {number} min @param {number} max @param {number} count
 */
export function logTicks(min, max, count) {
  if (!(min > 0) || !(max > min)) return niceTicks(min, max, count);
  const lo = Math.log(min), hi = Math.log(max);
  const seen = new Set();
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i <= count; i += 1) {
    const v = Math.exp(lo + ((hi - lo) * i) / count);
    const p = 10 ** (Math.floor(Math.log10(v)) - 1);
    const r = Number((Math.round(v / p) * p).toPrecision(12));
    if (r >= min && r <= max && !seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

/**
 * The index of the bar at or before `time` (ms); fractional beyond either end, so drawings
 * anchored past the last bar keep their place as new bars arrive.
 * @param {Array<{ time: number }>} bars @param {number} time
 */
export function indexOfTime(bars, time) {
  const n = bars.length;
  if (!n) return 0;
  if (n === 1) return 0;
  if (time <= bars[0].time) return (time - bars[0].time) / (bars[1].time - bars[0].time);
  if (time >= bars[n - 1].time) return n - 1 + (time - bars[n - 1].time) / (bars[n - 1].time - bars[n - 2].time);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= time) lo = mid; else hi = mid;
  }
  return lo + (time - bars[lo].time) / (bars[hi].time - bars[lo].time);
}

/**
 * The time (ms) at a possibly fractional bar index; the inverse of indexOfTime.
 * @param {Array<{ time: number }>} bars @param {number} index
 */
export function timeOfIndex(bars, index) {
  const n = bars.length;
  if (!n) return 0;
  if (n === 1) return bars[0].time;
  if (index <= 0) return bars[0].time + index * (bars[1].time - bars[0].time);
  if (index >= n - 1) return bars[n - 1].time + (index - (n - 1)) * (bars[n - 1].time - bars[n - 2].time);
  const i = Math.floor(index);
  return bars[i].time + (index - i) * (bars[i + 1].time - bars[i].time);
}

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @typedef {'UTC' | 'local' | string} TimeZone  'UTC', the browser's zone, or an IANA name */

/** @type {Map<string, Intl.DateTimeFormat>} */
const zoneFormats = new Map();
/**
 * Calendar fields of a time in a time zone.
 * @param {number} time @param {TimeZone} tz
 */
export function zoned(time, tz) {
  let f = zoneFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz === 'local' ? undefined : tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    zoneFormats.set(tz, f);
  }
  /** @type {Record<string, number>} */
  const v = {};
  for (const part of f.formatToParts(new Date(time))) if (part.type !== 'literal') v[part.type] = Number(part.value);
  return { year: v.year, month: v.month - 1, day: v.day, hour: v.hour % 24, minute: v.minute };
}

/**
 * An axis label for a bar time. Intraday labels show the clock and switch to the date at
 * midnight; daily labels show the day and switch to the month, then the year.
 * Daily and longer bars are stamped at 00:00 UTC, so they are always read in UTC.
 * @param {number} time ms @param {number | null} prev the previous label's time @param {boolean} intraday
 * @param {TimeZone} [tz] for intraday bars (the spec's default is UTC, P-1)
 */
export function timeLabel(time, prev, intraday, tz = 'UTC') {
  const d = zoned(time, intraday ? tz : 'UTC');
  const p = prev === null ? null : zoned(prev, intraday ? tz : 'UTC');
  if (intraday) {
    if (p && (p.day !== d.day || p.month !== d.month || p.year !== d.year)) return `${d.day} ${MONTHS[d.month]}`;
    return `${pad(d.hour)}:${pad(d.minute)}`;
  }
  if (p && p.year !== d.year) return String(d.year);
  if (p && p.month !== d.month) return MONTHS[d.month];
  return `${d.day} ${MONTHS[d.month]}`;
}

/** A full time for the crosshair label. @param {number} time @param {boolean} intraday @param {TimeZone} [tz] */
export function timeFull(time, intraday, tz = 'UTC') {
  const d = zoned(time, intraday ? tz : 'UTC');
  const date = `${d.day} ${MONTHS[d.month]} ${d.year}`;
  return intraday ? `${date} ${pad(d.hour)}:${pad(d.minute)}` : date;
}

/**
 * The price range of bars from index a to b (inclusive), padded by 8% top and bottom.
 * @param {Array<{ high: number, low: number }>} bars @param {number} a @param {number} b
 * @param {number[]} [extra] other values that must stay visible (indicator lines)
 * @returns {[number, number] | null}
 */
export function visibleRange(bars, a, b, extra = []) {
  let lo = Infinity, hi = -Infinity;
  const from = Math.max(0, Math.floor(a)), to = Math.min(bars.length - 1, Math.ceil(b));
  for (let i = from; i <= to; i += 1) { lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high); }
  for (const v of extra) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!Number.isFinite(lo)) return null;
  const span = hi - lo || Math.abs(hi) * 0.01 || 1;
  return [lo - span * 0.08, hi + span * 0.08];
}

/**
 * Heikin-Ashi bars from ordinary bars (a chart type in the simulator's style menu).
 * @template {{ time: number, open: number, high: number, low: number, close: number, volume: number }} B
 * @param {B[]} bars
 * @returns {B[]}
 */
export function heikinAshi(bars) {
  /** @type {B[]} */
  const out = [];
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ ...b, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) });
  }
  return out;
}
