import {
  el, icon, text, keyedRows, cmeLink, exploreMenu, buttonsFrom,
} from '../../scripts/cme-dom.js';
import * as FW from '../../scripts/fedwatch/engine.js';
import {
  barChart, lineChart, dotChart, seriesColor, pct, rate,
} from './charts.js';

/*
 * FedWatch — CME FedWatch target rate probabilities, built from design-language components
 * (hero.md product hero, tabs.md, empty-toolbar.md toolbar, filter-dropdown.md dropdown,
 * facts-steps.md facts, chart.md chart panels, spec-panel.md, table.md).
 * One block per part of the page; the parts share one data set and one selected meeting:
 *   FedWatch (hero)      the product hero with live stats. Rows: Breadcrumb | link,
 *                        Explore … | links, Title, Subtitle, Actions | links (bold = primary),
 *                        Footnote | paragraphs (the price date is added automatically)
 *   FedWatch (tool)      one meeting: Current / Compare / History views
 *   FedWatch (meetings)  every meeting: probability matrix, cut/hold/hike, rate path
 *   FedWatch (dot-plot)  FOMC dot plot against futures-implied year-end rates
 * Any of them may carry a "Data" row with a link to a JSON file in the same shape as
 * /scripts/fedwatch/sample-data.json; without a link the built-in, illustrative sample is used.
 * The first block on the page to load decides the data for all of them.
 * Open/close and tabs come from scripts/cme.js; this block listens for its cme:change events.
 */

// ---------- formatting ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZQ_MONTH = 'FGHJKMNQUVXZ';
const parts = (iso) => iso.split('-').map(Number);
const utc = (iso) => { const [y, m, d] = parts(iso); return Date.UTC(y, m - 1, d); };
const fmtDate = (iso) => { const [y, m, d] = parts(iso); return `${d} ${MON[m - 1]} ${y}`; };
const fmtLong = (iso) => `${WEEKDAY[new Date(utc(iso)).getUTCDay()]} ${fmtDate(iso)}`;
const fmtMonthTick = (iso) => { const [y, m] = parts(iso); return `${MON[m - 1]} ’${String(y).slice(2)}`; };
const nbsp = (s) => s.replace(/ /g, ' ');
const signed = (x, dp = 1) => `${x > 0 ? '+' : ''}${x.toFixed(dp)}`;
const rangeText = (lower) => FW.rangeLabel(lower).replace('-', '–');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));
const MIN_P = 0.0005; // ranges below 0.05% everywhere are left out of charts and tables

// FOMC statements are released at 2:00 p.m. Eastern; work out the UTC instant.
const nthSunday = (y, month, n) => {
  const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + 7 * (n - 1);
};
const decisionUtc = (iso) => {
  const [y, m, d] = parts(iso);
  const t = Date.UTC(y, m - 1, d);
  const dst = t >= Date.UTC(y, 2, nthSunday(y, 3, 2)) && t < Date.UTC(y, 10, nthSunday(y, 11, 1));
  return Date.UTC(y, m - 1, d, dst ? 18 : 19);
};
const zqCode = (month) => { const [y, m] = parts(month); return `ZQ${ZQ_MONTH[m - 1]}${y % 10}`; };

// ---------- shared model (one per page) ----------
const SNAPS = ['now', '1d', '1w', '1m'];
const SNAP_NAME = {
  now: 'Now', '1d': '1 day ago', '1w': '1 week ago', '1m': '1 month ago',
};
const SNAP_SERIES = {
  now: 0, '1d': 1, '1w': 2, '1m': 3,
}; // colour follows the snapshot on every chart

