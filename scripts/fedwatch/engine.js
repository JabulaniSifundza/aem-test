/*
 * FedWatch probability engine. Implements the published CME FedWatch methodology
 * ("Understanding the CME Group FedWatch Tool methodology"):
 *   - implied average EFFR for a month = 100 - 30-Day Fed Funds futures (ZQ) price;
 *   - months without an FOMC meeting anchor the chain:
 *     EFFR(end, T-1) = EFFR(avg, T) = EFFR(start, T+1);
 *   - in a meeting month, avg = start * d/N + end * (N - d)/N, where the new rate applies from the
 *     day after the decision (d = decision day, N = days in month); one side comes from a
 *     neighbouring month and the other is solved from the meeting month's own price;
 *   - the expected change at each meeting is split into 25 bp steps: move n steps with
 *     probability 1 - frac and n + 1 steps with probability frac;
 *   - meetings are chained as a binary tree; probabilities multiply along each path.
 * Pure functions, no DOM. Shared by blocks/fedwatch (and anything else that needs it).
 */
export const STEP = 0.25; // percentage points per move

const pad = (n) => String(n).padStart(2, '0');
const monthKey = (y, m) => `${y}-${pad(m)}`; // m is 1-12
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const parseDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
};
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Expected EFFR at the start and end of every contract month from the snapshot's month onwards.
 * @param {object} snap { asOf: 'YYYY-MM-DD', effr: number (%), prices: { 'YYYY-MM': price } }
 * @param {string[]} meetings decision dates 'YYYY-MM-DD'
 * @returns {Map<string, {start:number,end:number,avg:number,meetingDay:number|null,days:number}>}
 */
export function monthPath(snap, meetings) {
  const asOf = parseDate(snap.asOf);
  const meetingByMonth = new Map();
  meetings.forEach((iso) => {
    const { y, m, d } = parseDate(iso);
    meetingByMonth.set(monthKey(y, m), d);
  });
  const months = Object.keys(snap.prices).sort()
    .filter((k) => k >= monthKey(asOf.y, asOf.m));
  const path = new Map();
  months.forEach((k) => {
    const [y, m] = k.split('-').map(Number);
    const day = meetingByMonth.get(k) ?? null;
    // a meeting already held this month no longer moves this month's expectations
    const live = day !== null && !(k === monthKey(asOf.y, asOf.m) && day < asOf.d);
    path.set(k, {
      avg: 100 - snap.prices[k],
      days: daysIn(y, m),
      meetingDay: live ? day : null,
      start: null,
      end: null,
    });
  });
  // anchors: months without a live meeting
  path.forEach((v) => {
    if (v.meetingDay === null) { v.start = v.avg; v.end = v.avg; }
  });
  // the current month is anchored on today's EFFR (its average also holds days already past)
  const first = path.get(months[0]);
  if (first) {
    first.start = snap.effr;
    if (first.meetingDay === null) first.end = snap.effr;
  }
  // Resolve each meeting month from ONE known side plus the month's own futures price.
  // Start side: the end of the month before. End side: a following month without a meeting.
  // When both are known, solve for the side that divides by the larger share of the month, so
  // price rounding is not amplified (late meeting: anchor the end; early meeting: the start).
  for (let pass = 0; pass < months.length; pass += 1) {
    months.forEach((k, i) => {
      const v = path.get(k);
      if (v.meetingDay === null || (v.start !== null && v.end !== null)) return;
      const prev = i > 0 ? path.get(months[i - 1]) : null;
      const next = i < months.length - 1 ? path.get(months[i + 1]) : null;
      const a = v.meetingDay / v.days; // share of the month at the old rate
      const fromStart = v.start !== null ? v.start : (prev && prev.end) ?? null;
      const fromEnd = next && next.meetingDay === null ? next.start : null;
      if (fromEnd !== null && (fromStart === null || a >= 0.5)) {
        v.end = fromEnd;
        v.start = (v.avg - v.end * (1 - a)) / a;
      } else if (fromStart !== null) {
        v.start = fromStart;
        v.end = (v.avg - v.start * a) / (1 - a);
      }
      if (v.end !== null && next && next.start === null) next.start = v.end;
    });
  }
  return path;
}

/**
 * Target-rate probabilities for every upcoming meeting.
 * @param {object} snap snapshot (see monthPath) plus targetLower: lower bound of the current
 *   range (%)
 * @param {string[]} meetings decision dates
 * @returns {Array<{date:string, expectedChange:number, expectedRate:number,
 *   dist: Map<number, number>, ZQ:{month:string, price:number}}>}
 *   dist maps the lower bound of each target range (%) to its probability (0-1).
 */
export function probabilities(snap, meetings) {
  const path = monthPath(snap, meetings);
  const upcoming = meetings.filter((iso) => iso >= snap.asOf).sort();
  let dist = new Map([[snap.targetLower, 1]]);
  const out = [];
  for (let i = 0; i < upcoming.length; i += 1) {
    const iso = upcoming[i];
    const { y, m } = parseDate(iso);
    const k = monthKey(y, m);
    const v = path.get(k);
    // no futures price for that month: later meetings would build on a gap, so stop here
    if (!v || v.start === null || v.end === null) break;
    const steps = (v.end - v.start) / STEP;
    const n = Math.floor(steps + 1e-9);
    const frac = Math.min(Math.max(steps - n, 0), 1);
    const next = new Map();
    dist.forEach((p, lower) => {
      const add = (lb, q) => {
        if (q <= 1e-9) return;
        const key = round4(lb);
        next.set(key, (next.get(key) || 0) + p * q);
      };
      add(lower + n * STEP, 1 - frac);
      add(lower + (n + 1) * STEP, frac);
    });
    dist = next;
    let expected = 0;
    dist.forEach((p, lower) => { expected += p * (lower + STEP / 2); });
    out.push({
      date: iso,
      expectedChange: v.end - v.start,
      expectedRate: expected,
      dist: new Map([...dist.entries()].sort((a, b) => a[0] - b[0])),
      zq: { month: k, price: snap.prices[k], avg: v.avg },
    });
  }
  return out;
}

/** Probability of the outcome relative to the current range: hike / no change / cut. */
export function outcomeSplit(dist, currentLower) {
  let hike = 0; let hold = 0; let cut = 0;
  dist.forEach((p, lower) => {
    if (lower > currentLower + 1e-9) hike += p;
    else if (lower < currentLower - 1e-9) cut += p;
    else hold += p;
  });
  return { hike, hold, cut };
}

/** "375-400" style label (basis points), as FedWatch shows target ranges. */
export const rangeLabel = (lower) => `${Math.round(lower * 100)}-${Math.round((lower + STEP) * 100)}`;
