/**
 * The chart adapter on uPlot (DECISIONS D6). uPlot draws axes, grid, line series and the cursor;
 * everything a trading chart adds (candles, volume, trading lines, marks, drawings, panes) is
 * drawn here, in uPlot's hooks, from the same state the TradingView adapter would receive.
 *
 * The x axis is the bar index, so nights, weekends and market holidays leave no gaps; labels are
 * the bars' times. Live updates are batched to one redraw per animation frame.
 */
import uPlot from '../../../vendor/uplot.js';
import { el, icon } from '../../ui/dom.js';
import { getIndicator } from '../indicators/index.js';
import { niceTicks, logTicks, indexOfTime, timeOfIndex, timeLabel, timeFull, visibleRange, heikinAshi } from '../scale.js';
import { DEFAULT_STATE } from '../adapter.js';
import { SHAPES, labelPrices } from '../drawings/shapes.js';
import { readPalette } from './palette.js';
import { withAlpha, clipped, drawBars, drawVolume, drawProfile, hLine, axisTag, drawMarks, drawHistogram } from './draw.js';

/** @typedef {import('../adapter.js').ChartAdapter} ChartAdapter */
/** @typedef {import('../adapter.js').ChartOptions} ChartOptions */
/** @typedef {import('../adapter.js').ChartState} ChartState */
/** @typedef {import('../adapter.js').ChartEvents} ChartEvents */
/** @typedef {import('../adapter.js').ChartLine} ChartLine */
/** @typedef {import('../adapter.js').ChartMark} ChartMark */
/** @typedef {import('../adapter.js').Drawing} Drawing */
/** @typedef {import('../adapter.js').DrawingTool} DrawingTool */
/** @typedef {import('../indicators/index.js').Bar} Bar */
/** @typedef {import('../indicators/index.js').Indicator} Indicator */

/**
 * @typedef {object} Instance  an indicator on this chart
 * @property {string} key @property {Indicator} def @property {Record<string, number>} params
 * @property {string} title @property {string} color
 * @property {ReturnType<Indicator['compute']>} result
 */

const AXIS_WIDTH = 72;           // CSS px; the same on every pane so the plots line up
const X_AXIS_HEIGHT = 24;
const RIGHT_MARGIN = 6;          // empty bars to the right of the newest, as in the simulator
const MIN_BARS = 10;
const X_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 24, 30, 48, 60, 96, 120, 240, 480, 960];
const MAX_OVERLAYS = 4;          // one colour each; a fifth would repeat a colour (dataviz rule)

let chartSeq = 0;

/**
 * @param {ChartOptions} options
 * @returns {ChartAdapter}
 */
