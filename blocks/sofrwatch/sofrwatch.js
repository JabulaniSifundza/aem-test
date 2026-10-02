import {
  el, icon, text, keyedRows, cmeLink, exploreMenu,
} from '../../scripts/cme-dom.js';
import { lineChart, seriesColor } from '../../scripts/fedwatch/charts.js';
import {
  MON, parts, fmtDate, fmtLong, nbsp, esc, decisionUtc, register, redraw, redrawAll,
} from '../../scripts/fedwatch/model.js';
import { toUtc, addDays } from '../../scripts/sofrwatch/engine.js';
import {
  loadModel, setScenario, presetChanges, PRESETS,
} from '../../scripts/sofrwatch/model.js';

/*
 * SOFRWatch — where CME SOFR futures could settle if your view of the FOMC prevails, built
 * from design-language components (hero.md, forms.md, filter-dropdown.md, spec-panel.md,
 * facts-steps.md, tabs.md, table.md, chart.md with legend toggles).
 *   SOFRWatch (hero)      page hero with a countdown to the next FOMC decision.
 *                         Rows: Breadcrumb | link, Explore … | links, Title,
 *                         Actions | link (the hero's one bold link), Footnote
 *   SOFRWatch (scenario)  the workspace: a policy change for every meeting (FedWatch's most
 *                         likely path to start) and presets on the left; on the right, live,
 *                         everything they change: headline moves, the Three-month and One-month
 *                         settlement curves and the overnight SOFR path
 *   SOFRWatch (results)   every SR3 and SR1 contract (market vs your scenario), CSV download
 *                         and the spread assumptions
 * Any of them may carry a "Data" row with a link to a JSON file shaped like
 * /scripts/sofrwatch/sample-data.json; without a link the built-in, illustrative sample is used.
 */