let modelPromise = null;
function loadModel(url) {
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

const pAt = (r, lower) => (r ? (r.dist.get(Math.round(lower * 1e4) / 1e4) || 0) : null);
const best = (dist) => [...dist].reduce((a, b) => (b[1] > a[1] ? b : a));
function rangesFor(results, always = []) {
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
function register(canvas, fn) {
  if (!canvas) return;
  const first = !charts.has(canvas);
  charts.set(canvas, fn);
  if (first && ro) ro.observe(canvas);
  drawWhenVisible(canvas);
}
const redrawAll = () => charts.forEach((fn, c) => drawWhenVisible(c));

function chartPanel(key, title, footer, note) {
  return `<div class="cme-chart" role="figure" aria-labelledby="fw-${key}-title" data-cme-gap="chart-figure-margin" data-cme-gap-note="chart.md shows figure/figcaption, but the CSS does not reset the browser figure margin. Used div role=figure.">
    <div class="cme-chart__header"><h3 class="cme-chart__title" id="fw-${key}-title" data-fw="${key}-title">${esc(title)}</h3>${footer.action || ''}</div>
    <div class="cme-chart__canvas" data-fw-chart="${key}"></div>
    <div class="cme-chart__footer"><span class="cme-chart__axis-label">${esc(footer.axis)}</span>${footer.legend || ''}</div>
    <p class="cme-chart__note" data-fw="${key}-note">${esc(note)}</p>
  </div>`;
}
const legend = (items, slot) => `<ul class="cme-chart__legend"${slot ? ` data-fw="${slot}"` : ''}>${items.map(([i, t]) => `<li class="cme-series-${i}">${esc(t)}</li>`).join('')}</ul>`;
const q = (root, name) => root.querySelector(`[data-fw="${name}"]`);

// ---------- hero ----------
function renderHero(block, M, author) {
  const nav = [];
  const crumb = author.get('breadcrumb')?.querySelector('a');
  if (crumb) {
    const link = cmeLink(crumb, 'cme-breadcrumb');
    link.prepend(icon('arrow-left-bold'));
    nav.push(link);
  }
  const exploreKey = [...author.keys()].find((k) => k.startsWith('explore'));
  if (exploreKey) {
    const label = text(author.get(exploreKey).closest('div').parentElement.firstElementChild);
    const menu = exploreMenu(label, [...author.get(exploreKey).querySelectorAll('a')]);
    if (menu) nav.push(menu);
  }
  const stat = (label, slot) => el(
    'div',
    { class: 'cme-stat' },
    el('span', { class: 'cme-stat__label', 'data-fw': `${slot}-label` }, label),
    el('span', { class: 'cme-stat__value', 'data-fw': slot }),
  );
  const actions = buttonsFrom(author.get('actions'));
  const notes = author.get('footnote') ? [...author.get('footnote').querySelectorAll('p')].map(text).filter(Boolean) : [];
  if (!notes.length && author.get('footnote')) notes.push(text(author.get('footnote')));
  block.replaceChildren(
    nav.length ? el('div', { class: 'cme-hero__nav' }, nav) : '',
    el('h1', { class: 'cme-hero__title', id: 'fw-page-title' }, text(author.get('title')) || 'CME FedWatch'),
    author.get('subtitle') ? el('p', { class: 'cme-hero__subtitle' }, text(author.get('subtitle'))) : '',
    el(
      'div',
      { class: 'cme-stats' },
      stat('Target range (%)', 'hero-target'),
      stat('Next FOMC decision', 'hero-next'),
      stat('Most likely outcome', 'hero-likely'),
      stat('Time to decision', 'hero-countdown'),
      actions.length ? el('div', { class: 'cme-stat__actions' }, actions) : '',
    ),
    el('p', { class: 'cme-hero__footnote' }, [M.asOfText, ...notes].map((n) => el('span', {}, n))),
  );
  const section = block.closest('.section');
  if (section) {
    section.classList.add('cme-section--inverse', 'cme-inverse', 'cme-hero', 'cme-hero--product');
    section.setAttribute('aria-labelledby', 'fw-page-title');
  }

  const nextMeeting = () => M.upcoming.find((iso) => decisionUtc(iso) > Date.now()) || null;
  q(block, 'hero-target').textContent = `${M.CUR.toFixed(2)}–${(M.CUR + FW.STEP).toFixed(2)}`;
  const tick = () => {
    const next = nextMeeting();
    q(block, 'hero-next').textContent = next ? fmtDate(next) : 'None scheduled';
    const cd = q(block, 'hero-countdown');
    if (!next) {
      q(block, 'hero-likely').textContent = '—';
      cd.textContent = '—';
      return;
    }
    const [lower, p] = best(M.res.now.get(next).dist);
    let what = 'no change';
    if (lower > M.CUR + 1e-9) what = `hike to ${rangeText(lower)}`;
    if (lower < M.CUR - 1e-9) what = `cut to ${rangeText(lower)}`;
    q(block, 'hero-likely-label').textContent = `Most likely: ${what}`;
    q(block, 'hero-likely').textContent = pct(p);
    const ms = Math.max(0, decisionUtc(next) - Date.now());
    const d = Math.floor(ms / 864e5);
    const h = Math.floor((ms % 864e5) / 36e5);
    const m = Math.floor((ms % 36e5) / 6e4);
    const two = (n) => String(n).padStart(2, '0');
    cd.textContent = d > 0 ? `${d}d ${two(h)}h` : `${two(h)}h ${two(m)}m`;
    cd.title = `Until ${fmtLong(next)}, 2:00 PM ET`;
  };
  tick();
  setInterval(tick, 30000);
}

// ---------- tool: one meeting ----------
function renderTool(block, M) {
  block.innerHTML = `
    <p class="cme-lead" data-fw="tool-lead"></p>
    <div class="cme-toolbar cme-mt-m" data-cme-gap="meeting-picker" data-cme-gap-note="Needed a single-choice picker for 10 meetings (chips allow 6). Used the result toolbar: position line on the left, dropdown on the right.">
      <p class="cme-toolbar__count cme-mb-0" aria-live="polite" data-fw="tool-count"></p>
      <div class="cme-dropdown">
        <button class="cme-dropdown__trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="fw-meeting-menu" data-fw="meeting-trigger"></button>
        <div class="cme-dropdown__menu" id="fw-meeting-menu" role="menu" hidden data-fw="meeting-menu"></div>
      </div>
    </div>
    <div class="cme-tabs" role="tablist" aria-label="Probability views">
      <button class="cme-tabs__tab is-active" role="tab" aria-selected="true" aria-controls="fw-view-current" id="fw-tab-current" type="button">Current</button>
      <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="fw-view-compare" id="fw-tab-compare" type="button">Compare</button>
      <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="fw-view-history" id="fw-tab-history" type="button">History</button>
    </div>
    <div role="tabpanel" id="fw-view-current" aria-labelledby="fw-tab-current" class="cme-mt-m">
      <ul class="cme-facts" data-fw="facts"></ul>
      <div class="cme-row cme-mt-m">
        <div class="cme-col-lg-8">${chartPanel('current', '', { axis: 'Target rate (bps)' }, `${M.asOfText}. Select a bar to read its value.`)}</div>
        <div class="cme-col-lg-4">
          <div class="cme-spec">
            <div class="cme-spec__header">
              <h3 class="cme-spec__title">Meeting details</h3>
              <a class="cme-link" href="https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.contractSpecs.html"><span class="cme-link__text">View contract specs</span></a>
            </div>
            <ul class="cme-spec__list" data-fw="meeting-spec"></ul>
            <p class="cme-spec__updated">${esc(M.asOfText)}</p>
          </div>
        </div>
      </div>
    </div>
    <div role="tabpanel" id="fw-view-compare" aria-labelledby="fw-tab-compare" class="cme-mt-m" hidden>
      ${chartPanel('compare', '', { axis: 'Target rate (bps)', legend: legend(SNAPS.map((k) => [SNAP_SERIES[k] + 1, SNAP_NAME[k]])) }, 'The table below holds the same values.')}
      <div class="cme-table-wrap cme-mt-m">
        <table class="cme-table">
          <caption class="cme-visually-hidden" data-fw="compare-caption"></caption>
          <thead><tr><th scope="col">Target rate (bps)</th>${SNAPS.map((k) => `<th scope="col">${SNAP_NAME[k]}</th>`).join('')}</tr></thead>
          <tbody data-fw="compare-body"></tbody>
        </table>
      </div>
    </div>
    <div role="tabpanel" id="fw-view-history" aria-labelledby="fw-tab-history" class="cme-mt-m" hidden>
      ${chartPanel('history', '', {
    axis: 'Week',
    legend: legend([], 'history-legend'),
    action: '<button class="cme-link" type="button" data-fw-download="history"><span class="cme-icon cme-icon--download" aria-hidden="true"></span><span class="cme-link__text">Download CSV</span></button>',
  }, 'Weekly prices, sample data. Lines start when the sample first has a price for the meeting month. Hover over or focus the chart and use the arrow keys to read each week.')}
    </div>`;

  q(block, 'meeting-menu').innerHTML = M.upcoming.map((iso) => {
    const label = `${fmtDate(iso)}${M.sep.has(iso) ? ' · projections' : ''}`;
    return `<button class="cme-dropdown__item" role="menuitemradio" aria-checked="false" type="button" data-value="${iso}" data-cme-select="Meeting: ${fmtDate(iso)}">${esc(label)}</button>`;
  }).join('');

  const draw = () => {
    const { meeting, NOW, CUR } = M;
    const r = M.res.now.get(meeting);
    const i = M.upcoming.indexOf(meeting);
    const days = Math.round((utc(meeting) - utc(NOW.asOf)) / 864e5);
    const [y, m] = parts(meeting);
    const name = fmtDate(meeting);
    const catOf = (lower) => ({ text: rangeText(lower), sub: Math.abs(lower - CUR) < 1e-9 ? 'Current' : '' });
    q(block, 'meeting-trigger').textContent = `Meeting: ${name}`;
    block.querySelectorAll('[data-fw="meeting-menu"] [data-value]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === meeting)));
    q(block, 'tool-lead').textContent = `Chances of each target range after the FOMC meeting on ${name}, implied by the ${MONTH[m - 1]} ${y} 30-Day Fed Funds futures price.`;
    q(block, 'tool-count').textContent = `Meeting ${i + 1} of ${M.upcoming.length} · ${days} days from ${fmtDate(NOW.asOf)}${M.sep.has(meeting) ? ' · with economic projections' : ''}`;

    const split = FW.outcomeSplit(r.dist, CUR);
    const facts = [
      [pct(split.cut), 'Cut'], [pct(split.hold), 'No change'], [pct(split.hike), 'Hike'],
      [rate(r.expectedRate), 'Expected rate', 'Probability-weighted midpoint'],
    ];
    q(block, 'facts').innerHTML = facts.map(([v, l, note]) => `<li class="cme-fact"><span class="cme-fact__value">${v}</span><span class="cme-fact__label">${l}</span>${note ? `<span class="cme-fact__note">${note}</span>` : ''}</li>`).join('');

    const spec = [
      ['Decision date', `${fmtLong(meeting)}, 2:00 PM ET`],
      ['Futures contract', zqCode(r.zq.month), `(${MON[m - 1]} ${y})`],
      ['Futures price', r.zq.price.toFixed(4)],
      ['Implied average rate', rate(r.zq.avg, 3)],
      ['Implied change at meeting', signed(r.expectedChange * 100), 'bps'],
    ];
    // numbers and codes in Roboto Mono (rule 7), words in the spec's body style
    q(block, 'meeting-spec').innerHTML = spec.map(([l, v, unit], j) => `<li><h4 class="cme-spec__label">${l}</h4><p class="cme-spec__value">${
      j === 0 ? esc(v) : `<span class="cme-data-md">${esc(v)}</span>${unit ? ` ${esc(unit)}` : ''}`}</p></li>`).join('');

    q(block, 'current-title').textContent = `Target rate probabilities for ${name}`;
    q(block, 'compare-title').textContent = `How expectations moved for ${name}`;
    q(block, 'compare-caption').textContent = `Target rate probabilities for ${name}: now and earlier`;
    q(block, 'history-title').textContent = `Probability history for ${name}`;

    const curRanges = rangesFor([r], [CUR]);
    register(block.querySelector('[data-fw-chart="current"]'), (c) => barChart(c, {
      label: `Bar chart: target rate probabilities for ${name}. Each bar can be focused to read its value.`,
      categories: curRanges.map(catOf),
      series: [{ name: 'Probability', color: seriesColor(0), values: curRanges.map((l) => pAt(r, l)) }],
      valueLabels: true,
    }));

    const byS = SNAPS.map((k) => M.res[k].get(meeting) || null);
    const cmpRanges = rangesFor(byS, [CUR]);
    q(block, 'compare-body').innerHTML = cmpRanges.map((l) => `<tr><td class="cme-table__name">${rangeText(l)}${Math.abs(l - CUR) < 1e-9 ? ' (current)' : ''}</td>${
      byS.map((s) => `<td class="cme-num">${s ? pct(pAt(s, l)) : '—'}</td>`).join('')}</tr>`).join('');
    register(block.querySelector('[data-fw-chart="compare"]'), (c) => barChart(c, {
      label: `Grouped bar chart: probabilities for ${name} now, 1 day, 1 week and 1 month ago. The table below lists the values.`,
      categories: cmpRanges.map(catOf),
      series: SNAPS.map((k, j) => ({
        name: SNAP_NAME[k],
        color: seriesColor(SNAP_SERIES[k]),
        values: cmpRanges.map((l) => (byS[j] ? pAt(byS[j], l) : null)),
      })),
      valueLabels: false,
    }));

    // history: the three ranges that mattered most over the year, plus everything else
    const hist = M.historyRes.map((h) => h.byMeeting.get(meeting) || null);
    const peak = new Map();
    hist.forEach((x) => x && x.dist.forEach((p, l) => peak.set(l, Math.max(peak.get(l) || 0, p))));
    const top = [...peak].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l)
      .sort((a, b) => a - b);
    const series = top.map((l, j) => ({
      name: rangeText(l), idx: j, values: hist.map((x) => (x ? pAt(x, l) : null)),
    }));
    const rest = (x) => Math.max(0, 1 - top.reduce((a, l) => a + pAt(x, l), 0));
    const other = hist.map((x) => (x ? rest(x) : null));
    if (other.some((v) => v !== null && v >= 0.005)) series.push({ name: 'Other ranges', idx: 3, values: other });
    series.forEach((sr) => { sr.color = seriesColor(sr.idx); });
    q(block, 'history-legend').innerHTML = series.map((sr) => `<li class="cme-series-${sr.idx + 1}">${esc(sr.name)}</li>`).join('');
    M.csv.history = [['Week'].concat(series.map((s) => s.name.replace('–', '-')))]
      .concat(M.historyRes.map((h, j) => [h.asOf].concat(series.map((s) => (s.values[j] === null ? '' : (s.values[j] * 100).toFixed(2))))))
      .map((row) => row.join(',')).join('\n');
    const xs = M.historyRes.map((h) => utc(h.asOf));
    const xTicks = [];
    M.historyRes.forEach((h, j) => {
      const [, mo, d] = parts(h.asOf);
      if (d <= 7 && (mo - 1) % 2 === 0) xTicks.push({ x: xs[j], text: fmtMonthTick(h.asOf) });
    });
    register(block.querySelector('[data-fw-chart="history"]'), (c) => lineChart(c, {
      label: `Line chart: weekly probability history for the ${name} meeting. Focus the chart and use the arrow keys to read each week.`,
      xs,
      xTicks,
      xLabel: (j) => `Week of ${fmtDate(M.historyRes[j].asOf)}`,
      series,
      yFmt: pct,
      yTickFmt: (v) => `${Math.round(v * 100)}%`,
      yMin: 0,
      yMax: 1,
    }));
  };
  M.views.add(draw);
  draw();
}

// ---------- every meeting ----------
function renderMeetings(block, M) {
  const { CUR } = M;
  const all = M.upcoming.map((iso) => M.res.now.get(iso));
  const ranges = rangesFor(all, [CUR]);
  const head = ranges.map((l) => `<th scope="col">${rangeText(l)}${Math.abs(l - CUR) < 1e-9 ? ' (current)' : ''}</th>`).join('');
  const matrix = all.map((r) => {
    const top = best(r.dist)[0];
    const cells = ranges.map((l) => {
      const v = pct(pAt(r, l));
      return `<td class="cme-num">${Math.abs(l - top) < 1e-9 ? `<strong>${v}</strong>` : v}</td>`;
    }).join('');
    return `<tr><td class="cme-table__name"><a href="#tool" data-fw-meeting="${r.date}">${nbsp(fmtDate(r.date))}</a></td>${cells}</tr>`;
  }).join('');
  const split = all.map((r) => {
    const s = FW.outcomeSplit(r.dist, CUR);
    const vs = (r.expectedRate - (CUR + FW.STEP / 2)) * 100;
    return `<tr><td class="cme-table__name">${nbsp(fmtDate(r.date))}</td><td class="cme-num">${pct(s.cut)}</td><td class="cme-num">${pct(s.hold)}</td><td class="cme-num">${pct(s.hike)}</td><td class="cme-num">${rate(r.expectedRate)}</td><td class="cme-num">${signed(vs)}</td></tr>`;
  }).join('');
  M.csv.matrix = [['Meeting'].concat(ranges.map((l) => FW.rangeLabel(l)))]
    .concat(all.map((r) => [r.date].concat(ranges.map((l) => (pAt(r, l) * 100).toFixed(2)))))
    .map((row) => row.join(',')).join('\n');
  const pathSnaps = ['now', '1w', '1m'];

  block.innerHTML = `
    <div class="cme-toolbar cme-mt-m" data-cme-gap="tabs-with-action" data-cme-gap-note="Needed content tabs with a download action on the same line. Used the result toolbar layout to hold both.">
      <div class="cme-tabs" role="tablist" aria-label="Meeting views">
        <button class="cme-tabs__tab is-active" role="tab" aria-selected="true" aria-controls="fw-all-matrix" id="fw-tab-matrix" type="button">Probabilities</button>
        <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="fw-all-split" id="fw-tab-split" type="button">Cut, hold or hike</button>
        <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="fw-all-path" id="fw-tab-path" type="button">Rate path</button>
      </div>
      <button class="cme-btn cme-btn--secondary" type="button" data-fw-download="matrix"><span class="cme-icon cme-icon--download" aria-hidden="true"></span>Download probabilities</button>
    </div>
    <div role="tabpanel" id="fw-all-matrix" aria-labelledby="fw-tab-matrix">
      <div class="cme-table-wrap">
        <table class="cme-table" data-cme-gap="table-cell-emphasis" data-cme-gap-note="Needed to mark the most likely target range in each row; used plain strong because table.md has no highlight cell.">
          <caption class="cme-visually-hidden">Probability of each target range after every upcoming FOMC meeting. The most likely range in each row is in bold.</caption>
          <thead><tr><th scope="col">Meeting</th>${head}</tr></thead>
          <tbody>${matrix}</tbody>
        </table>
      </div>
      <p class="cme-fine cme-mt-s cme-mb-0">Select a meeting to open it in the tool above. Ranges in basis points.</p>
    </div>
    <div role="tabpanel" id="fw-all-split" aria-labelledby="fw-tab-split" hidden>
      <div class="cme-table-wrap">
        <table class="cme-table">
          <caption class="cme-visually-hidden">Probability of a lower, unchanged or higher target range after each meeting, compared with today's range</caption>
          <thead><tr><th scope="col">Meeting</th><th scope="col">Lower than today</th><th scope="col">Unchanged</th><th scope="col">Higher than today</th><th scope="col">Expected rate</th><th scope="col">Versus today (bps)</th></tr></thead>
          <tbody>${split}</tbody>
        </table>
      </div>
    </div>
    <div role="tabpanel" id="fw-all-path" aria-labelledby="fw-tab-path" hidden>
      ${chartPanel('path', 'Expected target rate after each meeting', {
    axis: 'FOMC meeting',
    legend: legend(pathSnaps.map((k) => [SNAP_SERIES[k] + 1, SNAP_NAME[k]])),
  }, 'Probability-weighted midpoint of the target range. The dashed line is today\'s midpoint. Values are in the Cut, hold or hike table.')}
    </div>`;

  register(block.querySelector('[data-fw-chart="path"]'), (c) => lineChart(c, {
    label: 'Line chart: expected target rate after each upcoming meeting, now, 1 week and 1 month ago. Values are in the Cut, hold or hike table.',
    xs: M.upcoming.map((_, i) => i),
    xPad: 12,
    xTicks: M.upcoming.map((iso, i) => ({ x: i, text: fmtMonthTick(iso) })),
    xLabel: (i) => fmtDate(M.upcoming[i]),
    series: pathSnaps.map((k) => ({
      name: SNAP_NAME[k],
      color: seriesColor(SNAP_SERIES[k]),
      markers: true,
      values: M.upcoming.map((iso) => (M.res[k].get(iso) ? M.res[k].get(iso).expectedRate : null)),
    })),
    yFmt: (v) => rate(v),
    yTickFmt: (v) => `${v.toFixed(2)}%`,
    ref: { value: CUR + FW.STEP / 2, text: `Today ${rate(CUR + FW.STEP / 2, 3)}` },
  }));
}

// ---------- dot plot ----------
function renderDots(block, M) {
  const dp = M.D.dotPlot;
  const yearEnd = (year) => {
    const last = M.upcoming.filter((iso) => iso.startsWith(`${year}-`)).pop();
    return last && M.res.now.get(last) ? M.res.now.get(last).expectedRate : null;
  };
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const groups = Object.entries(dp.dots).map(([label, dots]) => ({
    label, dots, median: median(dots), implied: /^\d{4}$/.test(label) ? yearEnd(label) : null,
  }));
  const sample = M.D.sample ? 'Sample projections' : 'Projections';
  block.innerHTML = `
    <div class="cme-row">
      <div class="cme-col-lg-8">${chartPanel('dots', `${sample}, ${fmtDate(dp.meeting)} meeting`, {
    axis: 'Year end',
    legend: legend([[1, 'FOMC participant'], [2, 'Futures-implied'], [3, 'FOMC median']]),
  }, `${M.D.sample ? 'Sample projections, not the published Summary of Economic Projections. ' : ''}Futures-implied values are the expected rate after the last meeting of each year that has a futures price.`)}</div>
      <div class="cme-col-lg-4">
        <div class="cme-table-wrap">
          <table class="cme-table">
            <caption class="cme-visually-hidden">${sample}: FOMC median and futures-implied rate by year end</caption>
            <thead><tr><th scope="col">Year end</th><th scope="col">FOMC median</th><th scope="col">Futures</th></tr></thead>
            <tbody>${groups.map((g) => `<tr><td class="cme-table__name">${esc(g.label)}</td><td class="cme-num">${rate(g.median, 3)}</td><td class="cme-num">${g.implied === null ? '—' : rate(g.implied)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  register(block.querySelector('[data-fw-chart="dots"]'), (c) => dotChart(c, {
    label: 'Dot plot: each FOMC participant\'s projected year-end target rate, the median, and the futures-implied rate. The table next to the chart lists the medians and futures values.',
    groups,
  }));
}

// ---------- page-wide events (wired once) ----------
function download(name, body) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let wired = false;
function wire(M) {
  if (wired) return;
  wired = true;
  const select = (iso) => {
    if (!M.res.now.has(iso) || iso === M.meeting) return;
    M.meeting = iso;
    M.views.forEach((fn) => fn());
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('meeting', iso);
      window.history.replaceState(null, '', u);
    } catch (e) { /* sandboxed: the selection still works */ }
  };
  document.addEventListener('cme:change', (e) => {
    const { detail } = e;
    if (!detail) return;
    if (detail.type === 'select' && e.target.querySelector?.('#fw-meeting-menu')) select(detail.value);
    if (detail.type === 'tab') requestAnimationFrame(redrawAll);
  });
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-fw-meeting]');
    if (link) select(link.getAttribute('data-fw-meeting'));
    const dl = e.target.closest('[data-fw-download]');
    if (dl) {
      const which = dl.getAttribute('data-fw-download');
      if (which === 'history') download(`fedwatch-history-${M.meeting}.csv`, M.csv.history);
      if (which === 'matrix') download(`fedwatch-probabilities-${M.NOW.asOf}.csv`, M.csv.matrix);
    }
  });
  window.addEventListener('load', redrawAll); // web fonts change text widths
  if (document.fonts) document.fonts.ready.then(redrawAll);
}

const VIEWS = {
  hero: renderHero, tool: renderTool, meetings: renderMeetings, 'dot-plot': renderDots,
};

export default async function decorate(block) {
  const author = keyedRows(block);
  const variant = Object.keys(VIEWS).find((v) => block.classList.contains(v)) || 'tool';
  // a link (or a /path or https:// URL) to the data; anything else means the built-in sample
  const dataCell = author.get('data');
  const typed = text(dataCell);
  const dataUrl = dataCell?.querySelector('a')?.getAttribute('href')
    || (/^(\/|https?:\/\/)/.test(typed) ? typed : '');
  block.replaceChildren();
  try {
    const M = await loadModel(dataUrl);
    VIEWS[variant](block, M, author);
    wire(M);
  } catch (e) {
    block.replaceChildren(el(
      'div',
      { class: 'cme-empty', role: 'status' },
      el('h3', { class: 'cme-empty__title' }, 'FedWatch data is unavailable'),
      el('p', { class: 'cme-empty__text' }, 'The probabilities could not be loaded. Try again in a few minutes.'),
    ));
    // eslint-disable-next-line no-console
    console.error(e);
  }
}
