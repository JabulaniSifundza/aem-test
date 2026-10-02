import {
  el, icon, text, keyedRows, cmeLink, exploreMenu,
} from '../../scripts/cme-dom.js';
import * as FW from '../../scripts/fedwatch/engine.js';
import {
  barChart, lineChart, dotChart, seriesColor, pct, rate,
} from '../../scripts/fedwatch/charts.js';
import {
  MON, MONTH, parts, utc, fmtDate, fmtLong, fmtMonthTick, nbsp, signed, rangeText, esc,
  decisionUtc, zqCode, SNAPS, SNAP_NAME, SNAP_SERIES, loadModel, pAt, best, rangesFor,
  register, redraw, redrawAll,
} from '../../scripts/fedwatch/model.js';

/*
 * FedWatch v2 — CME FedWatch laid out like the live tool, within design language v1.1:
 * dates first (meeting tabs), then the meeting's information and probabilities, then the
 * charts. Every chart legend toggles its series (chart.md, website standard).
 *   FedWatch v2 (hero)      page hero with a countdown to the next FOMC decision.
 *                           Rows: Breadcrumb | link, Explore … | links, Title,
 *                           Actions | link (becomes the hero's one bold link), Footnote
 *   FedWatch v2 (tool)      meeting tabs → facts, meeting information, probability table → charts
 *   FedWatch v2 (meetings)  probability matrix / cut-hold-hike tables → expected rate path
 *   FedWatch v2 (dot-plot)  medians table → FOMC dot plot against futures-implied rates
 * Any of them may carry a "Data" row with a link to a JSON file shaped like
 * /scripts/fedwatch/sample-data.json; without a link the built-in, illustrative sample is used.
 * Tabs, dropdowns and legend toggles are scripts/cme.js behaviours; this block listens for
 * cme:change and redraws.
 */

const q = (root, name) => root.querySelector(`[data-fw="${name}"]`);
const hiddenSeries = new WeakMap(); // chart canvas -> Set of hidden series names
const hiddenOf = (canvas) => {
  if (!hiddenSeries.has(canvas)) hiddenSeries.set(canvas, new Set());
  return hiddenSeries.get(canvas);
};

function chartPanel(key, title, footer, note) {
  return `<figure class="cme-chart">
    <div class="cme-chart__header"><h3 class="cme-chart__title" id="fw-${key}-title" data-fw="${key}-title">${esc(title)}</h3>${footer.action || ''}</div>
    <div class="cme-chart__canvas" data-fw-chart="${key}"></div>
    <div class="cme-chart__footer"><span class="cme-chart__axis-label">${esc(footer.axis)}</span>${footer.legend || ''}</div>
    <figcaption class="cme-chart__note" data-fw="${key}-note">${esc(note)}</figcaption>
  </figure>`;
}
/** Legend whose entries toggle their series (items: [series index 1-4, name]). */
const toggles = (items) => items.map(([i, t]) => `<li class="cme-series-${i}"><button type="button" aria-pressed="true" data-series="${esc(t)}">${esc(t)}</button></li>`).join('');
const legend = (items, slot) => `<ul class="cme-chart__legend" aria-label="Show or hide series"${slot ? ` data-fw="${slot}"` : ''}>${toggles(items)}</ul>`;

