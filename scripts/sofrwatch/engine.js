/*
 * SOFRWatch engine. Implements the published CME SOFRWatch methodology
 * ("CME SOFRWatch Tool Methodology"):
 *   - the spread between the lower bound of the Fed's target range and overnight SOFR is held
 *     constant: implied O/N SOFR = lower bound + (EFFR - lower bound) + (SOFR - EFFR, 3-month
 *     average) + the user's policy changes;
 *   - a policy change applies from the day after the FOMC decision;
 *   - Three-Month SOFR (SR3) settles on daily compounded SOFR over its reference quarter
 *     (third Wednesday to third Wednesday of the IMM months): price = 100 - rate;
 *   - One-Month SOFR (SR1) settles on the arithmetic average of daily SOFR over its month;
 *   - contracts already in their reference period mix actual and implied fixings.
 * SOFR is published for business days; a non-business day uses the previous business day's
 * rate (calendar-day compounding / averaging). Weekends are modelled; exchange and US
 * government securities market holidays are not.
 * The same mechanics serve €STRWatch (Three-Month €STR futures, ESR): there the spread is to the
 * ECB deposit facility rate and a change applies from the start of the next reserve maintenance
 * period (pass `effective` on each move).
 * Pure functions, no DOM.
 */

const DAY = 864e5;
export const toUtc = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
export const toIso = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso, n) => toIso(toUtc(iso) + n * DAY);
export const isBusinessDay = (iso) => {
  const wd = new Date(toUtc(iso)).getUTCDay();
  return wd !== 0 && wd !== 6;
};
const pad = (n) => String(n).padStart(2, '0');

/** Third Wednesday of a month (IMM date), 'YYYY-MM-DD'. m is 1-12. */
export function imm(y, m) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const day = 1 + ((3 - first + 7) % 7) + 14;
  return `${y}-${pad(m)}-${pad(day)}`;
}

const MONTH_CODE = 'FGHJKMNQUVXZ';
export const contractCode = (root, y, m) => `${root}${MONTH_CODE[m - 1]}${y % 10}`;

/**
 * Quarterly IMM contracts (SR3 by default; ESR for Three-Month €STR) whose reference quarter
 * ends after `asOf`, in order.
 * @returns {Array<{code, year, month, start, end}>} start inclusive, end exclusive
 */
export function sr3Contracts(asOf, count, root = 'SR3') {
  const out = [];
  let [y] = asOf.split('-').map(Number);
  y -= 1;
  for (let guard = 0; out.length < count && guard < 40; guard += 1) {
    const year = y;
    [3, 6, 9, 12].forEach((m) => {
      if (out.length >= count) return;
      const start = imm(year, m);
      const end = m === 12 ? imm(year + 1, 3) : imm(year, m + 3);
      if (end > asOf) {
        out.push({
          code: contractCode(root, year, m), year, month: m, start, end,
        });
      }
    });
    y += 1;
  }
  return out;
}

/** SR1 contracts from the month after `asOf`'s month (or its month if still running). */
export function sr1Contracts(asOf, count) {
  const [y0, m0, d0] = asOf.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y0, m0, 0)).getUTCDate();
  let y = y0;
  let m = d0 >= lastDay ? m0 + 1 : m0;
  const out = [];
  while (out.length < count) {
    if (m > 12) { m = 1; y += 1; }
    const start = `${y}-${pad(m)}-01`;
    const end = toIso(Date.UTC(y, m, 1));
    out.push({
      code: contractCode('SR1', y, m), year: y, month: m, start, end,
    });
    m += 1;
  }
  return out;
}

/**
 * Daily SOFR (%), actual up to `asOf`, implied after it.
 * @param {object} p
 * @param {string} p.asOf last date with an actual fixing
 * @param {Object<string, number>} p.fixings actual O/N SOFR by business day 'YYYY-MM-DD'
 * @param {number} p.lower lower bound of the target range at `asOf` (%)
 * @param {number} p.spread (EFFR - lower bound) + (SOFR - EFFR), in % (held constant)
 * @param {Array<{date: string, change: number, effective?: string}>} p.moves policy changes in
 *   basis points; a change applies from `effective` (default: the day after `date`)
 * @returns {(iso: string) => number} rate for any calendar day
 */
export function sofrPath({
  asOf, fixings, lower, spread, moves,
}) {
  const steps = moves.filter((mv) => mv.date >= asOf)
    .map((mv) => ({ from: mv.effective || addDays(mv.date, 1), change: mv.change / 100 }))
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  const implied = (iso) => steps.reduce(
    (r, s) => (iso >= s.from ? r + s.change : r),
    lower + spread,
  );
  const cache = new Map();
  const rateOn = (iso) => {
    if (cache.has(iso)) return cache.get(iso);
    let r;
    if (iso <= asOf) {
      // the latest published fixing on or before this day
      let d = iso;
      for (let i = 0; i < 10 && fixings[d] === undefined; i += 1) d = addDays(d, -1);
      r = fixings[d] ?? implied(iso);
    } else {
      // a non-business day keeps the previous business day's rate
      let d = iso;
      for (let i = 0; i < 4 && !isBusinessDay(d); i += 1) d = addDays(d, -1);
      r = d <= asOf ? rateOn(d) : implied(d);
    }
    cache.set(iso, r);
    return r;
  };
  return rateOn;
}

/** SR3 final settlement (price) from daily compounding over [start, end). */
export function sr3Settlement(start, end, rateOn) {
  let growth = 1;
  let days = 0;
  for (let t = toUtc(start); t < toUtc(end); t += DAY) {
    growth *= 1 + rateOn(toIso(t)) / 100 / 360;
    days += 1;
  }
  const rate = (((growth - 1) * 360) / days) * 100;
  return { price: 100 - rate, rate };
}

/** SR1 final settlement (price) from the average daily rate over [start, end). */
export function sr1Settlement(start, end, rateOn) {
  let sum = 0;
  let days = 0;
  for (let t = toUtc(start); t < toUtc(end); t += DAY) {
    sum += rateOn(toIso(t));
    days += 1;
  }
  const rate = sum / days;
  return { price: 100 - rate, rate };
}
