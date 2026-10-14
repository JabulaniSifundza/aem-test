/**
 * The chart widget (spec §2 chart, requirements P-9 to P-19): toolbar, drawing tools, legend,
 * buy/sell buttons, footer scale controls, and the trading on the chart (order and position lines
 * that can be dragged and cancelled, execution marks). The plot itself is a ChartAdapter, so this
 * file does not change when the licensed TradingView library replaces uPlot.
 *
 * Flow, the way TradingView's own widget drives a datafeed:
 *   load(): resolveSymbol → getBars(countBack 400) → chart.setData → subscribeBars (live ticks
 *           build the last bar: chart.updateBar) → getMarks (own executions).
 *   The chart asks for older bars (needHistory) as the user scrolls left: loadHistory()
 *   prepends another 400. Every load bumps `loadSeq`, so answers to a superseded request
 *   (the user switched symbol mid-flight) are dropped.
 *   Trading lines come from the broker's cache via host events (order, position), not from REST;
 *   dragging a line modifies the order, its × cancels it.
 *   Edits to drawings and indicators are kept on an undo stack and in the widget's params, so
 *   the workspace restores them (persist()).
 */
import { el, icon, iconButton, frameFor } from '../ui/dom.js';
import { dialog, toast, confirm, openMenu, field, stepper, promptText, switchField } from '../ui/feedback.js';
import { formatPrice, formatQty, formatMoney, formatCompact, signClass, LABELS } from '../ui/format.js';
import { createChart, CHART_TYPES, DRAWING_TOOLS, TIME_ZONES } from '../chart/adapter.js';
import { timeFull } from '../chart/scale.js';
import { INDICATORS, getIndicator } from '../chart/indicators/index.js';
import { RESOLUTIONS, resolutionToMs, isIntraday } from '../../shared/resolution.js';
import { isFinal } from '../../shared/protocol.js';
import { D } from '../../shared/decimal.js';
import { symbolDef, symbolSelect, watchQuotes, placeOrder, cancelOrder, errorText } from './common.js';
import { closePositionDialog } from './account.js';

/** @typedef {import('./common.js').AppContext} AppContext */
/** @typedef {import('../chart/adapter.js').ChartAdapter} ChartAdapter */
/** @typedef {import('../chart/adapter.js').ChartState} ChartState */
/** @typedef {import('../chart/adapter.js').ChartLine} ChartLine */
/** @typedef {import('../broker/host.js').Order} Order */
/** @typedef {import('../broker/host.js').Position} Position */