// ---------- hero: countdown to the next decision ----------
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
    const label = text(author.get(exploreKey).parentElement.firstElementChild);
    const menu = exploreMenu(label, [...author.get(exploreKey).querySelectorAll('a')]);
    if (menu) nav.push(menu);
  }
  const cta = author.get('actions')?.querySelector('a');
  const notes = author.get('footnote') ? [...author.get('footnote').querySelectorAll('p')].map(text).filter(Boolean) : [];
  if (!notes.length && text(author.get('footnote'))) notes.push(text(author.get('footnote')));
  const unit = (label, slot) => el(
    'li',
    { class: 'cme-fact' },
    el('span', { class: 'cme-fact__value', 'data-fw': slot }, '–'),
    el('span', { class: 'cme-fact__label' }, label),
  );

  block.replaceChildren(
    nav.length ? el('div', { class: 'cme-hero__nav' }, nav) : '',
    el(
      'div',
      { class: 'cme-row cme-row--wide cme-row--align-center' },
      el(
        'div',
        { class: 'cme-col-md-6' },
        el('p', { class: 'cme-eyebrow cme-hero__eyebrow' }, 'Next FOMC decision'),
        el('h1', { class: 'cme-hero__title', id: 'fw-page-title' }, text(author.get('title')) || 'CME FedWatch'),
        el('p', { class: 'cme-lead', 'data-fw': 'hero-lead' }),
        cta ? el(
          'a',
          { class: 'cme-link-bold', href: cta.getAttribute('href') },
          icon('arrow-right'),
          el('span', { class: 'cme-link__text' }, text(cta)),
        ) : '',
      ),
      el(
        'div',
        {
          class: 'cme-col-md-6',
          'data-cme-gap': 'hero-countdown',
          'data-cme-gap-note': 'hero.md has no countdown slot. The page hero keeps its left-half content; the right half holds the countdown as two boxed facts (days; hours:minutes:seconds), cme-facts--boxed being documented for key numbers on dark surfaces.',
        },
        el('p', { class: 'cme-overline', 'data-fw': 'hero-when' }),
        el(
          'ul',
          { class: 'cme-facts cme-facts--boxed', role: 'timer', 'data-fw': 'hero-timer' },
          unit('Days', 'cd-d'),
          unit('Hours : minutes : seconds', 'cd-hms'),
        ),
        el('p', { class: 'cme-fine cme-mt-s cme-mb-0' }, [M.asOfText, ...notes].join(' · ')),
      ),
    ),
  );
  const section = block.closest('.section');
  if (section) {
    section.classList.add('cme-section--inverse', 'cme-inverse', 'cme-hero');
    section.setAttribute('aria-labelledby', 'fw-page-title');
  }

  const two = (n) => String(n).padStart(2, '0');
  let shownFor = '';
  const tick = () => {
    const next = M.upcoming.find((iso) => decisionUtc(iso) > Date.now()) || null;
    if (next !== shownFor) {
      shownFor = next;
      if (!next) {
        q(block, 'hero-when').textContent = 'No meetings scheduled in this data';
        q(block, 'hero-lead').textContent = `The current target range is ${M.CUR.toFixed(2)}–${(M.CUR + FW.STEP).toFixed(2)}%.`;
      } else {
        const [lower, p] = best(M.res.now.get(next).dist);
        let what = 'no change';
        if (lower > M.CUR + 1e-9) what = `a hike to ${rangeText(lower)} bps`;
        if (lower < M.CUR - 1e-9) what = `a cut to ${rangeText(lower)} bps`;
        q(block, 'hero-when').textContent = `${fmtLong(next)} · 2:00 PM ET`;
        q(block, 'hero-lead').textContent = `Futures price a ${pct(p)} chance of ${what} from today's ${M.CUR.toFixed(2)}–${(M.CUR + FW.STEP).toFixed(2)}% target range.`;
        q(block, 'hero-timer').setAttribute('aria-label', `Time until the FOMC decision on ${fmtLong(next)} at 2:00 PM ET`);
      }
    }
    const ms = next ? Math.max(0, decisionUtc(next) - Date.now()) : 0;
    q(block, 'cd-d').textContent = String(Math.floor(ms / 864e5));
    q(block, 'cd-hms').textContent = [
      Math.floor((ms % 864e5) / 36e5), Math.floor((ms % 36e5) / 6e4), Math.floor((ms % 6e4) / 1e3),
    ].map(two).join(':');
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- tool: dates → information and probabilities → charts ----------
function meetingPanel(M, iso) {
  const { CUR, NOW } = M;
  const r = M.res.now.get(iso);
  const [y, m] = parts(iso);
  const i = M.upcoming.indexOf(iso);
  const days = Math.round((utc(iso) - utc(NOW.asOf)) / 864e5);
  const split = FW.outcomeSplit(r.dist, CUR);
  const facts = [
    [pct(split.cut), 'Cut'], [pct(split.hold), 'No change'], [pct(split.hike), 'Hike'],
    [rate(r.expectedRate), 'Expected rate', 'Probability-weighted midpoint'],
  ];
  const spec = [
    ['Decision', `${fmtLong(iso)}, 2:00 PM ET`],
    ['Futures contract', zqCode(r.zq.month), `30-Day Fed Funds, ${MON[m - 1]} ${y}`],
    ['Futures price', r.zq.price.toFixed(4)],
    ['Implied average rate', rate(r.zq.avg, 3), `for ${MONTH[m - 1]}`],
    ['Implied change at meeting', signed(r.expectedChange * 100), 'bps'],
    ['Days to meeting', String(days), `from ${fmtDate(NOW.asOf)}`],
  ];
  const byS = SNAPS.map((k) => M.res[k].get(iso) || null);
  const ranges = rangesFor(byS, [CUR]);
  const top = best(r.dist)[0];
  const rows = ranges.map((l) => {
    const now = pct(pAt(r, l));
    const name = `${rangeText(l)}${Math.abs(l - CUR) < 1e-9 ? ' (current)' : ''}`;
    return `<tr><td class="cme-table__name">${name}</td><td class="cme-num">${Math.abs(l - top) < 1e-9 ? `<strong>${now}</strong>` : now}</td>${
      byS.slice(1).map((s) => `<td class="cme-num">${s ? pct(pAt(s, l)) : '—'}</td>`).join('')}</tr>`;
  }).join('');
  return `<div role="tabpanel" id="fw2-m-${iso}" aria-labelledby="fw2-t-${iso}" class="cme-mt-m"${iso === M.meeting ? '' : ' hidden'}>
    <p class="cme-small cme-mb-s">Meeting ${i + 1} of ${M.upcoming.length}${M.sep.has(iso) ? ' · with the Summary of Economic Projections' : ''}</p>
    <ul class="cme-facts">${facts.map(([v, l, note]) => `<li class="cme-fact"><span class="cme-fact__value">${v}</span><span class="cme-fact__label">${l}</span>${note ? `<span class="cme-fact__note">${note}</span>` : ''}</li>`).join('')}</ul>
    <div class="cme-row cme-mt-m">
      <div class="cme-col-lg-4">
        <div class="cme-spec">
          <div class="cme-spec__header">
            <h3 class="cme-spec__title">Meeting information</h3>
            <a class="cme-link" href="https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.contractSpecs.html"><span class="cme-link__text">Contract specs</span></a>
          </div>
          <ul class="cme-spec__list">${spec.map(([l, v, unit], j) => `<li><h4 class="cme-spec__label">${l}</h4><p class="cme-spec__value">${
    j === 0 ? esc(v) : `<span class="cme-data-md">${esc(v)}</span>${unit ? ` ${esc(unit)}` : ''}`}</p></li>`).join('')}</ul>
          <p class="cme-spec__updated">${esc(M.asOfText)}</p>
        </div>
      </div>
      <div class="cme-col-lg-8">
        <h3 class="cme-h4">Target rate probabilities for ${fmtDate(iso)}</h3>
        <div class="cme-table-wrap">
          <table class="cme-table" data-cme-gap="table-cell-emphasis" data-cme-gap-note="Most likely range in bold; table.md has no highlight cell.">
            <caption class="cme-visually-hidden">Probability of each target range after the ${fmtDate(iso)} meeting, now and earlier. The most likely range now is in bold.</caption>
            <thead><tr><th scope="col">Target rate (bps)</th>${SNAPS.map((k) => `<th scope="col">${SNAP_NAME[k]}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;
}

function renderTool(block, M) {
  const tabLabel = (iso) => { const [y, m, d] = parts(iso); return `${d} ${MON[m - 1]} ’${String(y).slice(2)}`; };
  block.innerHTML = `
    <div class="cme-tabs" role="tablist" aria-label="FOMC meeting dates" data-cme-gap="meeting-tabs" data-cme-gap-note="${M.upcoming.length} meetings; tabs.md allows 3–8 tabs. The bar scrolls sideways on small screens, like the live tool's meeting tabs.">
      ${M.upcoming.map((iso) => `<button class="cme-tabs__tab${iso === M.meeting ? ' is-active' : ''}" role="tab" type="button" id="fw2-t-${iso}" aria-controls="fw2-m-${iso}" aria-selected="${iso === M.meeting}" aria-label="${fmtLong(iso)}${M.sep.has(iso) ? ', with projections' : ''}">${tabLabel(iso)}</button>`).join('')}
    </div>
    ${M.upcoming.map((iso) => meetingPanel(M, iso)).join('')}
    <h3 class="cme-mt-l" data-fw="viz-title"></h3>
    <div class="cme-tabs" role="tablist" aria-label="Chart views">
      <button class="cme-tabs__tab is-active" role="tab" aria-selected="true" aria-controls="fw2-view-current" id="fw2-tab-current" type="button">Current</button>
      <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="fw2-view-compare" id="fw2-tab-compare" type="button">Compare</button>
      <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="fw2-view-history" id="fw2-tab-history" type="button">History</button>
    </div>
    <div role="tabpanel" id="fw2-view-current" aria-labelledby="fw2-tab-current" class="cme-mt-m">
      ${chartPanel('current', '', { axis: 'Target rate (bps)' }, `${M.asOfText}. Hover over or focus a bar to read its value.`)}
    </div>
    <div role="tabpanel" id="fw2-view-compare" aria-labelledby="fw2-tab-compare" class="cme-mt-m" hidden>
      ${chartPanel('compare', '', { axis: 'Target rate (bps)', legend: legend(SNAPS.map((k) => [SNAP_SERIES[k] + 1, SNAP_NAME[k]])) }, 'Select a period in the legend to show or hide it. The values are in the table above.')}
    </div>
    <div role="tabpanel" id="fw2-view-history" aria-labelledby="fw2-tab-history" class="cme-mt-m" hidden>
      ${chartPanel('history', '', {
    axis: 'Week',
    legend: legend([], 'history-legend'),
    action: '<button class="cme-link" type="button" data-fw-download="history"><span class="cme-icon cme-icon--download" aria-hidden="true"></span><span class="cme-link__text">Download CSV</span></button>',
  }, 'Weekly prices, sample data. Select a range in the legend to show or hide it; lines start when the sample first has a price for the meeting month. Focus the chart and use the arrow keys to read each week.')}
    </div>`;

  const canvas = (key) => block.querySelector(`[data-fw-chart="${key}"]`);
  const draw = () => {
    const { meeting, CUR } = M;
    const r = M.res.now.get(meeting);
    const name = fmtDate(meeting);
    const catOf = (lower) => ({ text: rangeText(lower), sub: Math.abs(lower - CUR) < 1e-9 ? 'Current' : '' });
    q(block, 'viz-title').textContent = `Charts for the ${name} meeting`;
    q(block, 'current-title').textContent = `Target rate probabilities for ${name}`;
    q(block, 'compare-title').textContent = `How expectations moved for ${name}`;
    q(block, 'history-title').textContent = `Probability history for ${name}`;

    const curRanges = rangesFor([r], [CUR]);
    register(canvas('current'), (c) => barChart(c, {
      label: `Bar chart: target rate probabilities for ${name}. Each bar can be focused to read its value.`,
      categories: curRanges.map(catOf),
      series: [{ name: 'Probability', color: seriesColor(0), values: curRanges.map((l) => pAt(r, l)) }],
      valueLabels: true,
    }));

    const byS = SNAPS.map((k) => M.res[k].get(meeting) || null);
    const cmpRanges = rangesFor(byS, [CUR]);
    register(canvas('compare'), (c) => barChart(c, {
      label: `Grouped bar chart: probabilities for ${name} now, 1 day, 1 week and 1 month ago. The probability table above lists the values.`,
      categories: cmpRanges.map(catOf),
      series: SNAPS.map((k, j) => ({
        name: SNAP_NAME[k],
        color: seriesColor(SNAP_SERIES[k]),
        hidden: hiddenOf(c).has(SNAP_NAME[k]),
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
    hiddenOf(canvas('history')).clear(); // a new meeting brings new ranges: show them all
    q(block, 'history-legend').innerHTML = toggles(series.map((sr) => [sr.idx + 1, sr.name]));
    M.csv.history = [['Week'].concat(series.map((s) => s.name.replace('–', '-')))]
      .concat(M.historyRes.map((h, j) => [h.asOf].concat(series.map((s) => (s.values[j] === null ? '' : (s.values[j] * 100).toFixed(2))))))
      .map((row) => row.join(',')).join('\n');
    const xs = M.historyRes.map((h) => utc(h.asOf));
    const xTicks = [];
    M.historyRes.forEach((h, j) => {
      const [, mo, d] = parts(h.asOf);
      if (d <= 7 && (mo - 1) % 2 === 0) xTicks.push({ x: xs[j], text: fmtMonthTick(h.asOf) });
    });
    register(canvas('history'), (c) => lineChart(c, {
      label: `Line chart: weekly probability history for the ${name} meeting. Focus the chart and use the arrow keys to read each week.`,
      xs,
      xTicks,
      xLabel: (j) => `Week of ${fmtDate(M.historyRes[j].asOf)}`,
      series: series.map((s) => ({ ...s, hidden: hiddenOf(c).has(s.name) })),
      yFmt: pct,
      yTickFmt: (v) => `${Math.round(v * 100)}%`,
      yMin: 0,
      yMax: 1,
    }));
  };
  M.views.add(draw);
  draw();
}

// ---------- every meeting: tables → rate path ----------
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
    <div class="cme-toolbar cme-mt-m" data-cme-gap="tabs-with-action" data-cme-gap-note="Content tabs with a download action on the same line; used the result toolbar layout to hold both.">
      <div class="cme-tabs" role="tablist" aria-label="Meeting tables">
        <button class="cme-tabs__tab is-active" role="tab" aria-selected="true" aria-controls="fw2-all-matrix" id="fw2-tab-matrix" type="button">Probabilities</button>
        <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="fw2-all-split" id="fw2-tab-split" type="button">Cut, hold or hike</button>
      </div>
      <button class="cme-btn cme-btn--secondary" type="button" data-fw-download="matrix"><span class="cme-icon cme-icon--download" aria-hidden="true"></span>Download probabilities</button>
    </div>
    <div role="tabpanel" id="fw2-all-matrix" aria-labelledby="fw2-tab-matrix">
      <div class="cme-table-wrap">
        <table class="cme-table" data-cme-gap="table-cell-emphasis" data-cme-gap-note="Most likely range in each row in bold; table.md has no highlight cell.">
          <caption class="cme-visually-hidden">Probability of each target range after every upcoming FOMC meeting. The most likely range in each row is in bold.</caption>
          <thead><tr><th scope="col">Meeting</th>${head}</tr></thead>
          <tbody>${matrix}</tbody>
        </table>
      </div>
      <p class="cme-fine cme-mt-s cme-mb-0">Select a meeting to open it in the tool above. Ranges in basis points.</p>
    </div>
    <div role="tabpanel" id="fw2-all-split" aria-labelledby="fw2-tab-split" hidden>
      <div class="cme-table-wrap">
        <table class="cme-table">
          <caption class="cme-visually-hidden">Probability of a lower, unchanged or higher target range after each meeting, compared with today's range</caption>
          <thead><tr><th scope="col">Meeting</th><th scope="col">Lower than today</th><th scope="col">Unchanged</th><th scope="col">Higher than today</th><th scope="col">Expected rate</th><th scope="col">Versus today (bps)</th></tr></thead>
          <tbody>${split}</tbody>
        </table>
      </div>
    </div>
    <div class="cme-mt-l">
      ${chartPanel('path', 'Expected target rate after each meeting', {
    axis: 'FOMC meeting',
    legend: legend(pathSnaps.map((k) => [SNAP_SERIES[k] + 1, SNAP_NAME[k]])),
  }, 'Probability-weighted midpoint of the target range; the dashed line is today\'s midpoint. Select a period in the legend to show or hide it. Values are in the Cut, hold or hike table.')}
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
      hidden: hiddenOf(c).has(SNAP_NAME[k]),
      values: M.upcoming.map((iso) => (M.res[k].get(iso) ? M.res[k].get(iso).expectedRate : null)),
    })),
    yFmt: (v) => rate(v),
    yTickFmt: (v) => `${v.toFixed(2)}%`,
    ref: { value: CUR + FW.STEP / 2, text: `Today ${rate(CUR + FW.STEP / 2, 3)}` },
  }));
}