const asOfText = (M) => `Data as of ${fmtDate(M.D.asOf)}${M.D.sample ? ' (sample)' : ''}`;
const q = (root, name) => root.querySelector(`[data-sw="${name}"]`);
const fmtD = (iso) => fmtDate(iso);
const rate2 = (r, dp = 2) => `${r.toFixed(dp)}%`;
const price = (p) => p.toFixed(4);
const bps = (x, dp = 1) => {
  const v = Math.abs(x) < 0.05 ? 0 : x;
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}`;
};
const quarterText = (c) => {
  const [ys, ms, ds] = parts(c.start);
  const [ye, me, de] = parts(c.end);
  const from = ys === ye ? `${ds} ${MON[ms - 1]}` : fmtD(c.start);
  return `${nbsp(from)} – ${nbsp(`${de} ${MON[me - 1]} ${ye}`)}`;
};
const monthText = (c) => { const [y, m] = parts(c.start); return `${MON[m - 1]} ${y}`; };
const shortCode = (code) => code.slice(-2);
const hiddenSeries = new WeakMap();
const hiddenOf = (canvas) => {
  if (!hiddenSeries.has(canvas)) hiddenSeries.set(canvas, new Set());
  return hiddenSeries.get(canvas);
};
const toggles = (items) => items.map(([i, t]) => `<li class="cme-series-${i}"><button type="button" aria-pressed="true" data-series="${esc(t)}">${esc(t)}</button></li>`).join('');

function chartPanel(key, title, axis, legendItems, note) {
  return `<figure class="cme-chart">
    <div class="cme-chart__header"><h3 class="cme-chart__title" id="sw-${key}-title">${esc(title)}</h3></div>
    <div class="cme-chart__canvas" data-sw-chart="${key}"></div>
    <div class="cme-chart__footer"><span class="cme-chart__axis-label">${esc(axis)}</span><ul class="cme-chart__legend" aria-label="Show or hide series">${toggles(legendItems)}</ul></div>
    ${note ? `<figcaption class="cme-chart__note">${esc(note)}</figcaption>` : ''}
  </figure>`;
}

/** Plain-language summary of a scenario. */
function scenarioSummary(M) {
  const moves = M.D.meetings.map((m, i) => ({ date: m.date, bp: M.scenario[i] }))
    .filter((x) => Math.abs(x.bp) >= 0.05);
  const net = M.scenario.reduce((a, b) => a + b, 0);
  const last = M.D.meetings[M.D.meetings.length - 1].date;
  if (!moves.length) return `No change at any meeting through ${fmtD(last)}`;
  const list = moves.length <= 3
    ? moves.map((x) => `${bps(x.bp, Number.isInteger(x.bp) ? 0 : 1)} bps on ${fmtD(x.date)}`).join(', ')
    : `${moves.length} moves`;
  return `${list} · net ${bps(net, Number.isInteger(net) ? 0 : 1)} bps by ${fmtD(last)}`;
}

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
  const { D } = M;
  const lastFix = D.fixings[D.asOf];
  const unit = (label, slot) => el(
    'li',
    { class: 'cme-fact' },
    el('span', { class: 'cme-fact__value', 'data-sw': slot }, '–'),
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
        el('h1', { class: 'cme-hero__title', id: 'sw-page-title' }, text(author.get('title')) || 'CME SOFRWatch'),
        el('p', { class: 'cme-lead' }, `Overnight SOFR fixed at ${rate2(lastFix)} on ${fmtD(D.asOf)}${D.sample ? ' (sample)' : ''}. Set your view of each FOMC meeting and see where SOFR futures would settle.`),
        cta ? el('a', { class: 'cme-link-bold', href: cta.getAttribute('href') }, icon('arrow-right'), el('span', { class: 'cme-link__text' }, text(cta))) : '',
      ),
      el(
        'div',
        {
          class: 'cme-col-md-6',
          'data-cme-gap': 'hero-countdown',
          'data-cme-gap-note': 'hero.md has no countdown slot; the countdown is two boxed facts (days; hours:minutes:seconds) in the right half of the page hero.',
        },
        el('p', { class: 'cme-overline', 'data-sw': 'hero-when' }),
        el(
          'div',
          { role: 'timer', 'data-sw': 'hero-timer' },
          el('ul', { class: 'cme-facts cme-facts--boxed' }, unit('Days', 'cd-d'), unit('Hours : minutes : seconds', 'cd-hms')),
        ),
        el('p', { class: 'cme-fine cme-mt-s cme-mb-0' }, [asOfText(M), ...notes].join(' · ')),
      ),
    ),
  );
  const section = block.closest('.section');
  if (section) {
    section.classList.add('cme-section--inverse', 'cme-inverse', 'cme-hero');
    section.setAttribute('role', 'region');
    section.setAttribute('aria-labelledby', 'sw-page-title');
  }
  const two = (n) => String(n).padStart(2, '0');
  let shownFor;
  const tick = () => {
    const next = D.meetings.map((m) => m.date).find((iso) => decisionUtc(iso) > Date.now()) || null;
    if (next !== shownFor) {
      shownFor = next;
      q(block, 'hero-when').textContent = next ? `${fmtLong(next)} · 2:00 PM ET` : 'No meetings scheduled in this data';
      if (next) q(block, 'hero-timer').setAttribute('aria-label', `Time until the FOMC decision on ${fmtLong(next)} at 2:00 PM ET`);
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

// ---------- shared pieces ----------
const PATH_LEGEND = [[1, 'Actual fixings'], [2, 'Your scenario'], [4, 'FedWatch expected path']];
const CURVE_LEGEND = [[2, 'Your scenario'], [3, 'Market']];
const largestGap = (rows) => rows.filter((r) => r.diffBp !== null)
  .reduce((a, b) => (Math.abs(b.diffBp) > Math.abs(a.diffBp) ? b : a));

/** The two curve charts (SR3 by quarter, SR1 by month): implied rate, your scenario vs market. */
function curveChart(c, rows, label, longName) {
  const hidden = hiddenOf(c);
  lineChart(c, {
    label,
    xs: rows.map((_, i) => i),
    xPad: 12,
    xTicks: rows.map((r, i) => ({ x: i, text: shortCode(r.code) })),
    xLabel: (i) => `${rows[i].code} · ${longName(rows[i]).replace(/\u00a0/g, ' ')}`,
    series: [
      {
        name: 'Your scenario', color: seriesColor(1), markers: true, values: rows.map((r) => r.impliedRate),
      },
      {
        name: 'Market', color: seriesColor(2), markers: true, values: rows.map((r) => r.marketRate),
      },
    ].map((sr) => ({ ...sr, hidden: hidden.has(sr.name) })),
    yFmt: (v) => rate2(v, 3),
    yTickFmt: (v) => `${v.toFixed(2)}%`,
  });
}

// ---------- scenario: inputs on the left, everything they change on the right ----------
function renderScenario(block, M, author) {
  const { D } = M;
  // the section heading is part of the block so the tool sits right under it (one screen)
  const title = text(author.get('title'));
  const intro = text(author.get('intro'));
  const field = (m, i) => `<div class="cme-col-md-3">
      <div class="cme-field" data-sw-field="${i}">
        <label class="cme-field__label" for="sw-m-${m.date}">${nbsp(fmtD(m.date))}</label>
        <input class="cme-input" id="sw-m-${m.date}" name="m${i}" type="number" step="any" inputmode="decimal" min="-500" max="500" value="${M.scenario[i]}" aria-describedby="sw-h-${m.date} sw-e-${m.date}">
        <p class="cme-fine cme-mb-0" id="sw-h-${m.date}"><span data-sw="hint-${i}"></span><span class="cme-visually-hidden" data-sw="fw-${i}"></span></p>
        <p class="cme-field__error" id="sw-e-${m.date}" hidden>Enter -500 to 500, e.g. -25.</p>
      </div>
    </div>`;
  block.innerHTML = `
    ${title ? `<h2 class="cme-mb-xs" id="sw-scenario-title">${esc(title)}</h2>` : ''}
    ${intro ? `<p class="cme-small">${esc(intro)}</p>` : ''}
    <div class="cme-row cme-row--wide" data-cme-gap="scenario-workspace" data-cme-gap-note="Inputs and the results they change sit side by side (7/5) so every edit is visible without scrolling at desktop widths; below 993px the results follow the inputs directly.">
      <div class="cme-col-md-7">
        <div class="cme-toolbar">
          <p class="cme-toolbar__count cme-mb-0" aria-live="polite" data-sw="summary"></p>
          <div class="cme-dropdown">
            <button class="cme-dropdown__trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="sw-presets" data-sw="preset-trigger"></button>
            <div class="cme-dropdown__menu" id="sw-presets" role="menu" hidden>
              ${Object.entries(PRESETS).map(([k, label]) => `<button class="cme-dropdown__item" role="menuitemradio" aria-checked="false" type="button" data-value="${k}" data-cme-select="Start from: ${label}">${label}</button>`).join('')}
            </div>
          </div>
        </div>
        <ul class="cme-facts cme-mb-s" data-sw="facts" aria-live="polite"></ul>
        <form data-sw="form" novalidate>
          <fieldset class="cme-fieldset">
            <legend class="cme-visually-hidden">Change at each FOMC meeting, in basis points: -25 is a cut, +25 a hike</legend>
            <div class="cme-row">${D.meetings.map(field).join('')}</div>
          </fieldset>
        </form>
      </div>
      <div class="cme-col-md-5">
        <div class="cme-tabs" role="tablist" aria-label="What your scenario changes">
          <button class="cme-tabs__tab is-active" role="tab" aria-selected="true" aria-controls="sw-live-sr3" id="sw-tab-live-sr3" type="button">Three-month</button>
          <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="sw-live-sr1" id="sw-tab-live-sr1" type="button">One-month</button>
          <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="sw-live-path" id="sw-tab-live-path" type="button">Overnight SOFR</button>
        </div>
        <div role="tabpanel" id="sw-live-sr3" aria-labelledby="sw-tab-live-sr3" class="cme-mt-s">
          ${chartPanel('curve', 'Three-month SOFR settlements', 'Contract', CURVE_LEGEND, '')}
        </div>
        <div role="tabpanel" id="sw-live-sr1" aria-labelledby="sw-tab-live-sr1" class="cme-mt-s" hidden>
          ${chartPanel('curve1', 'One-month SOFR settlements', 'Contract', CURVE_LEGEND, '')}
        </div>
        <div role="tabpanel" id="sw-live-path" aria-labelledby="sw-tab-live-path" class="cme-mt-s" hidden>
          ${chartPanel('path', 'Overnight SOFR: actual and implied', 'Date', PATH_LEGEND, '')}
        </div>
      </div>
    </div>`;

  // overnight SOFR chart x axis: weekly points from the first fixing to the end of the SR3 strip
  const first = Object.keys(D.fixings).sort()[0];
  const lastEnd = M.sr3[M.sr3.length - 1].end;
  const days = [];
  for (let t = toUtc(first); t <= toUtc(lastEnd); t += 7 * 864e5) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  if (!days.includes(D.asOf)) days.push(D.asOf);
  days.sort();

  const section = block.closest('.section');
  if (section && title) section.setAttribute('aria-labelledby', 'sw-scenario-title');
  const inputs = [...block.querySelectorAll('input[type="number"]')];
  const sync = () => {
    const { sr3, sr1, user } = M.results;
    const net = M.scenario.reduce((a, b) => a + b, 0);
    const lastDate = D.meetings[D.meetings.length - 1].date;
    q(block, 'summary').textContent = `Net ${bps(net, Number.isInteger(net) ? 0 : 1)} bps by ${fmtD(lastDate)}`;
    q(block, 'preset-trigger').textContent = `Start from: ${PRESETS[M.preset] || 'your own view'}`;
    block.querySelectorAll('#sw-presets [data-value]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === M.preset)));
    let range = D.targetLower;
    D.meetings.forEach((m, i) => {
      range += M.scenario[i] / 100;
      const ml = m.mostLikelyLower;
      const same = Math.abs(ml - range) < 1e-9;
      q(block, `hint-${i}`).textContent = `After: ${range.toFixed(2)}–${(range + 0.25).toFixed(2)}%`;
      q(block, `fw-${i}`).textContent = same ? ', same as FedWatch most likely' : `, FedWatch most likely ${ml.toFixed(2)} to ${(ml + 0.25).toFixed(2)}%`;
      if (document.activeElement !== inputs[i]) inputs[i].value = String(M.scenario[i]);
    });

    const g3 = largestGap(sr3);
    const g1 = largestGap(sr1);
    const endRate = user(addDays(D.meetings[D.meetings.length - 1].date, 2));
    const facts = [
      [rate2(endRate), 'Overnight SOFR at the end', `After ${fmtD(lastDate)}`],
      [bps(g3.diffBp), `Biggest move: ${g3.code}`, `bps vs market · settles ${price(g3.implied)}`],
      [bps(g1.diffBp), `Biggest move: ${g1.code}`, `bps vs market · settles ${price(g1.implied)}`],
    ];
    q(block, 'facts').innerHTML = facts.map(([v, l, note]) => `<li class="cme-fact"><span class="cme-fact__value">${esc(v)}</span><span class="cme-fact__label">${esc(l)}</span><span class="cme-fact__note">${esc(note)}</span></li>`).join('');

    register(block.querySelector('[data-sw-chart="curve"]'), (c) => curveChart(c, sr3, 'Line chart: Three-Month SOFR implied rates by contract, your scenario against the market. Focus the chart and use the arrow keys to read each contract.', quarterText));
    register(block.querySelector('[data-sw-chart="curve1"]'), (c) => curveChart(c, sr1, 'Line chart: One-Month SOFR implied rates by contract, your scenario against the market. Focus the chart and use the arrow keys to read each contract.', monthText));
    register(block.querySelector('[data-sw-chart="path"]'), (c) => {
      const hidden = hiddenOf(c);
      const { market } = M.results;
      const ticks = days.filter((d) => d.slice(8) <= '07' && ['01', '07'].includes(d.slice(5, 7)))
        .map((d) => { const [y, m] = parts(d); return { x: toUtc(d), text: `${MON[m - 1]} ’${String(y).slice(2)}` }; });
      lineChart(c, {
        label: 'Line chart: overnight SOFR actual fixings, the path your scenario implies and FedWatch’s expected path. Focus the chart and use the arrow keys to read each week.',
        xs: days.map(toUtc),
        xTicks: ticks,
        xLabel: (i) => `Week of ${fmtD(days[i])}`,
        series: [
          { name: 'Actual fixings', color: seriesColor(0), values: days.map((d) => (d <= D.asOf ? user(d) : null)) },
          { name: 'Your scenario', color: seriesColor(1), values: days.map((d) => (d >= D.asOf ? user(d) : null)) },
          { name: 'FedWatch expected path', color: seriesColor(3), values: days.map((d) => (d >= D.asOf ? market(d) : null)) },
        ].map((sr) => ({ ...sr, hidden: hidden.has(sr.name) })),
        yFmt: (v) => rate2(v, 3),
        yTickFmt: (v) => `${v.toFixed(2)}%`,
      });
    });
  };
  M.views.add(sync);
  sync();

  let timer;
  const read = () => {
    let valid = true;
    const values = inputs.map((inp) => {
      const v = inp.value.trim() === '' ? 0 : Number(inp.value);
      const bad = !Number.isFinite(v) || v < -500 || v > 500;
      const fieldEl = inp.closest('.cme-field');
      fieldEl.classList.toggle('cme-field--error', bad);
      if (bad) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
      fieldEl.querySelector('.cme-field__error').hidden = !bad;
      if (bad) valid = false;
      return bad ? null : v;
    });
    if (valid) setScenario(M, values, null);
    else q(block, 'summary').textContent = 'Fix the highlighted meeting to update the results.';
  };
  block.querySelector('form').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(read, 150);
  });
  // arrow keys step a whole 25 bp move (the field still accepts any value, e.g. 12.5)
  block.querySelector('form').addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown'].includes(e.key) || !e.target.matches('input[type="number"]')) return;
    e.preventDefault();
    const v = Number(e.target.value) || 0;
    e.target.value = String(v + (e.key === 'ArrowUp' ? 25 : -25));
    e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  block.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
}

// ---------- details: every contract, and the starting assumptions ----------
function renderResults(block, M) {
  const { D } = M;
  const lower = D.targetLower;
  const spreadBp = D.spreads.effrToLowerBp + D.spreads.sofrToEffrBp;
  const spec = [
    ['Target range today', `${lower.toFixed(2)}–${(lower + 0.25).toFixed(2)}%`],
    ['Last decision', `${bps(D.lastDecision.changeBp, 0)} bps`, `on ${fmtD(D.lastDecision.date)}`],
    ['EFFR minus lower bound', `${bps(D.spreads.effrToLowerBp, 0)} bps`],
    ['SOFR minus EFFR', `${bps(D.spreads.sofrToEffrBp, 0)} bps`, '3-month average'],
    ['Implied overnight SOFR', rate2(lower + spreadBp / 100), 'before any change'],
    ['Last SOFR fixing', rate2(D.fixings[D.asOf]), `on ${fmtD(D.asOf)}`],
  ];
  block.innerHTML = `
    <div class="cme-row">
      <div class="cme-col-lg-8">
        <p class="cme-small" data-sw="line"></p>
        <div class="cme-toolbar" data-cme-gap="tabs-with-action" data-cme-gap-note="Content tabs with a download action on the same line; used the result toolbar layout to hold both.">
          <div class="cme-tabs" role="tablist" aria-label="Settlement tables">
            <button class="cme-tabs__tab is-active" role="tab" aria-selected="true" aria-controls="sw-sr3" id="sw-tab-sr3" type="button">Three-month</button>
            <button class="cme-tabs__tab" role="tab" aria-selected="false" aria-controls="sw-sr1" id="sw-tab-sr1" type="button">One-month</button>
          </div>
          <button class="cme-btn cme-btn--secondary" type="button" data-sw-download><span class="cme-icon cme-icon--download" aria-hidden="true"></span>Download results</button>
        </div>
        <div role="tabpanel" id="sw-sr3" aria-labelledby="sw-tab-sr3">
          <div class="cme-table-wrap" role="region" aria-label="Three-Month SOFR table, scrolls sideways">
            <table class="cme-table">
              <caption class="cme-visually-hidden">Three-Month SOFR futures: market price and the settlement your scenario implies</caption>
              <thead><tr><th scope="col">Contract</th><th scope="col">Reference quarter</th><th scope="col">Market price</th><th scope="col">Your scenario</th><th scope="col">Difference (bps)</th><th scope="col">Implied rate</th></tr></thead>
              <tbody data-sw="sr3-body"></tbody>
            </table>
          </div>
        </div>
        <div role="tabpanel" id="sw-sr1" aria-labelledby="sw-tab-sr1" hidden>
          <div class="cme-table-wrap" role="region" aria-label="One-Month SOFR table, scrolls sideways">
            <table class="cme-table">
              <caption class="cme-visually-hidden">One-Month SOFR futures: market price and the settlement your scenario implies</caption>
              <thead><tr><th scope="col">Contract</th><th scope="col">Month</th><th scope="col">Market price</th><th scope="col">Your scenario</th><th scope="col">Difference (bps)</th><th scope="col">Implied rate</th></tr></thead>
              <tbody data-sw="sr1-body"></tbody>
            </table>
          </div>
        </div>
        <p class="cme-fine cme-mt-s cme-mb-0">A positive difference means the contract would settle above today's market price under your scenario. Contracts in their reference period use actual fixings to date.</p>
      </div>
      <div class="cme-col-lg-4">
        <div class="cme-spec">
          <div class="cme-spec__header"><h3 class="cme-spec__title">Starting point</h3></div>
          <ul class="cme-spec__list">${spec.map(([l, v, unit]) => `<li><h4 class="cme-spec__label">${l}</h4><p class="cme-spec__value"><span class="cme-data-md">${esc(v)}</span>${unit ? ` ${esc(unit)}` : ''}</p></li>`).join('')}</ul>
          <p class="cme-spec__updated">The spread between the lower bound and overnight SOFR is held constant. ${esc(asOfText(M))}.</p>
        </div>
      </div>
    </div>`;

  const row = (r, period) => {
    const diff = r.diffBp;
    const cls = diff === null || Math.abs(diff) < 0.05 ? '' : ` ${diff > 0 ? 'cme-gain' : 'cme-loss'}`;
    return `<tr><td class="cme-table__name">${r.code}</td><td class="cme-table__text">${period}${r.running ? ' (running)' : ''}</td><td class="cme-num">${r.market === undefined ? '—' : price(r.market)}</td><td class="cme-num">${price(r.implied)}</td><td class="cme-num${cls}">${diff === null ? '—' : bps(diff)}</td><td class="cme-num">${rate2(r.impliedRate, 3)}</td></tr>`;
  };
  const draw = () => {
    const { sr3, sr1 } = M.results;
    q(block, 'sr3-body').innerHTML = sr3.map((r) => row(r, quarterText(r))).join('');
    q(block, 'sr1-body').innerHTML = sr1.map((r) => row(r, monthText(r))).join('');
    q(block, 'line').innerHTML = `Your scenario: ${esc(scenarioSummary(M))} · <a href="#scenario">Change your scenario</a>`;
    const head = [
      ['# CME SOFRWatch scenario export'],
      [`# Data as of ${D.asOf}${D.sample ? ' - ILLUSTRATIVE SAMPLE DATA, not market data' : ''}`],
      [`# Lower bound ${D.targetLower.toFixed(2)}%; EFFR - lower bound ${D.spreads.effrToLowerBp} bp; SOFR - EFFR ${D.spreads.sofrToEffrBp} bp (held constant)`],
      [`# Scenario (bp per FOMC meeting): ${D.meetings.map((m, i) => `${m.date} ${M.scenario[i]}`).join('; ')}`],
    ];
    M.csv = head.concat([['Contract', 'Reference start', 'Reference end', 'Market price', 'Your scenario', 'Difference (bps)', 'Implied rate (%)']]
      .concat([...sr3, ...sr1].map((r) => [r.code, r.start, r.end, r.market ?? '', r.implied.toFixed(4), r.diffBp === null ? '' : r.diffBp.toFixed(2), r.impliedRate.toFixed(4)]))).map((x) => x.join(',')).join('\n');
  };
  M.views.add(draw);
  draw();
}