const RES_LABELS = /** @type {Record<string, string>} */ ({ 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h', '1D': '1D', '1W': '1W', '1M': '1M' });
export const resLabel = (/** @type {string} */ r) => RES_LABELS[r] ?? r;
const TYPE_SHORT = /** @type {Record<string, string>} */ ({ MARKET: 'MKT', LIMIT: 'LMT', STOP: 'STP', STOP_LIMIT: 'STP LMT', TRAILING_STOP: 'TRAIL' });
const BARS_PER_LOAD = 400;
const DAY_MS = 86_400_000;

/** Milliseconds of history that hold about `count` bars of this resolution. @param {string} res @param {number} count */
function spanFor(res, count) {
  if (res === '1M') return count * 31 * DAY_MS;
  const ms = resolutionToMs(res);
  // Stocks trade 6.5 of 24 hours on 5 of 7 days: ask for enough calendar time to fill the screen.
  return isIntraday(res) ? count * ms * 5 : count * ms * 1.5;
}

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function chartWidget(ctx) {
  return {
    kind: 'chart', icon: 'chart',
    title: (p) => `${p.symbol ?? 'BTCUSDT'} · ${resLabel(p.resolution ?? '1D')}`,
    create(container, params, api) {
      let symbol = /** @type {string} */ (params.symbol ?? 'BTCUSDT');
      let resolution = /** @type {string} */ (params.resolution ?? '1D');
      /** @type {ChartAdapter | null} */
      let chart = null;
      /** @type {Record<string, any> | null} */
      let info = null;
      let destroyed = false;
      let loadSeq = 0;
      let barsGuid = '';
      /** @type {number | undefined} */
      let savedChartId = params.chartId;
      // Only orders that can still show as a line are kept, by id: an order event is O(1) and
      // drawing the lines is O(live orders), however long the order history is.
      /** @type {Map<string, Order>} */ let liveOrders = new Map();
      /** @param {Order} o */
      const keepOrder = (o) => { if (isFinal(o.status) || o.status === 'PLACING') liveOrders.delete(o.id); else liveOrders.set(o.id, o); };
      /** @type {Position[]} */ let positions = [];
      /** @type {Record<string, any>} */ let quote = {};
      /** @type {Array<() => void>} */ const stops = [];
      /** @type {Array<Pick<ChartState, 'drawings' | 'indicators'>>} */ let undo = [];
      /** @type {Array<Pick<ChartState, 'drawings' | 'indicators'>>} */ let redo = [];
      /** @type {Pick<ChartState, 'drawings' | 'indicators'>} */
      let snap = { drawings: params.chart?.drawings ?? [], indicators: params.chart?.indicators ?? [] };

      const s = () => symbolDef(symbol);
      const tickNum = () => Number(s().tick);
      /** A tick-exact price string from a chart number. @param {number} p */
      const priceString = (p) => D(p).div(s().tick).round().mul(s().tick).toFixed(D(s().tick).decimalPlaces());

      // ---------------------------------------------------------------- toolbar
      const picker = symbolSelect({ value: symbol, className: 'cme-chart-toolbar__symbol', onChange: (v) => setSymbol(v) });
      picker.classList.add('ts-w-sm');
      const resBtn = el('button', { class: 'cme-chart-toolbar__btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Resolution' }, el('span', { class: 'cme-visually-hidden' }, 'Resolution: '), el('span', {}, resLabel(resolution)));
      const showRes = () => { /** @type {HTMLElement} */ (resBtn.lastElementChild).textContent = resLabel(resolution); };
      resBtn.addEventListener('click', () => openMenu(resBtn, RESOLUTIONS.map((r) => ({ label: resLabel(r), checked: r === resolution, onSelect: () => setResolution(r) })), { label: 'Resolution' }));
      const typeBtn = el('button', { class: 'cme-chart-toolbar__btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Chart type', title: 'Chart type' }, icon('candles'));
      typeBtn.addEventListener('click', () => {
        const cur = chart?.getState().type;
        openMenu(typeBtn, CHART_TYPES.map((t) => ({ label: t.label, checked: t.id === cur, onSelect: () => { chart?.configure({ type: t.id }); typeBtn.replaceChildren(icon(t.id === 'line' || t.id === 'area' ? 'line-chart' : 'candles')); persist(); } })), { label: 'Chart type' });
      });
      const indBtn = el('button', { class: 'cme-chart-toolbar__btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Indicators', title: 'Indicators' }, icon('indicators'));
      indBtn.addEventListener('click', () => openMenu(indBtn, INDICATORS.map((ind) => ({ label: ind.name, onSelect: () => addIndicator(ind.id) })), { label: 'Add indicator' }));
      const tplBtn = el('button', { class: 'cme-chart-toolbar__btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Templates', title: 'Indicator templates' }, icon('layout'));
      tplBtn.addEventListener('click', () => templatesMenu());
      const undoBtn = iconButton('undo', 'Undo', { class: 'cme-chart-toolbar__btn', disabled: true, onclick: () => step(-1) });
      const redoBtn = iconButton('redo', 'Redo', { class: 'cme-chart-toolbar__btn', disabled: true, onclick: () => step(1) });
      const saveBtn = el('button', { class: 'cme-chart-toolbar__btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Save or load chart', title: 'Save or load chart' }, icon('save'));
      saveBtn.addEventListener('click', () => saveMenu());
      const shotBtn = iconButton('camera', 'Take a screenshot', { class: 'cme-chart-toolbar__btn', onclick: () => screenshot() });
      const propsBtn = iconButton('gear', 'Chart settings', { class: 'cme-chart-toolbar__btn', onclick: () => propertiesDialog() });
      const sep = () => el('span', { class: 'cme-chart-toolbar__sep' });
      const toolbar = el('div', { class: 'cme-chart-toolbar', role: 'toolbar', 'aria-label': 'Chart' },
        picker, resBtn, sep(), typeBtn, indBtn, tplBtn, sep(), undoBtn, redoBtn, el('span', { class: 'ts-spacer' }), saveBtn, shotBtn, propsBtn);

      // ---------------------------------------------------------------- drawing tools
      /** @type {Map<string, HTMLButtonElement>} */
      const toolButtons = new Map();
      const tools = el('div', { class: 'cme-chart-tools', role: 'toolbar', 'aria-label': 'Drawing tools', 'aria-orientation': 'vertical' });
      for (const t of DRAWING_TOOLS) {
        const b = /** @type {HTMLButtonElement} */ (iconButton(t.icon, t.label, { 'aria-pressed': String(t.id === 'cursor'), onclick: () => chart?.setTool(t.id) }));
        toolButtons.set(t.id, b);
        tools.append(b);
      }
      tools.append(iconButton('trash', 'Remove all drawings', {
        onclick: async () => {
          if (!chart?.getState().drawings.length) return;
          if (await confirm({ title: 'Remove drawings', text: 'Remove every drawing from this chart?', confirm: 'Remove', kind: 'danger' })) { record({ drawings: [] }); chart.configure({ drawings: [] }); }
        },
      }));

      // ---------------------------------------------------------------- legend and trade buttons
      const live = el('span', { class: 'cme-chart-legend__live', role: 'img', 'aria-label': 'Live' });
      const legendTitle = el('span', {});
      const ohlc = el('div', { class: 'cme-chart-legend__ohlc', 'aria-live': 'off' });
      const seriesRows = el('div', { class: 'ts-chart-legend__series' });
      const sellPrice = el('span', { class: 'cme-trade-pair__price' }, '–');
      const buyPrice = el('span', { class: 'cme-trade-pair__price' }, '–');
      const spread = el('span', { class: 'cme-trade-pair__spread', title: 'Spread' }, '–');
      const atMarket = () => el('span', { class: 'cme-visually-hidden' }, ' at market');
      const sellBtn = el('button', { class: 'cme-trade-pair__btn cme-trade-pair__btn--sell', type: 'button', onclick: () => quickOrder('SELL') }, sellPrice, el('span', { class: 'cme-trade-pair__side' }, 'Sell'), atMarket());
      const buyBtn = el('button', { class: 'cme-trade-pair__btn cme-trade-pair__btn--buy', type: 'button', onclick: () => quickOrder('BUY') }, buyPrice, el('span', { class: 'cme-trade-pair__side' }, 'Buy'), atMarket());
      const qty = stepper({ name: 'qty', value: params.qty ?? s().minQty, step: s().lot, min: s().minQty, max: s().maxQty, label: 'Order quantity' });
      qty.node.classList.add('ts-chart-qty');
      const legend = el('div', { class: 'cme-chart-legend' },
        el('div', { class: 'cme-chart-legend__title' }, legendTitle, live), ohlc,
        el('div', { class: 'ts-chart-trade' }, el('div', { class: 'cme-trade-pair' }, sellBtn, spread, buyBtn), qty.node),
        seriesRows);
      const host = el('div', { class: 'ts-chart-host' });
      const plot = el('div', { class: 'cme-tchart__plot' }, legend, host);

      // ---------------------------------------------------------------- footer
      /** @param {string} label @param {string} title @param {() => void} onclick */
      const toggle = (label, title, onclick) => el('button', { class: 'cme-chart-toolbar__btn', type: 'button', 'aria-pressed': 'false', title, onclick }, label);
      const pctBtn = toggle('%', 'Percent scale', () => { chart?.configure({ percent: !chart.getState().percent }); syncFooter(); persist(); });
      const logBtn = toggle('log', 'Logarithmic scale', () => { chart?.configure({ log: !chart.getState().log }); syncFooter(); persist(); });
      const autoBtn = toggle('auto', 'Fit the price scale to the visible bars', () => { chart?.configure({ autoScale: true }); syncFooter(); });
      const clock = el('span', { class: 'ts-chart-clock' });
      const footer = el('div', { class: 'cme-tchart__footer' },
        clock, el('span', { class: 'ts-spacer' }),
        iconButton('recenter', 'Go to the latest bar', { class: 'cme-chart-toolbar__btn', onclick: () => chart?.resetView() }), pctBtn, logBtn, autoBtn);
      function syncFooter() {
        const st = chart?.getState();
        if (!st) return;
        pctBtn.setAttribute('aria-pressed', String(st.percent));
        logBtn.setAttribute('aria-pressed', String(st.log));
        autoBtn.setAttribute('aria-pressed', String(st.autoScale));
      }

      const rootEl = el('div', { class: 'cme-tchart' }, toolbar, el('div', { class: 'cme-tchart__body' }, tools, plot), footer);
      container.append(rootEl);
      rootEl.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); step(-1); } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); step(1); }
      });

      // ---------------------------------------------------------------- legend content
      function drawTitle() {
        legendTitle.textContent = `${symbol} · ${resLabel(resolution)} · ${s().type === 'crypto' ? 'CRYPTO' : s().exchange.toUpperCase()}`;
        const open = quote.market_open !== false;
        live.className = `cme-chart-legend__live${open ? '' : ' cme-chart-legend__live--closed'}`;
        live.setAttribute('aria-label', open ? 'Market open' : 'Market closed');
      }

      /** @param {import('../chart/indicators/index.js').Bar | null} bar */
      function drawOhlc(bar) {
        if (!bar) { ohlc.replaceChildren(); return; }
        const cls = bar.close >= bar.open ? 'cme-gain' : 'cme-loss';
        /** @param {string} k @param {string} v */
        const item = (k, v) => el('span', {}, el('b', {}, k), ' ', el('span', { class: cls }, v));
        const change = bar.close - bar.open;
        ohlc.replaceChildren(item('O', formatPrice(symbol, bar.open)), item('H', formatPrice(symbol, bar.high)), item('L', formatPrice(symbol, bar.low)),
          item('C', formatPrice(symbol, bar.close)), item('', `${formatPrice(symbol, change, true)} (${formatPctNum((change / bar.open) * 100)})`), item('V', formatCompact(bar.volume)));
      }
      /** @param {number} p */
      const formatPctNum = (p) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(2)}%`;

      /** @param {Array<{ key: string, name: string, value: number | null, color: string }>} values */
      function drawSeries(values) {
        if (!chart) return;
        const list = chart.listIndicators().filter((i) => i.pane !== 'oscillator');
        seriesRows.replaceChildren(...list.map((inst) => {
          const vals = values.filter((v) => v.key === inst.key && v.value !== null);
          return el('div', { class: 'cme-chart-legend__series' },
            el('span', { class: 'ts-swatch', style: `background: ${inst.color}`, 'aria-hidden': 'true' }),
            el('span', {}, inst.title),
            ...vals.map((v) => el('span', { class: 'cme-num' }, formatPrice(symbol, v.value))),
            iconButton('gear', `Settings for ${inst.title}`, { class: 'cme-icon-btn--sm', onclick: () => editIndicator(inst.key) }, 'sm'),
            iconButton('close', `Remove ${inst.title}`, { class: 'cme-icon-btn--sm', onclick: () => removeIndicator(inst.key) }, 'sm'));
        }));
      }

      // ---------------------------------------------------------------- undo / redo
      /** Call before a change made here (the adapter reports its own changes through events). @param {Partial<Pick<ChartState, 'drawings' | 'indicators'>>} next */
      function record(next) {
        undo.push(snap);
        redo = [];
        snap = { ...snap, ...structuredClone(next) };
        syncUndo();
      }
      function syncUndo() {
        undoBtn.disabled = !undo.length;
        redoBtn.disabled = !redo.length;
        persist();
      }
      /** @param {-1 | 1} dir */
      function step(dir) {
        const from = dir < 0 ? undo : redo, to = dir < 0 ? redo : undo;
        const target = from.pop();
        if (!target || !chart) return;
        to.push(snap);
        snap = target;
        chart.configure(structuredClone(target));
        syncUndo();
      }

      // ---------------------------------------------------------------- indicators
      /** @param {string} id */
      function addIndicator(id) {
        if (!chart) return;
        const def = getIndicator(id);
        const cur = chart.getState().indicators;
        if (def?.pane !== 'oscillator' && cur.filter((i) => getIndicator(i.id)?.pane !== 'oscillator').length >= 4) {
          toast({ title: 'Four overlays at most', text: 'Remove one to add another: each overlay keeps its own colour.', type: 'info' });
          return;
        }
        const next = [...cur, { id, params: { ...def?.defaults } }];
        record({ indicators: next });
        chart.configure({ indicators: next });
      }
      /** @param {string} key */
      function removeIndicator(key) {
        if (!chart) return;
        const keys = chart.listIndicators().map((i) => i.key);
        const next = chart.getState().indicators.filter((_, i) => keys[i] !== key);
        record({ indicators: next });
        chart.configure({ indicators: next });
      }
      /** @param {string} key */
      async function editIndicator(key) {
        if (!chart) return;
        const list = chart.listIndicators();
        const k = list.findIndex((i) => i.key === key);
        const inst = list[k];
        if (!inst) return;
        const PARAM_LABELS = /** @type {Record<string, string>} */ ({ length: 'Length', k: 'Standard deviations', fast: 'Fast length', slow: 'Slow length', signal: 'Signal length', rows: 'Rows' });
        const inputs = Object.entries(inst.params).map(([name, value]) => {
          const label = PARAM_LABELS[name] ?? name;
          return { name, label, st: stepper({ name, value: String(value), step: name === 'k' ? '0.1' : '1', min: name === 'k' ? '0.1' : '1', label }) };
        });
        /** @type {Record<string, number>} */
        const params = {};
        const v = await dialog({
          title: `${inst.title} settings`,
          body: inputs.map((i) => field(i.label, i.st.node)),
          buttons: [{ label: 'Cancel', value: 'cancel', kind: 'outline' }, { label: 'Apply', value: 'ok', submit: true }],
          onSubmit: () => {
            for (const i of inputs) {
              const n = Number(i.st.input.value.replace(/,/g, ''));
              if (!(n > 0) || n > 500) return `${i.label} must be between 1 and 500.`;
              params[i.name] = i.name === 'k' ? n : Math.round(n);
            }
            return null;
          },
        });
        if (v !== 'ok') return;
        const next = chart.getState().indicators.map((x, i) => (i === k ? { ...x, params } : x));
        record({ indicators: next });
        chart.configure({ indicators: next });
      }

      async function templatesMenu() {
        /** @type {Array<{ name: string }>} */
        let list = [];
        try { list = await ctx.storage.getAllStudyTemplates(); } catch { /* offline: show the save option only */ }
        openMenu(tplBtn, [
          { label: 'Save indicators as template…', disabled: !chart?.getState().indicators.length, onSelect: saveTemplate },
          ...(list.length ? /** @type {const} */ (['separator']) : []),
          ...list.map((t) => ({ label: `Apply “${t.name}”`, onSelect: () => applyTemplate(t.name) })),
          ...(list.length ? /** @type {const} */ (['separator']) : []),
          ...list.map((t) => ({ label: `Delete “${t.name}”`, danger: true, onSelect: () => deleteTemplate(t.name) })),
        ], { label: 'Indicator templates' });
      }
      async function saveTemplate() {
        const name = await promptText({ title: 'Save indicator template', label: 'Template name', confirm: 'Save' });
        if (!name || !chart) return;
        try {
          await ctx.storage.saveStudyTemplate({ name, content: JSON.stringify({ indicators: chart.getState().indicators }) });
          toast({ title: 'Template saved', text: name, type: 'success' });
        } catch (error) { toast({ title: 'Could not save the template', text: errorText(error), type: 'error' }); }
      }
      /** @param {string} name */
      async function applyTemplate(name) {
        try {
          const content = JSON.parse(await ctx.storage.getStudyTemplateContent({ name }));
          const next = (content.indicators ?? []).filter((/** @type {any} */ i) => getIndicator(i.id));
          record({ indicators: next });
          chart?.configure({ indicators: next });
        } catch (error) { toast({ title: 'Could not load the template', text: errorText(error), type: 'error' }); }
      }
      /** @param {string} name */
      async function deleteTemplate(name) {
        if (!(await confirm({ title: 'Delete template', text: `Delete the template “${name}”?`, confirm: 'Delete', kind: 'danger' }))) return;
        try { await ctx.storage.removeStudyTemplate({ name }); } catch (error) { toast({ title: 'Could not delete', text: errorText(error), type: 'error' }); }
      }

      // ---------------------------------------------------------------- save / load (P-18, P-19)
      const layoutContent = () => JSON.stringify({ symbol, resolution, state: chart?.getState() });
      function saveMenu() {
        openMenu(saveBtn, [
          { label: savedChartId === undefined ? 'Save chart…' : 'Save chart', onSelect: () => saveChart(false) },
          { label: 'Save chart as…', onSelect: () => saveChart(true) },
          { label: 'Open a saved chart…', onSelect: loadDialog },
        ], { align: 'right', label: 'Save or load chart' });
      }
      /** @param {boolean} asNew */
      async function saveChart(asNew) {
        let name = params.chartName;
        if (asNew || savedChartId === undefined || !name) {
          name = await promptText({ title: asNew ? 'Save chart as' : 'Save chart', label: 'Chart name', value: asNew ? '' : `${symbol} ${resLabel(resolution)}`, confirm: 'Save' });
          if (!name) return;
        }
        try {
          savedChartId = await ctx.storage.saveChart({ id: asNew ? undefined : savedChartId, name, content: layoutContent(), symbol, resolution });
          api.setParams({ chartId: savedChartId, chartName: name });
          toast({ title: 'Chart saved', text: name, type: 'success' });
        } catch (error) { toast({ title: 'Could not save the chart', text: errorText(error), type: 'error' }); }
      }
      async function loadDialog() {
        let list;
        try { list = (await ctx.storage.getAllCharts()).filter((c) => c.symbol !== '__app__').sort((a, b) => b.timestamp - a.timestamp); } catch (error) { toast({ title: 'Could not list charts', text: errorText(error), type: 'error' }); return; }
        if (!list.length) { toast({ title: 'No saved charts', text: 'Save a chart first.', type: 'info' }); return; }
        /** @type {number | null} */
        let pick = null;
        const rows = el('ul', { class: 'cme-tnews' }, ...list.map((c) => el('li', { class: 'cme-tnews__item ts-row-actions' },
          el('div', { class: 'ts-spacer' }, el('p', { class: 'cme-tnews__title' }, c.name), el('p', { class: 'cme-tnews__meta' }, `${c.symbol} · ${resLabel(c.resolution)} · ${new Date(c.timestamp * (c.timestamp < 1e12 ? 1000 : 1)).toLocaleString()}`)),
          el('button', { class: 'cme-tbtn cme-tbtn--outline', type: 'button', 'data-cme-close': '', onclick: () => { pick = c.id; } }, 'Open'),
          iconButton('trash', `Delete ${c.name}`, {
            onclick: async (/** @type {Event} */ e) => {
              const li = /** @type {HTMLElement} */ (e.currentTarget).closest('li');
              try { await ctx.storage.removeChart(c.id); li?.remove(); if (savedChartId === c.id) { savedChartId = undefined; api.setParams({ chartId: undefined }); } } catch (error) { toast({ title: 'Could not delete', text: errorText(error), type: 'error' }); }
            },
          }))));
        await dialog({ title: 'Saved charts', body: rows, width: '440px' });
        if (pick === null) return;
        try {
          const content = JSON.parse(await ctx.storage.getChartContent(pick));
          const meta = list.find((c) => c.id === pick);
          savedChartId = pick;
          api.setParams({ chartId: pick, chartName: meta?.name });
          snap = { drawings: content.state?.drawings ?? [], indicators: content.state?.indicators ?? [] };
          undo = []; redo = [];
          syncUndo();
          chart?.configure(content.state ?? {});
          syncFooter();
          if (content.symbol !== symbol || content.resolution !== resolution) { symbol = content.symbol; resolution = content.resolution; picker.value = symbol; showRes(); load(); }
        } catch (error) { toast({ title: 'Could not open the chart', text: errorText(error), type: 'error' }); }
      }

      async function screenshot() {
        const blob = await chart?.screenshot();
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const stamp = new Date(ctx.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const a = el('a', { href: url, download: `${symbol}-${resLabel(resolution)}-${stamp}.png` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      async function propertiesDialog() {
        if (!chart) return;
        const st = chart.getState();
        const vol = switchField({ label: 'Volume', checked: st.show.volume }), grid = switchField({ label: 'Grid lines', checked: st.show.grid });
        const last = switchField({ label: 'Last price line', checked: st.show.lastPrice }), ex = switchField({ label: 'My executions', checked: st.show.executions });
        const type = el('select', { class: 'cme-tselect', 'aria-label': 'Chart type' }, ...CHART_TYPES.map((t) => el('option', { value: t.id, selected: t.id === st.type }, t.label)));
        const zone = el('select', { class: 'cme-tselect', 'aria-label': 'Time zone' }, ...TIME_ZONES.map((t) => el('option', { value: t.id, selected: t.id === st.timezone }, t.label)));
        const v = await dialog({
          title: 'Chart settings', body: [field('Chart type', type), field('Time zone', zone), vol.node, grid.node, last.node, ex.node],
          buttons: [{ label: 'Cancel', value: 'cancel', kind: 'outline' }, { label: 'Apply', value: 'ok' }],
        });
        if (v !== 'ok') return;
        chart.configure({ type: /** @type {any} */ (/** @type {HTMLSelectElement} */ (type).value), timezone: /** @type {HTMLSelectElement} */ (zone).value, show: { volume: vol.checked, grid: grid.checked, lastPrice: last.checked, executions: ex.checked } });
        persist();
      }

      // ---------------------------------------------------------------- trading from the chart
      const qtyValue = () => qty.input.value.replace(/,/g, '');
      /** @param {'BUY' | 'SELL'} side */
      function quickOrder(side) {
        placeOrder(ctx, { symbol, side, type: 'MARKET', qty: qtyValue(), duration: 'GTC' }, { quick: true });
      }

      function refreshLines() {
        if (!chart) return;
        /** @type {ChartLine[]} */
        const lines = [];
        for (const o of liveOrders.values()) {
          if (o.symbol !== symbol) continue;
          const usesStop = o.type === 'STOP' || o.type === 'TRAILING_STOP' || (o.type === 'STOP_LIMIT' && !o.triggered);
          const price = usesStop ? o.stopPrice : o.limitPrice;
          if (!price) continue;
          const remaining = formatQty(symbol, D(o.qty).minus(o.filledQty).toString());
          const side = o.side === 'BUY' ? 'buy' : 'sell';
          if (o.bracket) {
            lines.push({
              id: `o:${o.id}`, price: Number(price), kind: o.bracket === 'stopLoss' ? 'stop-loss' : 'take-profit', side,
              label: `${o.bracket === 'stopLoss' ? 'SL' : 'TP'} ${remaining}`, draggable: o.type !== 'TRAILING_STOP', cancellable: o.parentType === 'position',
            });
          } else {
            lines.push({
              id: `o:${o.id}`, price: Number(price), kind: 'order', side, label: `${LABELS.side[o.side]} ${TYPE_SHORT[o.type]} ${remaining}`,
              draggable: o.type !== 'MARKET' && o.type !== 'TRAILING_STOP', cancellable: true,
            });
          }
        }
        for (const p of positions) {
          if (p.symbol !== symbol || D(p.qty).isZero()) continue;
          lines.push({
            id: `p:${p.id}`, price: Number(p.avgPrice), kind: 'position', side: p.side === 'BUY' ? 'buy' : 'sell',
            label: `${p.side === 'BUY' ? 'Long' : 'Short'} ${formatQty(symbol, p.qty)}`, text: formatMoney(p.unrealizedPL, true),
            tone: signClass(p.unrealizedPL) === 'cme-gain' ? 'gain' : signClass(p.unrealizedPL) === 'cme-loss' ? 'loss' : undefined, cancellable: true,
          });
        }
        chart.setLines(lines);
      }

      async function refreshTrading() {
        const [all, open] = await Promise.all([ctx.broker.orders(), ctx.broker.positions()]);
        liveOrders = new Map();
        for (const o of all) keepOrder(o);
        positions = open;
        refreshLines();
      }

      /** @param {string} id @param {number} price */
      async function onLineDrag(id, price) {
        const order = id.startsWith('o:') ? liveOrders.get(id.slice(2)) : undefined; // order lines are "o:<order id>"
        if (!order) { refreshLines(); return; }
        const p = priceString(price);
        if (!ctx.settings.oneClick) {
          const ok = await confirm({ title: 'Move order', text: `Move ${order.bracket === 'stopLoss' ? 'the stop loss' : order.bracket === 'takeProfit' ? 'the take profit' : `the ${LABELS.side[order.side].toLowerCase()} ${LABELS.type[order.type].toLowerCase()} order`} to ${formatPrice(symbol, p)}?`, confirm: 'Move' });
          if (!ok) { refreshLines(); return; }
        }
        try {
          if (order.bracket && order.parentType === 'position' && order.parentId) {
            const pos = positions.find((x) => x.id === order.parentId);
            await ctx.broker.editPositionBrackets(order.parentId, {
              stopLoss: order.bracket === 'stopLoss' ? p : pos?.stopLoss ?? null,
              takeProfit: order.bracket === 'takeProfit' ? p : pos?.takeProfit ?? null,
              trailingStopPips: pos?.trailingStopPips ?? null,
            });
          } else if (order.bracket && order.parentId) {
            await ctx.broker.modifyOrder({ id: order.parentId, [order.bracket]: p });
          } else {
            const usesStop = order.type === 'STOP' || (order.type === 'STOP_LIMIT' && !order.triggered);
            await ctx.broker.modifyOrder(usesStop ? { id: order.id, stopPrice: p } : { id: order.id, limitPrice: p });
          }
        } catch (error) {
          toast({ title: 'Could not move the order', text: errorText(error), type: 'error' });
        }
        await refreshTrading();
      }

      /** @param {string} id */
      async function onLineCancel(id) {
        const order = id.startsWith('o:') ? liveOrders.get(id.slice(2)) : undefined; // order lines are "o:<order id>"
        const position = positions.find((p) => `p:${p.id}` === id);
        if (position) {
          if (ctx.settings.oneClick) {
            try { await ctx.broker.closePosition(position.id); } catch (error) { toast({ title: 'Could not close', text: errorText(error), type: 'error' }); }
          } else await closePositionDialog(ctx, position);
          return;
        }
        if (!order) return;
        if (order.bracket && order.parentType === 'position' && order.parentId) {
          const what = order.bracket === 'stopLoss' ? 'stop loss' : 'take profit';
          if (!ctx.settings.oneClick && !(await confirm({ title: `Remove ${what}`, text: `Remove the ${what} from the ${symbol} position?`, confirm: 'Remove', kind: 'danger' }))) return;
          const pos = positions.find((x) => x.id === order.parentId);
          try {
            await ctx.broker.editPositionBrackets(order.parentId, {
              stopLoss: order.bracket === 'stopLoss' ? null : pos?.stopLoss ?? null,
              takeProfit: order.bracket === 'takeProfit' ? null : pos?.takeProfit ?? null,
              trailingStopPips: order.bracket === 'stopLoss' ? null : pos?.trailingStopPips ?? null,
            });
          } catch (error) { toast({ title: `Could not remove the ${what}`, text: errorText(error), type: 'error' }); }
          return;
        }
        await cancelOrder(ctx, order, { quick: true });
      }

      /** @param {{ price: number, x: number, y: number }} at */
      function contextMenu(at) {
        const last = Number(quote.lp ?? chart?.getBars().at(-1)?.close ?? at.price);
        const p = priceString(at.price);
        const shown = formatPrice(symbol, p);
        const below = at.price < last;
        const anchor = el('span', { style: `position: fixed; left: ${at.x}px; top: ${at.y}px; width: 1px; height: 1px`, tabindex: '-1' });
        container.append(anchor); // in the widget, so a popped-out chart's menu opens in its window
        const done = () => setTimeout(() => anchor.remove(), 0);
        /** @param {'BUY' | 'SELL'} side @param {'LIMIT' | 'STOP'} type */
        const order = (side, type) => { done(); placeOrder(ctx, { symbol, side, type, qty: qtyValue(), duration: 'GTC', ...(type === 'LIMIT' ? { limitPrice: p } : { stopPrice: p }) }); };
        openMenu(anchor, [
          below ? { label: `Buy limit ${formatQty(symbol, qtyValue())} at ${shown}`, onSelect: () => order('BUY', 'LIMIT') } : { label: `Sell limit ${formatQty(symbol, qtyValue())} at ${shown}`, onSelect: () => order('SELL', 'LIMIT') },
          below ? { label: `Sell stop ${formatQty(symbol, qtyValue())} at ${shown}`, onSelect: () => order('SELL', 'STOP') } : { label: `Buy stop ${formatQty(symbol, qtyValue())} at ${shown}`, onSelect: () => order('BUY', 'STOP') },
          { label: `Order ticket at ${shown}…`, onSelect: () => { done(); ctx.openTicket({ symbol, side: below ? 'BUY' : 'SELL', type: 'LIMIT', price: p }); } },
          'separator',
          { label: 'Reset chart view', onSelect: () => { done(); chart?.resetView(); } },
        ], { label: 'Chart actions' });
        container.ownerDocument.addEventListener('mousedown', done, { once: true });
      }

      // ---------------------------------------------------------------- data
      function unsubscribe() {
        if (barsGuid) ctx.datafeed.unsubscribeBars(barsGuid);
        barsGuid = '';
      }

      function load() {
        const seq = (loadSeq += 1);
        unsubscribe();
        drawTitle();
        ctx.datafeed.resolveSymbol(symbol, (si) => {
          if (destroyed || seq !== loadSeq) return;
          info = si;
          const to = Math.floor(ctx.now() / 1000);
          const from = Math.floor((ctx.now() - spanFor(resolution, BARS_PER_LOAD)) / 1000);
          ctx.datafeed.getBars(si, resolution, { from, to, countBack: BARS_PER_LOAD, firstDataRequest: true }, (bars) => {
            if (destroyed || seq !== loadSeq || !chart) return;
            chart.setData(bars, { symbol, resolution, intraday: isIntraday(resolution) });
            drawOhlc(bars.at(-1) ?? null);
            loadMarks();
            refreshLines();
            barsGuid = `chart:${api.id}:${seq}`;
            ctx.datafeed.subscribeBars(si, resolution, (bar) => { if (seq === loadSeq) chart?.updateBar(bar); }, barsGuid, () => { if (seq === loadSeq) load(); });
          }, (reason) => toast({ title: 'Could not load the chart', text: reason, type: 'error' }));
        }, (reason) => toast({ title: `Unknown symbol ${symbol}`, text: reason, type: 'error' }));
      }

      function loadHistory() {
        if (!chart || !info) return;
        const first = chart.getBars()[0];
        if (!first) return;
        const seq = loadSeq;
        const to = Math.floor(first.time / 1000) - 1;
        const from = Math.floor((first.time - spanFor(resolution, BARS_PER_LOAD)) / 1000);
        ctx.datafeed.getBars(info, resolution, { from, to, countBack: BARS_PER_LOAD, firstDataRequest: false }, (bars) => {
          if (seq === loadSeq) chart?.prependData(bars);
        }, () => { if (seq === loadSeq) chart?.prependData([]); });
      }

      function loadMarks() {
        if (!chart || !info) return;
        const first = chart.getBars()[0];
        if (!first) return;
        ctx.datafeed.getMarks(info, Math.floor(first.time / 1000), Math.floor(ctx.now() / 1000) + 60, (marks) => {
          chart?.setMarks(marks.map((m) => ({ id: String(m.id), time: m.time * 1000, side: m.label === 'B' ? 'buy' : 'sell', text: m.text })));
        });
      }

      /** @param {string} next */
      function setSymbol(next) {
        symbol = next;
        const d = s();
        qty.node.dataset.step = d.lot; qty.node.dataset.min = d.minQty; qty.node.dataset.max = d.maxQty; qty.input.value = d.minQty;
        picker.value = symbol;
        api.setTitle(`${symbol} · ${resLabel(resolution)}`);
        api.setParams({ symbol });
        watchSymbol();
        load();
      }
      /** @param {string} next */
      function setResolution(next) {
        resolution = next;
        showRes();
        api.setTitle(`${symbol} · ${resLabel(resolution)}`);
        api.setParams({ resolution });
        load();
      }

      let stopQuotes = () => {};
      function watchSymbol() {
        stopQuotes();
        quote = {};
        stopQuotes = watchQuotes(ctx, [symbol], (q) => {
          if (q.n !== symbol || q.s !== 'ok') return;
          quote = { ...quote, ...q.v };
          sellPrice.textContent = formatPrice(symbol, quote.bid);
          buyPrice.textContent = formatPrice(symbol, quote.ask);
          spread.textContent = quote.bid !== undefined && quote.ask !== undefined ? formatPrice(symbol, D(quote.ask).minus(quote.bid).toString()) : '–';
          drawTitle();
        });
      }

      let persistTimer = 0;
      function persist() {
        clearTimeout(persistTimer);
        persistTimer = window.setTimeout(() => { if (chart && !destroyed) api.setParams({ chart: chart.getState(), qty: qtyValue() }); }, 400);
      }

      /** The short name of a zone at the current time (CDT, EST). @param {string} tz */
      const zoneName = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(ctx.now()).find((x) => x.type === 'timeZoneName')?.value ?? tz;
      const tickClock = () => {
        const tz = chart?.getState().timezone ?? 'UTC';
        clock.textContent = `${timeFull(ctx.now(), true, tz)}${tz === 'local' ? '' : ` ${tz === 'UTC' ? 'UTC' : zoneName(tz)}`}`;
      };
      tickClock();
      const clockTimer = setInterval(tickClock, 1000);

      // ---------------------------------------------------------------- start
      createChart({
        container: host,
        formatPrice: (p) => formatPrice(symbol, p),
        roundPrice: (p) => Number(priceString(p)),
        tick: tickNum(),
        state: params.chart,
      }).then((c) => {
        if (destroyed) { c.destroy(); return; }
        chart = c;
        c.on('crosshair', (x) => {
          drawOhlc(x.bar);
          drawSeries(x.indicators);
          ctx.emit('crosshair', { symbol, resolution, bar: x.bar, indicators: x.indicators.filter((i) => i.value !== null).map((i) => ({ name: i.name, value: formatPrice(symbol, i.value) })) });
        });
        c.on('needHistory', loadHistory);
        c.on('lineDrag', ({ id, price }) => { onLineDrag(id, price); });
        c.on('lineCancel', ({ id }) => { onLineCancel(id); });
        c.on('contextMenu', contextMenu);
        c.on('autoScaleChange', () => syncFooter());
        c.on('toolChange', (t) => { for (const [id, b] of toolButtons) b.setAttribute('aria-pressed', String(id === t)); });
        c.on('drawingsChange', (drawings) => { undo.push(snap); redo = []; snap = { ...snap, drawings }; syncUndo(); });
        c.on('indicatorsChange', (indicators) => { undo.push(snap); redo = []; snap = { ...snap, indicators }; syncUndo(); });
        c.configure(params.chart ?? {});
        syncFooter();
        stops.push(
          ctx.host.on('order', (o) => { keepOrder(o); if (o.symbol === symbol) refreshLines(); }),
          ctx.host.on('position', (p) => { const i = positions.findIndex((x) => x.id === p.id); if (i >= 0) positions[i] = p; else positions.push(p); if (p.symbol === symbol) refreshLines(); }),
          ctx.host.on('execution', (e) => { if (e.symbol === symbol) loadMarks(); }),
          ctx.host.on('reset', () => { refreshTrading(); loadMarks(); }),
          // On the next frame: a popped-out chart's window takes the theme from the page a moment
          // later (dock.js), and the chart reads its colours from the styles there.
          ctx.on('theme', () => { frameFor(container, () => c.setTheme()); }),
        );
        // P&L text on the position line follows the mark price.
        const plTimer = setInterval(async () => { if (positions.some((p) => p.symbol === symbol)) { positions = await ctx.broker.positions(); refreshLines(); } }, 1000);
        stops.push(() => clearInterval(plTimer));
        watchSymbol();
        refreshTrading();
        load();
      }, (error) => toast({ title: 'The chart could not start', text: errorText(error), type: 'error' }));

      return {
        destroy() {
          destroyed = true;
          unsubscribe();
          stopQuotes();
          clearInterval(clockTimer);
          clearTimeout(persistTimer);
          for (const stop of stops) stop();
          chart?.destroy();
        },
        state: () => ({ symbol, resolution, qty: qtyValue(), chart: chart?.getState() ?? params.chart, chartId: savedChartId, chartName: params.chartName }),
        resize: () => chart?.resize(),
        show: () => chart?.resize(),
      };
    },
  };
}