export function createUplotChart({ container, formatPrice, roundPrice, tick, state: initial }) {
  const syncKey = `ts-chart-${(chartSeq += 1)}`;
  /** @type {ChartState} */
  const state = structuredClone({ ...DEFAULT_STATE, ...initial, show: { ...DEFAULT_STATE.show, ...initial?.show } });

  /** @type {Bar[]} */ let bars = [];
  /** @type {Bar[]} */ let shown = [];
  let intraday = true;
  let view = { min: 0, max: 100 };
  /** @type {[number, number] | null} */ let yManual = null;
  /** @type {[number, number]} */ let yLast = [0, 1];
  /** @type {Instance[]} */ let instances = [];
  /** @type {ChartLine[]} */ let lines = [];
  /** @type {Map<string, number>} line id → price while dragging */
  const dragPrices = new Map();
  /** @type {ChartMark[]} */ let marks = [];
  /** @type {Array<{ index: number, side: 'buy' | 'sell', text: string }>} */ let markIdx = [];
  /** @type {DrawingTool} */ let tool = 'cursor';
  /** @type {string | null} */ let selected = null;
  /** @type {Drawing | null} */ let draft = null;
  let historyPending = false;
  let historyDone = false;
  let pal = readPalette(container);
  let keySeq = 0;

  /** @type {Map<keyof ChartEvents, Set<(v: any) => void>>} */
  const listeners = new Map();
  /** @template {keyof ChartEvents} K @param {K} event @param {ChartEvents[K]} value */
  const emit = (event, value) => { for (const cb of listeners.get(event) ?? []) cb(value); };

  // ------------------------------------------------------------------ DOM
  const root = el('div', { class: 'ts-chart' });
  const mainEl = el('div', { class: 'ts-chart__main' });
  const overlay = el('div', { class: 'cme-chart-overlay' });
  const priceTag = el('span', { class: 'cme-price-tag ts-chart__cross-price', hidden: true });
  const timeTag = el('span', { class: 'cme-price-tag ts-chart__cross-time', hidden: true });
  const tooltip = el('div', { class: 'cme-chart-tooltip', hidden: true, role: 'status' });
  const yAxisGrip = el('div', { class: 'ts-chart__yaxis', title: 'Drag to scale the price axis' });
  mainEl.append(overlay, yAxisGrip);
  root.append(mainEl, priceTag, timeTag, tooltip);
  container.append(root);

  /** @type {uPlot | null} */ let main = null;
  /** @type {Array<{ u: uPlot, el: HTMLElement, inst: Instance, legend: HTMLElement }>} */ let panes = [];

  const pxr = () => uPlot.pxRatio || 1;
  const scaledFont = (/** @type {string} */ f) => f.replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${Number(n) * pxr()}px`);

  // ------------------------------------------------------------------ data
  function computeIndicators() {
    for (const inst of instances) {
      if (inst.def.pane === 'profile') {
        const [a, b] = [Math.max(0, Math.floor(view.min)), Math.min(shown.length - 1, Math.ceil(view.max))];
        inst.result = inst.def.compute(shown.slice(a, b + 1), inst.params);
      } else {
        inst.result = inst.def.compute(shown, inst.params);
      }
    }
  }

  const priceInstances = () => instances.filter((i) => i.def.pane === 'price');
  const xs = () => shown.map((_, i) => i);

  /** @returns {uPlot.AlignedData} */
  function mainData() {
    /** @type {Array<Array<number | null>>} */
    const series = [xs(), shown.map((b) => b.close)];
    for (const inst of priceInstances()) for (const line of inst.result.lines) series.push(line.values);
    return /** @type {uPlot.AlignedData} */ (/** @type {unknown} */ (series));
  }

  /** @param {Instance} inst @returns {uPlot.AlignedData} */
  function paneData(inst) {
    const series = [xs(), ...inst.result.lines.map((l) => l.values)];
    return /** @type {uPlot.AlignedData} */ (/** @type {unknown} */ (series));
  }

  /** @param {string} id @param {Record<string, number>} [params] @param {string} [key] @returns {Instance | null} */
  function makeInstance(id, params, key) {
    const def = getIndicator(id);
    if (!def) return null;
    const p = { ...def.defaults, ...params };
    const values = Object.values(p);
    return { key: key ?? `i${(keySeq += 1)}`, def, params: p, title: values.length ? `${def.name} ${values.join(' ')}` : def.name, color: '', result: { lines: [] } };
  }

  /** Overlay colours in order of addition, never cycled; panes start again at the first. */
  function assignColors() {
    let i = 0;
    for (const inst of instances) {
      if (inst.def.pane === 'oscillator') inst.color = pal.studies[0];
      else { inst.color = pal.studies[Math.min(i, pal.studies.length - 1)]; i += 1; }
    }
  }

  // ------------------------------------------------------------------ scales and axes
  /** @param {uPlot} u */
  const plotWidthCss = (u) => u.bbox.width / pxr();

  /** Keep the zoom within limits and some bars on screen. */
  function clampView() {
    const n = shown.length;
    const span = Math.max(MIN_BARS, Math.min(view.max - view.min, n + RIGHT_MARGIN + 50));
    const hiLimit = n - 1 + Math.max(RIGHT_MARGIN, span * 0.8);
    const loLimit = Math.min(n - 1, span * 0.2);
    const max = Math.min(hiLimit, Math.max(loLimit, view.min + span));
    view = { min: max - span, max };
  }

  function yRange() {
    if (!state.autoScale && yManual) return yManual;
    /** @type {number[]} */
    const extra = [];
    const a = Math.max(0, Math.floor(view.min)), b = Math.min(shown.length - 1, Math.ceil(view.max));
    for (const inst of priceInstances()) {
      for (const line of inst.result.lines) {
        for (let i = a; i <= b; i += 1) { const v = line.values[i]; if (v !== null && v !== undefined) extra.push(v); }
      }
    }
    let r = visibleRange(shown, view.min, view.max, extra.length ? [Math.min(...extra), Math.max(...extra)] : []) ?? [0, 1];
    if (state.log && r[0] <= 0) r = [Math.max(r[1] * 0.001, Math.min(...shown.slice(a, b + 1).map((x) => x.low)) * 0.95), r[1]];
    yLast = r;
    return r;
  }

  /** The close of the first visible bar: the 0% of percent mode. */
  const percentBase = () => shown[Math.max(0, Math.min(shown.length - 1, Math.ceil(view.min)))]?.close ?? 1;

  /** @param {uPlot} u @param {number} _i @param {number} min @param {number} max */
  function ySplits(u, _i, min, max) {
    const count = Math.max(2, Math.floor(u.bbox.height / pxr() / 44));
    if (state.percent) {
      const base = percentBase();
      return niceTicks((min / base - 1) * 100, (max / base - 1) * 100, count).map((p) => base * (1 + p / 100));
    }
    return state.log ? logTicks(min, max, count) : niceTicks(min, max, count);
  }

  /** @param {number} v */
  function yLabel(v) {
    if (!state.percent) return formatPrice(v);
    const p = (v / percentBase() - 1) * 100;
    const s = Math.abs(p) < 0.005 ? '0.00' : Math.abs(p).toFixed(2);
    return `${p <= -0.005 ? '−' : p >= 0.005 ? '+' : ''}${s}%`;
  }

  /** @param {uPlot} u @param {number} _i @param {number} min @param {number} max */
  function xSplits(u, _i, min, max) {
    const count = Math.max(2, Math.floor(plotWidthCss(u) / 90));
    const raw = (max - min) / count;
    const step = X_STEPS.find((s) => s >= raw) ?? Math.ceil(raw);
    const out = [];
    for (let i = Math.ceil(min / step) * step; i <= max; i += step) out.push(i);
    return out;
  }

  /** @param {uPlot} _u @param {number[]} splits */
  function xLabels(_u, splits) {
    /** @type {number | null} */
    let prev = null;
    return splits.map((i) => {
      if (!shown.length) return '';
      const t = timeOfIndex(shown, i);
      const s = timeLabel(t, prev, intraday, state.timezone);
      prev = t;
      return s;
    });
  }

  /** @param {boolean} showX @returns {uPlot.Axis[]} */
  function axes(showX) {
    const common = { stroke: pal.axis, font: pal.font, ticks: { show: false }, border: { show: false } };
    const grid = { show: state.show.grid, stroke: pal.grid, width: 1 };
    return [
      { ...common, show: showX, grid: { ...grid }, size: X_AXIS_HEIGHT, splits: xSplits, values: xLabels, gap: 4 },
      { ...common, side: 1, grid: { ...grid }, size: AXIS_WIDTH, gap: 6, splits: ySplits, values: (_u, s) => s.map(yLabel) },
    ];
  }

  // ------------------------------------------------------------------ drawing hooks
  /** @param {uPlot} u Under the series: volume, profile, price bars. */
  function underSeries(u) {
    if (state.show.volume) drawVolume(u, shown, pal);
    for (const inst of instances) if (inst.def.pane === 'profile') drawProfile(u, inst.result.profile ?? null, pal, inst.color);
    drawBars(u, shown, state.type, pal);
  }

  /** @param {Drawing} d @param {boolean} canvas */
  const drawingPts = (d, canvas) => d.points.map((p) => ({
    x: (main ? main.valToPos(indexOfTime(shown, p.time), 'x', canvas) : 0),
    y: (main ? main.valToPos(p.price, 'y', canvas) : 0),
  }));

  /** @param {uPlot} u Over the series: drawings, trading lines, marks, the last price. */
  function overSeries(u) {
    const last = shown[shown.length - 1];
    if (last && state.show.lastPrice) {
      const up = last.close >= last.open;
      hLine(u, last.close, up ? pal.up : pal.down, [1, 2]);
    }
    for (const line of lines) {
      const price = dragPrices.get(line.id) ?? line.price;
      const color = line.kind === 'stop-loss' ? pal.sell : line.kind === 'take-profit' ? pal.buy : line.kind === 'position' ? pal.action : line.side === 'buy' ? pal.buy : pal.sell;
      hLine(u, price, color, line.kind === 'position' ? [] : [6, 4]);
    }
    if (state.show.executions && markIdx.length) drawMarks(u, shown, markIdx, pal);
    const box = { left: u.bbox.left, top: u.bbox.top, width: u.bbox.width, height: u.bbox.height };
    clipped(u, () => {
      for (const d of [...state.drawings, ...(draft ? [draft] : [])]) {
        const shape = SHAPES[d.type];
        if (!shape) continue;
        shape.draw(u.ctx, drawingPts(d, true), box, {
          color: d.id === selected ? pal.selection : pal.studies[0], text: pal.text, font: scaledFont(pal.font), pxr: pxr(),
          selected: d.id === selected || d === draft, formatPrice, prices: labelPrices(d.type, d.points.map((p) => p.price)),
        });
      }
    });
    if (last && state.show.lastPrice) {
      const up = last.close >= last.open;
      axisTag(u, last.close, formatPrice(last.close), up ? pal.up : pal.tagDown, up ? pal.onUp : pal.onDown, pal.font);
    }
    placeChips(u);
  }

  // ------------------------------------------------------------------ trading line labels (DOM)
  /** @type {Map<string, { node: HTMLElement, label: HTMLElement, text: HTMLElement }>} */
  const chips = new Map();

  /** @param {ChartLine} line */
  function chipFor(line) {
    let chip = chips.get(line.id);
    if (!chip) {
      const label = el('button', { type: 'button', class: 'cme-chart-line__label' });
      const text = el('span', { class: 'cme-chart-line__text' });
      const node = el('div', { class: 'cme-chart-line' }, label, text);
      chip = { node, label, text };
      chips.set(line.id, chip);
      overlay.append(node);
      wireChip(line.id, chip);
    }
    const { node, label, text } = chip;
    node.className = ['cme-chart-line', `cme-chart-line--${line.kind === 'order' ? line.side : line.kind}`, line.draggable ? 'cme-chart-line--draggable' : ''].filter(Boolean).join(' ');
    label.textContent = line.label;
    label.setAttribute('aria-label', line.draggable ? `${line.label} at ${formatPrice(line.price)}. Drag, or use the arrow keys and Enter, to move it` : `${line.label} at ${formatPrice(line.price)}`);
    text.textContent = line.text ?? formatPrice(dragPrices.get(line.id) ?? line.price);
    text.className = ['cme-chart-line__text', line.tone === 'gain' ? 'cme-gain' : line.tone === 'loss' ? 'cme-loss' : ''].filter(Boolean).join(' ');
    let cancel = /** @type {HTMLButtonElement | null} */ (node.querySelector('.cme-chart-line__cancel'));
    if (line.cancellable && !cancel) {
      cancel = el('button', { type: 'button', class: 'cme-chart-line__cancel', 'aria-label': `Cancel ${line.label}`, title: 'Cancel', onclick: () => emit('lineCancel', { id: line.id }) }, icon('close'));
      node.append(cancel);
    } else if (!line.cancellable && cancel) cancel.remove();
    return chip;
  }

  /** @param {string} id @param {{ node: HTMLElement, label: HTMLElement, text: HTMLElement }} chip */
  function wireChip(id, chip) {
    const line = () => lines.find((l) => l.id === id);
    const setPrice = (/** @type {number} */ p) => { dragPrices.set(id, p); chip.text.textContent = formatPrice(p); schedule(); };
    chip.label.addEventListener('pointerdown', (e) => {
      const l = line();
      if (!l?.draggable || !main) return;
      e.preventDefault();
      chip.label.setPointerCapture(e.pointerId);
      chip.node.classList.add('is-dragging');
      const rect = main.over.getBoundingClientRect();
      const move = (/** @type {PointerEvent} */ ev) => { if (main) setPrice(roundPrice(main.posToVal(ev.clientY - rect.top, 'y'))); };
      const up = () => {
        chip.label.removeEventListener('pointermove', move);
        chip.node.classList.remove('is-dragging');
        const p = dragPrices.get(id);
        if (p !== undefined && p !== l.price) emit('lineDrag', { id, price: p });
        else { dragPrices.delete(id); schedule(); }
      };
      chip.label.addEventListener('pointermove', move);
      chip.label.addEventListener('pointerup', up, { once: true });
      chip.label.addEventListener('pointercancel', up, { once: true });
    });
    chip.label.addEventListener('click', () => { if (!line()?.draggable) emit('lineClick', { id }); });
    chip.label.addEventListener('keydown', (e) => {
      const l = line();
      if (!l?.draggable) return;
      const cur = dragPrices.get(id) ?? l.price;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setPrice(roundPrice(cur + (e.key === 'ArrowUp' ? 1 : -1) * tick * (e.shiftKey ? 10 : 1)));
      } else if (e.key === 'Enter' && dragPrices.has(id)) {
        e.preventDefault();
        emit('lineDrag', { id, price: cur });
      } else if (e.key === 'Escape' && dragPrices.has(id)) {
        dragPrices.delete(id);
        chip.text.textContent = l.text ?? formatPrice(l.price);
        schedule();
      }
    });
  }

  /** @param {uPlot} u */
  function placeChips(u) {
    const top = u.bbox.top / pxr(), height = u.bbox.height / pxr();
    for (const line of lines) {
      const chip = chips.get(line.id);
      if (!chip) continue;
      const y = u.valToPos(dragPrices.get(line.id) ?? line.price, 'y');
      chip.node.hidden = !(y >= 0 && y <= height);
      chip.node.style.top = `${top + y}px`;
      chip.node.style.right = `${AXIS_WIDTH + 8}px`;
    }
  }

  // ------------------------------------------------------------------ build
  /** @param {HTMLElement} target @param {uPlot.Options} opts @param {uPlot.AlignedData} data */
  const plot = (target, opts, data) => new uPlot(opts, data, target);

  function sizes() {
    const w = Math.max(50, container.clientWidth);
    const h = Math.max(80, container.clientHeight);
    const paneH = panes.length ? Math.max(70, Math.min(160, Math.round(h * 0.22))) : 0;
    return { w, mainH: Math.max(60, h - paneH * panes.length), paneH };
  }

  function destroyPlots() {
    main?.destroy();
    main = null;
    for (const p of panes) { p.u.destroy(); p.el.remove(); }
    panes = [];
  }

  function build() {
    destroyPlots();
    pal = readPalette(container);
    assignColors();
    computeIndicators();
    const oscillators = instances.filter((i) => i.def.pane === 'oscillator');
    // Pane elements first, so sizes() can share out the height.
    panes = oscillators.map((inst) => {
      const legend = el('div', { class: 'cme-chart-legend ts-chart__pane-legend' });
      const paneEl = el('div', { class: 'ts-chart__pane' }, legend);
      root.append(paneEl);
      return { u: /** @type {any} */ (null), el: paneEl, inst, legend };
    });
    const { w, mainH, paneH } = sizes();
    const cursor = { drag: { x: false, y: false, setScale: false }, points: { show: false }, sync: { key: syncKey }, focus: { prox: -1 } };
    const isLine = state.type === 'line' || state.type === 'area';

    /** @type {uPlot.Series[]} */
    const series = [
      {},
      {
        label: 'Close', stroke: isLine ? pal.action : 'transparent', width: isLine ? 1.5 : 0, points: { show: false },
        ...(isLine ? {} : { paths: () => null }),
        ...(state.type === 'area' ? { fill: withAlpha(pal.action, 0.12) } : {}),
      },
    ];
    for (const inst of priceInstances()) for (const line of inst.result.lines) series.push({ label: line.name, stroke: inst.color, width: 1.5, points: { show: false }, spanGaps: false });

    const logScale = state.log ? { distr: /** @type {uPlot.Scale.Distr} */ (100), fwd: Math.log, bwd: Math.exp } : {};
    main = plot(mainEl, {
      width: w, height: mainH, legend: { show: false }, cursor, select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      scales: { x: { time: false, auto: false, range: () => [view.min, view.max] }, y: { auto: true, range: () => yRange(), ...logScale } },
      axes: axes(panes.length === 0),
      series,
      hooks: {
        drawAxes: [underSeries],
        draw: [overSeries],
        setCursor: [onCursor],
      },
    }, mainData());
    mainEl.prepend(main.root);

    panes.forEach((p, k) => {
      const { inst } = p;
      const levels = inst.def.levels ?? [];
      const range = inst.def.range;
      /** @type {uPlot.Series[]} */
      const s = [{}, ...inst.result.lines.map((line, li) => ({ label: line.name, stroke: pal.studies[li === 0 ? 0 : 2], width: 1.5, points: { show: false } }))];
      p.u = plot(p.el, {
        width: w, height: paneH, legend: { show: false }, cursor, select: { show: false, left: 0, top: 0, width: 0, height: 0 },
        scales: {
          x: { time: false, auto: false, range: () => [view.min, view.max] },
          y: { auto: true, range: () => range ?? paneRange(inst) },
        },
        axes: axes(k === panes.length - 1).map((a, i) => (i === 1 ? { ...a, splits: (/** @type {uPlot} */ u, /** @type {number} */ _i, /** @type {number} */ min, /** @type {number} */ max) => niceTicks(min, max, Math.max(2, Math.floor(u.bbox.height / pxr() / 30))), values: (/** @type {uPlot} */ _u, /** @type {number[]} */ sp) => sp.map((v) => fmtNum(v)) } : a)),
        series: s,
        hooks: {
          drawAxes: [(u) => {
            for (const lv of levels) hLine(u, lv, pal.axis, [4, 4]);
            if (inst.result.histogram) drawHistogram(u, inst.result.histogram.values, pal);
          }],
        },
      }, paneData(inst));
      p.el.prepend(p.u.root);
      p.legend.replaceChildren(
        el('span', { class: 'cme-chart-legend__series' }, el('span', {}, inst.title), el('span', { class: 'ts-chart__pane-values' })),
        el('button', { type: 'button', class: 'cme-icon-btn cme-icon-btn--sm', 'aria-label': `Remove ${inst.title}`, title: 'Remove', onclick: () => removeInstance(inst.key) }, icon('close', 'sm')));
      wirePlot(p.u, false);
    });
    wirePlot(main, true);
    apply();
  }

  /** @param {number} v */
  const fmtNum = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));

  /** @param {Instance} inst @returns {[number, number]} */
  function paneRange(inst) {
    let lo = Infinity, hi = -Infinity;
    const a = Math.max(0, Math.floor(view.min)), b = Math.min(shown.length - 1, Math.ceil(view.max));
    const all = [...inst.result.lines.map((l) => l.values), ...(inst.result.histogram ? [inst.result.histogram.values] : [])];
    for (const values of all) for (let i = a; i <= b; i += 1) { const v = values[i]; if (v !== null && v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    for (const lv of inst.def.levels ?? []) { lo = Math.min(lo, lv); hi = Math.max(hi, lv); }
    if (!Number.isFinite(lo)) return [0, 1];
    const pad = (hi - lo) * 0.1 || 1;
    return [lo - pad, hi + pad];
  }

  /** @param {string} key */
  function removeInstance(key) {
    instances = instances.filter((i) => i.key !== key);
    build();
    emit('indicatorsChange', instances.map((i) => ({ id: i.def.id, params: i.params })));
  }

  /** Push data and the view into every plot. */
  function apply() {
    clampView();
    computeIndicators();
    if (main) {
      main.setData(mainData(), false);
      main.setScale('x', { min: view.min, max: view.max });
    }
    for (const p of panes) {
      p.u.setData(paneData(p.inst), false);
      p.u.setScale('x', { min: view.min, max: view.max });
    }
    maybeNeedHistory();
  }

  let frame = 0;
  /** Redraw once on the next frame (live ticks arrive faster than the screen refreshes). */
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; apply(); });
  }

  function maybeNeedHistory() {
    if (!historyPending && !historyDone && shown.length && view.min < 5) {
      historyPending = true;
      emit('needHistory', undefined);
    }
  }

  // ------------------------------------------------------------------ crosshair
  /** @param {uPlot} u */
  function onCursor(u) {
    const { idx, left, top } = u.cursor;
    if (left === undefined || left < 0 || top === undefined) {
      priceTag.hidden = true;
      timeTag.hidden = true;
      tooltip.hidden = true;
      const last = shown.length - 1;
      emit('crosshair', { bar: bars[last] ?? null, index: last, price: null, indicators: legendValues(last) });
      updatePaneLegends(last);
      return;
    }
    const i = Math.round(u.posToVal(left, 'x'));
    const index = idx ?? Math.max(0, Math.min(shown.length - 1, i));
    const price = u === main ? u.posToVal(top, 'y') : null;
    if (main) {
      const bboxTop = main.bbox.top / pxr();
      if (price !== null) {
        priceTag.hidden = false;
        priceTag.textContent = yLabel(price);
        priceTag.style.top = `${bboxTop + top - 8}px`;
        priceTag.style.left = `${main.bbox.left / pxr() + plotWidthCss(main) + 2}px`;
      } else priceTag.hidden = true;
      if (shown.length) {
        timeTag.hidden = false;
        timeTag.textContent = timeFull(timeOfIndex(shown, i), intraday, state.timezone);
        timeTag.style.left = `${main.bbox.left / pxr() + left}px`;
        timeTag.style.top = `${root.clientHeight - X_AXIS_HEIGHT + 4}px`; // on the time axis of the lowest pane
      }
    }
    showMarkTooltip(i, left, top, u === main);
    emit('crosshair', { bar: bars[index] ?? null, index, price, indicators: legendValues(index) });
    updatePaneLegends(index);
  }

  /** @param {number} index */
  function legendValues(index) {
    /** @type {Array<{ key: string, name: string, value: number | null, color: string }>} */
    const out = [];
    for (const inst of instances) {
      inst.result.lines.forEach((line, li) => out.push({
        key: inst.key, name: line.name, value: line.values[index] ?? null,
        color: inst.def.pane === 'oscillator' ? pal.studies[li === 0 ? 0 : 2] : inst.color,
      }));
    }
    return out;
  }

  /** @param {number} index */
  function updatePaneLegends(index) {
    for (const p of panes) {
      const out = p.legend.querySelector('.ts-chart__pane-values');
      if (!out) continue;
      out.replaceChildren(...p.inst.result.lines.map((line, li) => {
        const v = line.values[index];
        return el('span', { style: `color: ${pal.studies[li === 0 ? 0 : 2]}` }, v === null || v === undefined ? '–' : fmtNum(v));
      }));
    }
  }

  /** @param {number} i @param {number} left @param {number} top @param {boolean} isMain */
  function showMarkTooltip(i, left, top, isMain) {
    tooltip.hidden = true;
    if (!isMain || !main || !state.show.executions) return;
    const hit = markIdx.filter((m) => m.index === i);
    if (!hit.length) return;
    const bar = shown[i];
    const near = hit.some((m) => {
      const y = /** @type {uPlot} */ (main).valToPos(m.side === 'buy' ? bar.low : bar.high, 'y');
      return Math.abs(y - top) < 24;
    });
    if (!near) return;
    tooltip.hidden = false;
    tooltip.textContent = hit.map((m) => m.text).join(' · ');
    tooltip.style.left = `${main.bbox.left / pxr() + left + 12}px`;
    tooltip.style.top = `${main.bbox.top / pxr() + top + 12}px`;
  }

  // ------------------------------------------------------------------ pointer: pan, zoom, draw, select
  /** @param {uPlot} u @param {boolean} isMain */
  function wirePlot(u, isMain) {
    const over = u.over;
    over.tabIndex = isMain ? 0 : -1;
    if (isMain) {
      over.setAttribute('role', 'img');
      over.setAttribute('aria-label', 'Price chart. Arrow keys scroll, plus and minus zoom, Delete removes the selected drawing.');
    }
    over.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = over.getBoundingClientRect();
      const anchor = u.posToVal(e.clientX - rect.left, 'x');
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { pan(((e.deltaX || e.deltaY) / rect.width) * (view.max - view.min)); return; }
      zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12, anchor);
    }, { passive: false });
    over.addEventListener('contextmenu', (e) => {
      if (!isMain) return;
      e.preventDefault();
      const rect = over.getBoundingClientRect();
      const price = u.posToVal(e.clientY - rect.top, 'y');
      emit('contextMenu', { price, time: timeOfIndex(shown, Math.round(u.posToVal(e.clientX - rect.left, 'x'))), x: e.clientX, y: e.clientY });
    });
    over.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      over.focus({ preventScroll: true });
      const rect = over.getBoundingClientRect();
      const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
      if (isMain && tool !== 'cursor') { startDrawing(e, ox, oy, rect); return; }
      if (isMain) {
        const hit = hitDrawing(ox, oy);
        selected = hit?.id ?? null;
        if (hit && !hit.locked) { moveDrawing(e, hit, ox, oy, rect); schedule(); return; }
        schedule();
      }
      startPan(e, ox);
    });
    if (isMain) over.addEventListener('keydown', onKey);
  }

  /** @param {number} factor @param {number} anchor */
  function zoom(factor, anchor) {
    const span = view.max - view.min;
    const next = Math.max(MIN_BARS, Math.min(span * factor, shown.length + RIGHT_MARGIN + 50));
    const k = (anchor - view.min) / span;
    view = { min: anchor - k * next, max: anchor - k * next + next };
    schedule();
  }

  /** @param {number} delta bars */
  function pan(delta) {
    view = { min: view.min + delta, max: view.max + delta };
    schedule();
  }

  /** @param {PointerEvent} e @param {number} ox */
  function startPan(e, ox) {
    if (!main) return;
    const target = /** @type {HTMLElement} */ (e.currentTarget);
    target.setPointerCapture(e.pointerId);
    const start = { ...view };
    const width = plotWidthCss(main);
    target.style.cursor = 'grabbing';
    const move = (/** @type {PointerEvent} */ ev) => {
      const rect = target.getBoundingClientRect();
      const d = ((ev.clientX - rect.left - ox) / width) * (start.max - start.min);
      view = { min: start.min - d, max: start.max - d };
      schedule();
    };
    const up = () => { target.removeEventListener('pointermove', move); target.style.cursor = ''; };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
    target.addEventListener('pointercancel', up, { once: true });
  }

  /** @param {number} ox @param {number} oy */
  function toPoint(ox, oy) {
    const u = /** @type {uPlot} */ (main);
    return { time: timeOfIndex(shown, u.posToVal(ox, 'x')), price: u.posToVal(oy, 'y') };
  }

  /** @param {number} ox @param {number} oy */
  function hitDrawing(ox, oy) {
    if (!main) return null;
    const box = { left: 0, top: 0, width: plotWidthCss(main), height: main.bbox.height / pxr() };
    for (let k = state.drawings.length - 1; k >= 0; k -= 1) {
      const d = state.drawings[k];
      if (SHAPES[d.type]?.hit(drawingPts(d, false), box, ox, oy, 6)) return d;
    }
    return null;
  }

  /** @param {PointerEvent} e @param {number} ox @param {number} oy @param {DOMRect} rect */
  function startDrawing(e, ox, oy, rect) {
    const shape = SHAPES[tool];
    if (!shape) return;
    const type = /** @type {Drawing['type']} */ (tool);
    const p = toPoint(ox, oy);
    if (draft && draft.points.length === 2 && draft.type === type) {
      // Second click of a click-click drawing.
      draft.points[1] = p;
      finishDrawing();
      return;
    }
    draft = { id: `d${Date.now().toString(36)}${(keySeq += 1)}`, type, points: shape.points === 1 ? [p] : [p, { ...p }] };
    if (shape.points === 1) { finishDrawing(); return; }
    const target = /** @type {HTMLElement} */ (e.currentTarget);
    target.setPointerCapture(e.pointerId);
    let moved = false;
    const move = (/** @type {PointerEvent} */ ev) => {
      if (!draft) return;
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      if (Math.hypot(x - ox, y - oy) > 3) moved = true;
      draft.points[1] = toPoint(x, y);
      schedule();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      if (moved) finishDrawing();
      else target.addEventListener('pointermove', move); // click, then click again for the second point
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  }

  function finishDrawing() {
    if (!draft) return;
    state.drawings = [...state.drawings, draft];
    selected = draft.id;
    draft = null;
    setToolInternal('cursor');
    emit('drawingsChange', structuredClone(state.drawings));
    schedule();
  }

  /** @param {PointerEvent} e @param {Drawing} d @param {number} ox @param {number} oy @param {DOMRect} rect */
  function moveDrawing(e, d, ox, oy, rect) {
    const u = /** @type {uPlot} */ (main);
    const target = /** @type {HTMLElement} */ (e.currentTarget);
    target.setPointerCapture(e.pointerId);
    const start = drawingPts(d, false);
    let moved = false;
    const move = (/** @type {PointerEvent} */ ev) => {
      const dx = ev.clientX - rect.left - ox, dy = ev.clientY - rect.top - oy;
      if (Math.hypot(dx, dy) > 2) moved = true;
      d.points = start.map((p) => ({ time: timeOfIndex(shown, u.posToVal(p.x + dx, 'x')), price: u.posToVal(p.y + dy, 'y') }));
      schedule();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      if (moved) emit('drawingsChange', structuredClone(state.drawings));
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    const span = view.max - view.min;
    if (e.key === 'ArrowLeft') pan(-span * 0.1);
    else if (e.key === 'ArrowRight') pan(span * 0.1);
    else if (e.key === '+' || e.key === '=') zoom(1 / 1.2, (view.min + view.max) / 2);
    else if (e.key === '-') zoom(1.2, (view.min + view.max) / 2);
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (!deleteSelected()) return; }
    else if (e.key === 'Escape') { draft = null; selected = null; setToolInternal('cursor'); schedule(); }
    else return;
    e.preventDefault();
  }

  /** @param {DrawingTool} t */
  function setToolInternal(t) {
    if (tool === t) return;
    tool = t;
    if (t !== 'cursor') draft = null;
    root.classList.toggle('ts-chart--drawing', t !== 'cursor');
    emit('toolChange', t);
  }

  function deleteSelected() {
    if (!selected) return false;
    const before = state.drawings.length;
    state.drawings = state.drawings.filter((d) => d.id !== selected);
    selected = null;
    if (state.drawings.length === before) return false;
    emit('drawingsChange', structuredClone(state.drawings));
    schedule();
    return true;
  }

  // Price axis drag: scale the price range (turns auto scale off, as in the simulator).
  yAxisGrip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    yAxisGrip.setPointerCapture(e.pointerId);
    const start = /** @type {[number, number]} */ ([...yLast]);
    const y0 = e.clientY;
    const move = (/** @type {PointerEvent} */ ev) => {
      const f = Math.exp((ev.clientY - y0) * 0.005);
      const mid = (start[0] + start[1]) / 2, half = ((start[1] - start[0]) / 2) * f;
      yManual = [mid - half, mid + half];
      if (state.autoScale) { state.autoScale = false; emit('autoScaleChange', false); }
      schedule();
    };
    const up = () => yAxisGrip.removeEventListener('pointermove', move);
    yAxisGrip.addEventListener('pointermove', move);
    yAxisGrip.addEventListener('pointerup', up, { once: true });
  });
  yAxisGrip.addEventListener('dblclick', () => { state.autoScale = true; yManual = null; emit('autoScaleChange', true); schedule(); });

  // ------------------------------------------------------------------ data in
  function reshow() {
    shown = state.type === 'heikin-ashi' ? heikinAshi(bars) : bars;
    // A mark belongs to the bar that contains its time.
    markIdx = marks.map((m) => ({ index: Math.floor(indexOfTime(shown, m.time) + 1e-9), side: m.side, text: m.text })).filter((m) => m.index >= 0 && m.index < shown.length);
    // Counts for tests and support ("how many bars did it load?").
    root.dataset.bars = String(bars.length);
    root.dataset.marks = String(markIdx.length);
  }

  function resetView() {
    const n = shown.length;
    const fit = main ? Math.round(plotWidthCss(main) / 9) : 120;
    const count = Math.max(MIN_BARS, Math.min(n, fit));
    view = { min: n - count, max: n - 1 + RIGHT_MARGIN };
    state.autoScale = true;
    yManual = null;
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(container);

  function resize() {
    if (!main) return;
    const { w, mainH, paneH } = sizes();
    main.setSize({ width: w, height: mainH });
    for (const p of panes) p.u.setSize({ width: w, height: paneH });
    yAxisGrip.style.width = `${AXIS_WIDTH}px`;
    yAxisGrip.style.height = `${main.bbox.height / pxr()}px`;
  }

  // ------------------------------------------------------------------ public API
  /** @type {ChartAdapter} */
  const api = {
    setData(next, opts) {
      bars = next.slice();
      if (opts) { intraday = opts.intraday; root.dataset.symbol = opts.symbol; root.dataset.resolution = opts.resolution; }
      historyPending = false;
      historyDone = false;
      dragPrices.clear();
      reshow();
      resetView();
      if (!main) build(); else apply();
      resize();
    },
    prependData(older) {
      historyPending = false;
      const first = bars[0]?.time ?? Infinity;
      const add = older.filter((b) => b.time < first);
      if (!add.length) { historyDone = true; return; }
      bars = [...add, ...bars];
      view = { min: view.min + add.length, max: view.max + add.length };
      reshow();
      apply();
    },
    updateBar(bar) {
      const last = bars[bars.length - 1];
      if (last && bar.time < last.time) return;
      const atEdge = view.max >= bars.length - 1;
      if (last && bar.time === last.time) bars[bars.length - 1] = bar;
      else {
        bars.push(bar);
        if (atEdge) view = { min: view.min + 1, max: view.max + 1 };
      }
      reshow();
      schedule();
    },
    configure(next) {
      let rebuild = false;
      if (next.type && next.type !== state.type) { state.type = next.type; rebuild = true; }
      if (next.log !== undefined && next.log !== state.log) { state.log = next.log; if (state.log) state.percent = false; rebuild = true; }
      if (next.percent !== undefined && next.percent !== state.percent) { state.percent = next.percent; if (state.percent) state.log = false; rebuild = true; }
      if (next.timezone && next.timezone !== state.timezone) { state.timezone = next.timezone; rebuild = true; }
      if (next.autoScale !== undefined) { state.autoScale = next.autoScale; if (next.autoScale) yManual = null; }
      if (next.show) { state.show = { ...state.show, ...next.show }; rebuild = true; }
      if (next.indicators) {
        const overlays = next.indicators.filter((i) => getIndicator(i.id)?.pane !== 'oscillator');
        const keep = overlays.length > MAX_OVERLAYS ? next.indicators.filter((i) => getIndicator(i.id)?.pane === 'oscillator' || overlays.indexOf(i) < MAX_OVERLAYS) : next.indicators;
        instances = /** @type {Instance[]} */ (keep.map((i) => makeInstance(i.id, i.params)).filter(Boolean));
        rebuild = true;
      }
      if (next.drawings) { state.drawings = structuredClone(next.drawings); selected = null; }
      reshow();
      if (rebuild || !main) { build(); resize(); } else schedule();
    },
    getState: () => ({ ...structuredClone(state), indicators: instances.map((i) => ({ id: i.def.id, params: { ...i.params } })) }),
    listIndicators: () => instances.map((i) => ({ key: i.key, id: i.def.id, title: i.title, pane: i.def.pane, color: i.color, params: { ...i.params } })),
    setLines(next) {
      lines = next.slice();
      const ids = new Set(lines.map((l) => l.id));
      for (const [id, chip] of chips) if (!ids.has(id)) { chip.node.remove(); chips.delete(id); }
      for (const id of [...dragPrices.keys()]) {
        const l = lines.find((x) => x.id === id);
        if (!l || Math.abs(l.price - /** @type {number} */ (dragPrices.get(id))) < tick / 2) dragPrices.delete(id);
      }
      for (const line of lines) chipFor(line);
      schedule();
    },
    setMarks(next) { marks = next.slice(); reshow(); schedule(); },
    setTool(t) { setToolInternal(t); },
    deleteSelected,
    resetView() { resetView(); schedule(); },
    getBars: () => bars.slice(),
    visibleTimeRange: () => ({ from: timeOfIndex(shown, Math.max(0, view.min)), to: timeOfIndex(shown, Math.min(shown.length - 1, view.max)) }),
    async screenshot() {
      if (!main) return null;
      const canvases = [main.ctx.canvas, ...panes.map((p) => p.u.ctx.canvas)];
      const out = document.createElement('canvas');
      out.width = main.ctx.canvas.width;
      out.height = canvases.reduce((h, c) => h + c.height, 0);
      const ctx = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d'));
      ctx.fillStyle = pal.panel;
      ctx.fillRect(0, 0, out.width, out.height);
      let y = 0;
      for (const c of canvases) { ctx.drawImage(c, 0, y); y += c.height; }
      // The trading line labels are HTML; put their text on the image too.
      ctx.font = scaledFont(pal.font);
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'right';
      for (const line of lines) {
        const py = main.valToPos(line.price, 'y', true);
        if (py < main.bbox.top || py > main.bbox.top + main.bbox.height) continue;
        ctx.fillStyle = pal.textStrong;
        ctx.fillText(`${line.label} ${line.text ?? formatPrice(line.price)}`, main.bbox.left + main.bbox.width - 6 * pxr(), py - 2 * pxr());
      }
      return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    },
    setTheme() { pal = readPalette(container); if (main) { build(); resize(); } },
    resize,
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => { set.delete(cb); };
    },
    destroy() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      destroyPlots();
      root.remove();
      listeners.clear();
    },
  };

  if (state.indicators.length) instances = /** @type {Instance[]} */ (state.indicators.map((i) => makeInstance(i.id, i.params)).filter(Boolean));
  return api;
}

