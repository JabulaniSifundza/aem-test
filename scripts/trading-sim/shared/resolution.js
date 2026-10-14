/**
 * Chart resolutions (spec §3: 1, 5, 15, 30, 60, 240, 1D, 1W, 1M) and bar boundaries.
 *
 * The spec's _resolutionToMs reads "1M" as one minute and treats months as fixed lengths
 * (requirement M-8). Here months and weeks are calendar periods, and intraday bars can be
 * anchored to a session open, so a stock's 60-minute bars start at 09:30, 10:30 and so on.
 * Daily, weekly and monthly bars are stamped at 00:00 UTC, as the TradingView datafeed expects.
 */

export const RESOLUTIONS = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'];
export const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** @typedef {{ unit: 'minute' | 'day' | 'week' | 'month', count: number }} ParsedResolution */

/**
 * Parse a resolution string. Accepts the TradingView forms "D", "1D", "W", "1W", "M", "1M",
 * and minute counts such as "5" or "240".
 * @param {string} resolution
 * @returns {ParsedResolution}
 */
export function parseResolution(resolution) {
  const match = /^(\d*)([DWMS]?)$/i.exec(String(resolution).trim());
  if (!match) throw new RangeError(`Unknown resolution: ${resolution}`);
  const count = match[1] === '' ? 1 : Number(match[1]);
  const unit = match[2].toUpperCase();
  if (!(count > 0)) throw new RangeError(`Unknown resolution: ${resolution}`);
  if (unit === '') return { unit: 'minute', count };
  if (unit === 'D') return { unit: 'day', count };
  if (unit === 'W') return { unit: 'week', count };
  if (unit === 'M') return { unit: 'month', count };
  throw new RangeError(`Seconds resolutions are not supported: ${resolution}`);
}

/**
 * The canonical spelling ("D" → "1D").
 * @param {string} resolution
 */
export function normalizeResolution(resolution) {
  const { unit, count } = parseResolution(resolution);
  return unit === 'minute' ? String(count) : `${count}${unit[0].toUpperCase()}`;
}

/** @param {string} resolution */
export function isSupported(resolution) {
  try { return RESOLUTIONS.includes(normalizeResolution(resolution)); } catch { return false; }
}

/** @param {string} resolution */
export const isIntraday = (resolution) => parseResolution(resolution).unit === 'minute';

/**
 * Fixed length in milliseconds of a minute, day or week resolution. Months have no fixed
 * length, so asking for one throws: use barStart and nextBarStart instead.
 * @param {string} resolution
 */
export function resolutionToMs(resolution) {
  const { unit, count } = parseResolution(resolution);
  if (unit === 'minute') return count * MINUTE_MS;
  if (unit === 'day') return count * DAY_MS;
  if (unit === 'week') return count * 7 * DAY_MS;
  throw new RangeError('Months have no fixed length; use barStart/nextBarStart');
}

/**
 * Start time of the bar that contains t.
 * @param {number} t
 * @param {string} resolution
 * @param {number} [anchor] for intraday bars: the session open they are counted from (default 00:00 UTC of t's day)
 */
export function barStart(t, resolution, anchor) {
  const { unit, count } = parseResolution(resolution);
  if (unit === 'minute') {
    const size = count * MINUTE_MS;
    const base = anchor ?? Math.floor(t / DAY_MS) * DAY_MS;
    return base + Math.floor((t - base) / size) * size;
  }
  const day = Math.floor(t / DAY_MS);
  if (unit === 'day') return Math.floor(day / count) * count * DAY_MS;
  if (unit === 'week') {
    const monday = day - ((day + 3) % 7); // 1970-01-05 was a Monday
    return monday * DAY_MS;
  }
  const date = new Date(t);
  const months = date.getUTCFullYear() * 12 + date.getUTCMonth();
  const first = Math.floor(months / count) * count;
  return Date.UTC(Math.floor(first / 12), first % 12, 1);
}

/**
 * Start time of the bar after the one starting at `start`.
 * @param {number} start
 * @param {string} resolution
 */
export function nextBarStart(start, resolution) {
  const { unit, count } = parseResolution(resolution);
  if (unit !== 'month') return start + resolutionToMs(resolution);
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1);
}