// ---------- page-wide events ----------
let wired = false;
function wire(M) {
  if (wired) return;
  wired = true;
  document.addEventListener('cme:change', (e) => {
    const { detail } = e;
    if (!detail) return;
    if (detail.type === 'select' && e.target.querySelector?.('#sw-presets')) {
      setScenario(M, presetChanges(M, detail.value), detail.value);
    }
    if (detail.type === 'tab') requestAnimationFrame(redrawAll);
    if (detail.type === 'legend') {
      const canvas = e.target.closest('.cme-chart')?.querySelector('[data-sw-chart]');
      if (!canvas) return;
      const hidden = hiddenOf(canvas);
      if (detail.shown) hidden.delete(detail.series); else hidden.add(detail.series);
      redraw(canvas);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-sw-download]')) return;
    const url = URL.createObjectURL(new Blob([M.csv], { type: 'text/csv' }));
    const a = el('a', { href: url, download: `sofrwatch-scenario-${M.D.asOf}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener('load', redrawAll);
  if (document.fonts) document.fonts.ready.then(redrawAll);
}

const VIEWS = { hero: renderHero, scenario: renderScenario, results: renderResults };

export default async function decorate(block) {
  const author = keyedRows(block);
  const variant = Object.keys(VIEWS).find((v) => block.classList.contains(v)) || 'results';
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
      el('h3', { class: 'cme-empty__title' }, 'SOFRWatch data is unavailable'),
      el('p', { class: 'cme-empty__text' }, 'The settlement scenarios could not be loaded. Try again in a few minutes.'),
    ));
    // eslint-disable-next-line no-console
    console.error(e);
  }
}