// ---------- dot plot: table → chart ----------
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
  const KEYS = { 'FOMC participant': 'dots', 'Futures-implied': 'implied', 'FOMC median': 'median' };
  block.innerHTML = `
    <div class="cme-row">
      <div class="cme-col-lg-4">
        <h3 class="cme-h4">Year-end rates</h3>
        <div class="cme-table-wrap">
          <table class="cme-table">
            <caption class="cme-visually-hidden">${sample}: FOMC median and futures-implied rate by year end</caption>
            <thead><tr><th scope="col">Year end</th><th scope="col">FOMC median</th><th scope="col">Futures</th></tr></thead>
            <tbody>${groups.map((g) => `<tr><td class="cme-table__name">${esc(g.label)}</td><td class="cme-num">${rate(g.median, 3)}</td><td class="cme-num">${g.implied === null ? '—' : rate(g.implied)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="cme-fine cme-mt-s">Futures values are the expected rate after the last meeting of each year that has a futures price.</p>
      </div>
      <div class="cme-col-lg-8">${chartPanel('dots', `${sample}, ${fmtDate(dp.meeting)} meeting`, {
    axis: 'Year end',
    legend: legend(Object.keys(KEYS).map((t, i) => [i + 1, t])),
  }, `${M.D.sample ? 'Sample projections, not the published Summary of Economic Projections. ' : ''}Select an item in the legend to show or hide it.`)}</div>
    </div>`;
  register(block.querySelector('[data-fw-chart="dots"]'), (c) => {
    const hidden = hiddenOf(c);
    const show = Object.fromEntries(Object.entries(KEYS).map(([t, k]) => [k, !hidden.has(t)]));
    dotChart(c, {
      label: 'Dot plot: each FOMC participant\'s projected year-end target rate, the median, and the futures-implied rate. The table beside the chart lists the medians and futures values.',
      groups,
      show,
    });
  });
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
    if (detail.type === 'tab' && /^fw2-t-/.test(detail.id)) select(detail.id.slice(6));
    if (detail.type === 'tab') requestAnimationFrame(redrawAll);
    if (detail.type === 'legend') {
      const canvas = e.target.closest('.cme-chart')?.querySelector('[data-fw-chart]');
      if (!canvas) return;
      const hidden = hiddenOf(canvas);
      if (detail.shown) hidden.delete(detail.series); else hidden.add(detail.series);
      redraw(canvas);
    }
  });
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-fw-meeting]');
    if (link) document.getElementById(`fw2-t-${link.getAttribute('data-fw-meeting')}`)?.click();
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
