/*
 * FedWatch page model shared by the FedWatch blocks: formatting, the data set (loaded once per
 * page, probabilities computed with ./engine.js) and a chart registry that redraws charts on
 * resize and when a hidden tab panel is shown.
 */
import * as FW from './engine.js';

// ---------- formatting ----------
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZQ_MONTH = 'FGHJKMNQUVXZ';
export const parts = (iso) => iso.split('-').map(Number);
export const utc = (iso) => { const [y, m, d] = parts(iso); return Date.UTC(y, m - 1, d); };
export const fmtDate = (iso) => { const [y, m, d] = parts(iso); return `${d} ${MON[m - 1]} ${y}`; };
export const fmtLong = (iso) => `${WEEKDAY[new Date(utc(iso)).getUTCDay()]} ${fmtDate(iso)}`;
export const fmtMonthTick = (iso) => { const [y, m] = parts(iso); return `${MON[m - 1]} ’${String(y).slice(2)}`; };
export const nbsp = (s) => s.replace(/ /g, ' ');
export const signed = (x, dp = 1) => `${x > 0 ? '+' : ''}${x.toFixed(dp)}`;
export const rangeText = (lower) => FW.rangeLabel(lower).replace('-', '–');
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));
export const MIN_P = 0.0005; // ranges below 0.05% everywhere are left out of charts and tables

// FOMC statements are released at 2:00 p.m. Eastern; work out the UTC instant.
const nthSunday = (y, month, n) => {
  const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + 7 * (n - 1);
};
export const decisionUtc = (iso) => {
  const [y, m, d] = parts(iso);
  const t = Date.UTC(y, m - 1, d);
  const dst = t >= Date.UTC(y, 2, nthSunday(y, 3, 2)) && t < Date.UTC(y, 10, nthSunday(y, 11, 1));
  return Date.UTC(y, m - 1, d, dst ? 18 : 19);
};
export const zqCode = (month) => { const [y, m] = parts(month); return `ZQ${ZQ_MONTH[m - 1]}${y % 10}`; };

// ---------- shared model (one per page) ----------
export const SNAPS = ['now', '1d', '1w', '1m'];
export const SNAP_NAME = {
  now: 'Now', '1d': '1 day ago', '1w': '1 week ago', '1m': '1 month ago',
};
export const SNAP_SERIES = {
  now: 0, '1d': 1, '1w': 2, '1m': 3,
}; // colour follows the snapshot on every chart

let modelPromise = null;
export function loadModel(url) {
  if (modelPromise) return modelPromise;
  const src = url || `${window.hlx?.codeBasePath || ''}/scripts/fedwatch/sample-data.json`;
  modelPromise = fetch(src).then((r) => {
    if (!r.ok) throw new Error(`FedWatch data ${r.status}`);
    return r.json();
  }).then((D) => {
    const NOW = D.snapshots.now;
    const res = {};
    SNAPS.forEach((k) => {
      res[k] = new Map(FW.probabilities(D.snapshots[k], D.meetings).map((r) => [r.date, r]));
    });
    const upcoming = [...res.now.keys()];
    const historyRes = D.history.filter((s) => s.asOf < NOW.asOf).concat([NOW]).map((s) => ({
      asOf: s.asOf,
      byMeeting: new Map(FW.probabilities(s, D.meetings).map((r) => [r.date, r])),
    }));
    let meeting = upcoming.find((iso) => decisionUtc(iso) > Date.now()) || upcoming[0];
    try {
      const q = new URLSearchParams(window.location.search).get('meeting');
      if (q && res.now.has(q)) meeting = q;
    } catch (e) { /* ignore */ }
    return {
      D,
      NOW,
      CUR: NOW.targetLower,
      res,
      upcoming,
      historyRes,
      meeting,
      sep: new Set(D.sepMeetings || []),
      asOfText: `Prices as of ${fmtDate(NOW.asOf)}${D.sample ? ' (sample)' : ''}`,
      views: new Set(), // re-render functions of views that follow the selected meeting
      csv: {},
    };
  });
  return modelPromise;
}

export const pAt = (r, lower) => (r ? (r.dist.get(Math.round(lower * 1e4) / 1e4) || 0) : null);
export const best = (dist) => [...dist].reduce((a, b) => (b[1] > a[1] ? b : a));
export function rangesFor(results, always = []) {
  const keys = new Set(always.map((l) => Math.round(l * 1e4) / 1e4));
  results.forEach((r) => r && r.dist.forEach((p, l) => { if (p >= MIN_P) keys.add(l); }));
  return [...keys].sort((a, b) => a - b);
}

// ---------- charts: redraw on resize and when a hidden tab panel is shown ----------
const charts = new Map(); // canvas -> draw()
const pending = new Set();
function drawWhenVisible(canvas) {
  const fn = charts.get(canvas);
  if (fn && canvas.isConnected && canvas.clientWidth > 0) fn(canvas);
}
const ro = 'ResizeObserver' in window ? new ResizeObserver((entries) => {
  entries.forEach((e) => pending.add(e.target));
  requestAnimationFrame(() => { pending.forEach(drawWhenVisible); pending.clear(); });
}) : null;
export function register(canvas, fn) {
  if (!canvas) return;
  const first = !charts.has(canvas);
  charts.set(canvas, fn);
  if (first && ro) ro.observe(canvas);
  drawWhenVisible(canvas);
}
export const redrawAll = () => charts.forEach((fn, c) => drawWhenVisible(c));
export const redraw = drawWhenVisible;
