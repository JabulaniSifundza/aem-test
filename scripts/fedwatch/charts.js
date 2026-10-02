/*
 * SVG charts for FedWatch (v2 block), with legend toggles: a series with `hidden: true` is not
 * drawn and leaves the tooltip, but still sets the axis scale so the other series don't jump.
 * Drawn the way chart.md describes the chart panel:
 * series colours --color-chart-series-1…4 in order, axis text 11px in --color-chart-axis,
 * grid --color-chart-grid, tooltip on --color-chart-tooltip with a soft shadow. Text wears
 * text tokens, never a series colour. Every chart has a hover layer and a keyboard path.
 */
const MIN_P = 0.0005; // bars below 0.05% are not drawn
export const pct = (p) => `${(p * 100).toFixed(1)}%`;
export const rate = (r, dp = 2) => `${r.toFixed(dp)}%`;

// ---------- tokens (read when a chart is drawn, so they follow the loaded styles) ----------
let COL = null;
function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const tok = (n, fallback = '') => css.getPropertyValue(n).trim() || fallback;
  COL = {
    series: [1, 2, 3, 4].map((i) => tok(`--color-chart-series-${i}`)),
    axis: tok('--color-chart-axis'),
    grid: tok('--color-chart-grid'),
    tooltip: tok('--color-chart-tooltip', tok('--color-surface-page')),
    heading: tok('--color-text-heading'),
    body: tok('--color-text-body'),
    sans: tok('--font-sans', 'sans-serif'),
    mono: tok('--font-mono', 'monospace'),
  };
}
const AXIS_PX = 11; // chart.md: axis text 11px
const VALUE_PX = 12; // chart.md legend size, used for direct labels and tooltips

// ---------- SVG kit ----------
const NS = 'http://www.w3.org/2000/svg';
let uid = 0;
function svgEl(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v !== undefined && v !== null) e.setAttribute(k, v);
  });
  if (parent) parent.appendChild(e);
  return e;
}
function svgText(parent, x, y, str, attrs = {}) {
  const t = svgEl('text', {
    x, y, 'font-size': AXIS_PX, fill: COL.axis, ...attrs,
  }, parent);
  t.textContent = str;
  return t;
}

function frame(canvas, margin, label) {
  canvas.replaceChildren();
  const W = Math.max(canvas.clientWidth, 260);
  const H = Math.max(canvas.clientHeight, 280);
  const svg = svgEl('svg', {
    width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': label, 'font-family': COL.sans,
  });
  canvas.append(svg);
  const ring = getComputedStyle(canvas.closest('.cme-chart') || canvas).backgroundColor;
  const id = `fw-shadow-${uid += 1}`;
  const defs = svgEl('defs', {}, svg);
  const f = svgEl('filter', {
    id, x: '-20%', y: '-20%', width: '140%', height: '140%',
  }, defs);
  svgEl('feDropShadow', {
    dx: 0, dy: 0, stdDeviation: 3, 'flood-color': COL.axis, 'flood-opacity': 0.3,
  }, f);
  return {
    svg,
    W,
    H,
    ring,
    shadow: `url(#${id})`,
    x0: margin.left,
    x1: W - margin.right,
    y0: margin.top,
    y1: H - margin.bottom,
  };
}

function niceScale(min, max, maxTicks) {
  const span = Math.max(max - min, 1e-9);
  const raw = span / maxTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw - 1e-12);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

function yAxis(fr, scale, fmt) {
  const g = svgEl('g', { 'aria-hidden': 'true' }, fr.svg);
  const y = (v) => fr.y1 - ((v - scale.lo) / (scale.hi - scale.lo)) * (fr.y1 - fr.y0);
  scale.ticks.forEach((v, i) => {
    svgEl('line', {
      x1: fr.x0, x2: fr.x1, y1: y(v), y2: y(v), stroke: i === 0 ? COL.axis : COL.grid, 'stroke-width': 1,
    }, g);
    svgText(g, fr.x0 - 8, y(v), fmt(v), { 'text-anchor': 'end', 'dominant-baseline': 'middle' });
  });
  return y;
}

// Tooltip drawn in the SVG (chart.md: white, radius 5, soft shadow); text in text tokens.
function showTip(fr, layer, ax, ay, title, rows) {
  layer.replaceChildren();
  const g = svgEl('g', { 'pointer-events': 'none', 'aria-hidden': 'true' }, layer);
  const box = svgEl('rect', { rx: 5, fill: COL.tooltip, filter: fr.shadow }, g);
  const pad = 10;
  const lh = 18;
  const head = svgText(g, 0, 0, title, {
    'font-size': VALUE_PX, 'font-weight': 700, fill: COL.heading, 'dominant-baseline': 'hanging',
  });
  let w = head.getComputedTextLength();
  const built = rows.map((r) => {
    const sw = r.color ? svgEl('circle', { r: 4.5, fill: r.color }, g) : null;
    const lab = svgText(g, 0, 0, r.label, { 'font-size': VALUE_PX, fill: COL.body, 'dominant-baseline': 'middle' });
    const val = svgText(g, 0, 0, r.value, {
      'font-size': VALUE_PX, fill: COL.heading, 'font-family': COL.mono, 'text-anchor': 'end', 'dominant-baseline': 'middle',
    });
    const rowW = (sw ? 14 : 0) + lab.getComputedTextLength() + 16 + val.getComputedTextLength();
    w = Math.max(w, rowW);
    return { sw, lab, val };
  });
  const bw = w + pad * 2;
  const bh = pad * 2 + lh * (rows.length + 1) - 4;
  let bx = ax + 14;
  if (bx + bw > fr.W - 4) bx = ax - 14 - bw;
  bx = Math.max(4, bx);
  const by = Math.min(Math.max(4, ay - bh / 2), fr.H - bh - 4);
  box.setAttribute('x', bx); box.setAttribute('y', by);
  box.setAttribute('width', bw); box.setAttribute('height', bh);
  head.setAttribute('x', bx + pad); head.setAttribute('y', by + pad);
  built.forEach(({ sw, lab, val }, i) => {
    const cy = by + pad + lh * (i + 1) + 6;
    if (sw) { sw.setAttribute('cx', bx + pad + 4.5); sw.setAttribute('cy', cy); }
    lab.setAttribute('x', bx + pad + (sw ? 14 : 0)); lab.setAttribute('y', cy);
    val.setAttribute('x', bx + bw - pad); val.setAttribute('y', cy);
  });
}

// Bars with 4px rounded data ends anchored on the baseline (dataviz mark spec).
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Bar chart: categories on x, one or more series as grouped bars.
 * opts: { label, categories:[{key,text,sub}], series:[{name, color, values:[number|null]}],
 *         valueLabels, fmt }
 */
export function barChart(canvas, opts) {
  readTokens();
  const fr = frame(canvas, {
    left: 44, right: 8, top: 28, bottom: 42,
  }, opts.label);
  const all = opts.series.flatMap((s) => s.values.filter((v) => v !== null));
  const scale = niceScale(0, Math.max(0.05, ...all), 4);
  const y = yAxis(fr, scale, (v) => `${Math.round(v * 100)}%`);
  const n = opts.categories.length;
  const band = (fr.x1 - fr.x0) / n;
  const k = opts.series.length;
  const groupW = Math.min(band * 0.7, k === 1 ? 96 : 30 * k);
  const gap = 2;
  const barW = (groupW - gap * (k - 1)) / k;
  const hover = svgEl('g', {}, fr.svg);
  const marks = svgEl('g', { 'aria-hidden': 'true' }, fr.svg);
  const labels = svgEl('g', { 'aria-hidden': 'true' }, fr.svg);
  const hits = svgEl('g', {}, fr.svg);
  const tipLayer = svgEl('g', {}, fr.svg);
  opts.categories.forEach((c, i) => {
    const cx = fr.x0 + band * (i + 0.5);
    const gx = cx - groupW / 2;
    opts.series.forEach((s, j) => {
      if (s.hidden) return;
      const v = s.values[i];
      if (v === null || v < MIN_P / 2) return;
      const top = y(v);
      svgEl('path', { d: barPath(gx + j * (barW + gap), top, barW, fr.y1 - top), fill: s.color }, marks);
      if (opts.valueLabels) {
        svgText(labels, cx, top - 7, pct(v), {
          'text-anchor': 'middle', 'font-size': VALUE_PX, 'font-family': COL.mono, fill: COL.heading,
        });
      }
    });
    svgText(labels, cx, fr.y1 + 16, c.text, { 'text-anchor': 'middle' });
    if (c.sub) {
      svgText(labels, cx, fr.y1 + 31, c.sub, {
        'text-anchor': 'middle', fill: COL.body, 'font-weight': 700,
      });
    }
    const rows = opts.series.filter((s) => !s.hidden).map((s) => ({
      color: opts.series.length > 1 ? s.color : null,
      label: s.name,
      value: s.values[i] === null ? 'no price' : pct(s.values[i]),
    }));
    const spoken = rows.map((r) => `${r.label} ${r.value}`).join(', ');
    const hit = svgEl('rect', {
      x: cx - band / 2,
      y: fr.y0 - 20,
      width: band,
      height: fr.y1 - fr.y0 + 20,
      fill: 'transparent',
      tabindex: 0,
      role: 'img',
      'aria-label': `${c.text}${c.sub ? ` (${c.sub.toLowerCase()})` : ''}: ${spoken}`,
    }, hits);
    const on = () => {
      hover.replaceChildren();
      svgEl('rect', {
        x: cx - Math.min(band, groupW + 24) / 2,
        y: fr.y0,
        width: Math.min(band, groupW + 24),
        height: fr.y1 - fr.y0,
        fill: COL.grid,
      }, hover);
      const tops = opts.series.map((s) => (s.values[i] === null ? fr.y1 : y(s.values[i])));
      const top = Math.min(...tops);
      showTip(fr, tipLayer, cx + groupW / 2, Math.max(top, fr.y0 + 30), `${c.text}${c.sub ? ` · ${c.sub}` : ''}`, rows);
    };
    const off = () => { hover.replaceChildren(); tipLayer.replaceChildren(); };
    hit.addEventListener('pointerenter', on);
    hit.addEventListener('focus', on);
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('blur', off);
  });
}

/**
 * Line chart with crosshair. x is numeric (timestamps or indices).
 * opts: { label, xs:[number], xTicks:[{x,text}], xLabel:(i)=>string,
 *         series:[{name, color, values:[number|null], markers}], yFmt, yTickFmt, yMin, yMax,
 *         ref:{value,text} }
 *         live: element for keyboard read-out }
 */
export function lineChart(canvas, opts) {
  readTokens();
  // right margin fits the direct labels at the line ends
  // (dropped on narrow charts, where the legend alone names the lines)
  const probe = svgEl('svg', {}, canvas);
  const widest = Math.max(...opts.series.map((s) => {
    const t = svgText(probe, 0, 0, s.name, { 'font-size': VALUE_PX });
    return t.getComputedTextLength();
  }));
  probe.remove();
  const endLabels = canvas.clientWidth - widest > 420;
  const fr = frame(canvas, {
    left: 52, right: endLabels ? Math.ceil(widest) + 18 : 12, top: 20, bottom: 30,
  }, opts.label);
  const vals = opts.series.flatMap((s) => s.values.filter((v) => v !== null))
    .concat(opts.ref ? [opts.ref.value] : []);
  const scale = niceScale(opts.yMin ?? Math.min(...vals), opts.yMax ?? Math.max(...vals), 5);
  const y = yAxis(fr, scale, opts.yTickFmt);
  const xmin = opts.xs[0];
  const xmax = opts.xs[opts.xs.length - 1];
  const pad = opts.xPad || 0;
  const span = Math.max(xmax - xmin, 1e-9);
  const x = (v) => fr.x0 + pad + ((v - xmin) / span) * (fr.x1 - fr.x0 - pad * 2);
  const ticks = svgEl('g', { 'aria-hidden': 'true' }, fr.svg);
  let lastTick = -Infinity; // thin the ticks so labels never collide
  opts.xTicks.forEach((t) => {
    if (x(t.x) - lastTick < 60) return;
    lastTick = x(t.x);
    svgText(ticks, x(t.x), fr.y1 + 18, t.text, { 'text-anchor': 'middle' });
  });
  if (opts.ref) {
    const ry = y(opts.ref.value);
    svgEl('line', {
      x1: fr.x0, x2: fr.x1, y1: ry, y2: ry, stroke: COL.axis, 'stroke-width': 1, 'stroke-dasharray': '4 4',
    }, ticks);
    svgText(ticks, fr.x0 + 6, ry - 6, opts.ref.text, { fill: COL.body });
  }
  const lines = svgEl('g', { 'aria-hidden': 'true' }, fr.svg);
  const ends = [];
  opts.series.forEach((s) => {
    if (s.hidden) return;
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(opts.xs[i]).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    svgEl('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, lines);
    if (s.markers) {
      s.values.forEach((v, i) => {
        if (v === null) return;
        svgEl('circle', {
          cx: x(opts.xs[i]), cy: y(v), r: 4, fill: s.color, stroke: fr.ring, 'stroke-width': 2,
        }, lines);
      });
    }
    const last = s.values.map((v, i) => [v, i]).filter(([v]) => v !== null).pop();
    if (last) ends.push({ s, y: y(last[0]), x: x(opts.xs[last[1]]) });
  });
  // direct labels at the line ends, nudged apart so they never overlap
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 15);
  const overflow = ends.length ? ends[ends.length - 1].y - (fr.y1 - 4) : 0;
  if (overflow > 0) ends.forEach((e) => { e.y -= overflow; });
  if (endLabels) {
    ends.forEach((e) => svgText(lines, fr.x1 + 8, e.y, e.s.name, {
      'dominant-baseline': 'middle', 'font-size': VALUE_PX, fill: COL.heading,
    }));
  }

  // hover layer: crosshair + tooltip; keyboard: focus the chart, then arrow keys (read out in a
  // visually hidden live region inside the chart panel)
  const panel = canvas.closest('.cme-chart') || canvas.parentElement;
  let live = panel.querySelector('[data-fw-live]');
  if (!live) {
    live = document.createElement('p');
    live.className = 'cme-visually-hidden';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('data-fw-live', '');
    panel.append(live);
  }
  const cross = svgEl('g', { 'pointer-events': 'none', 'aria-hidden': 'true' }, fr.svg);
  const tipLayer = svgEl('g', {}, fr.svg);
  const hit = svgEl('rect', {
    x: fr.x0, y: fr.y0, width: fr.x1 - fr.x0, height: fr.y1 - fr.y0, fill: 'transparent',
  }, fr.svg);
  let idx = opts.xs.length - 1;
  const show = (i, fromKeys = false) => {
    idx = i;
    cross.replaceChildren();
    const cx = x(opts.xs[i]);
    svgEl('line', {
      x1: cx, x2: cx, y1: fr.y0, y2: fr.y1, stroke: COL.axis, 'stroke-width': 1,
    }, cross);
    const rows = [];
    let anchorY = fr.y1;
    opts.series.forEach((s) => {
      if (s.hidden) return;
      const v = s.values[i];
      rows.push({ color: s.color, label: s.name, value: v === null ? 'no price' : opts.yFmt(v) });
      if (v === null) return;
      anchorY = Math.min(anchorY, y(v));
      svgEl('circle', {
        cx, cy: y(v), r: 5, fill: s.color, stroke: fr.ring, 'stroke-width': 2,
      }, cross);
    });
    showTip(fr, tipLayer, cx, anchorY, opts.xLabel(i), rows);
    if (live && fromKeys) live.textContent = `${opts.xLabel(i)}: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}`;
  };
  const hide = () => { cross.replaceChildren(); tipLayer.replaceChildren(); };
  const nearest = (evt) => {
    const pt = fr.svg.getBoundingClientRect();
    const px = ((evt.clientX - pt.left) / pt.width) * fr.W;
    let best = 0;
    opts.xs.forEach((v, i) => {
      if (Math.abs(x(v) - px) < Math.abs(x(opts.xs[best]) - px)) best = i;
    });
    return best;
  };
  hit.addEventListener('pointermove', (e) => show(nearest(e)));
  hit.addEventListener('pointerdown', (e) => show(nearest(e)));
  hit.addEventListener('pointerleave', hide);
  fr.svg.setAttribute('tabindex', '0');
  fr.svg.addEventListener('focus', () => show(idx, true));
  fr.svg.addEventListener('blur', hide);
  fr.svg.addEventListener('keydown', (e) => {
    const n = opts.xs.length;
    const moves = {
      ArrowLeft: idx - 1, ArrowRight: idx + 1, Home: 0, End: n - 1,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    show(Math.min(n - 1, Math.max(0, moves[e.key])), true);
  });
}

/** FOMC dot plot with futures-implied markers. */
export function dotChart(canvas, opts) {
  readTokens();
  const fr = frame(canvas, {
    left: 52, right: 8, top: 16, bottom: 30,
  }, opts.label);
  const all = opts.groups.flatMap((g) => g.dots.concat(g.implied === null ? [] : [g.implied]));
  const scale = niceScale(Math.min(...all) - 0.125, Math.max(...all) + 0.125, fr.H > 360 ? 8 : 6);
  const y = yAxis(fr, scale, (v) => `${v.toFixed(2)}%`);
  const band = (fr.x1 - fr.x0) / opts.groups.length;
  const marks = svgEl('g', { 'aria-hidden': 'true' }, fr.svg);
  const hover = svgEl('g', {}, fr.svg);
  hover.parentNode.insertBefore(hover, marks);
  const hits = svgEl('g', {}, fr.svg);
  const tipLayer = svgEl('g', {}, fr.svg);
  opts.groups.forEach((g, i) => {
    const cx = fr.x0 + band * (i + 0.5);
    svgText(marks, cx, fr.y1 + 18, g.label, { 'text-anchor': 'middle' });
    const levels = new Map();
    g.dots.forEach((v) => levels.set(v, (levels.get(v) || 0) + 1));
    const maxCount = Math.max(...levels.values());
    // dots shrink on narrow charts so a full row of projections stays readable as dots
    const room = (band * 0.8) / maxCount;
    const r = Math.max(1.75, Math.min(4, (room - 1.5) / 2));
    const step = Math.min(r * 2 + 2, room);
    const half = ((maxCount - 1) * step) / 2 + r;
    const show = opts.show || { dots: true, implied: true, median: true };
    if (show.median) {
      svgEl('line', {
        x1: cx - half - 6,
        x2: cx + half + 6,
        y1: y(g.median),
        y2: y(g.median),
        stroke: COL.series[2],
        'stroke-width': 2,
      }, marks);
    }
    if (show.dots) {
      levels.forEach((count, v) => {
        for (let k = 0; k < count; k += 1) {
          svgEl('circle', {
            cx: cx + (k - (count - 1) / 2) * step,
            cy: y(v),
            r,
            fill: COL.series[0],
            stroke: fr.ring,
            'stroke-width': 1.5,
          }, marks);
        }
      });
    }
    if (show.implied && g.implied !== null) {
      const dx = Math.min(cx + half + 16, cx + band / 2 - 10);
      const dy = y(g.implied);
      svgEl('path', {
        d: `M${dx},${dy - 7}L${dx + 7},${dy}L${dx},${dy + 7}L${dx - 7},${dy}Z`,
        fill: COL.series[1],
        stroke: fr.ring,
        'stroke-width': 2,
      }, marks);
    }
    const dotRange = `${Math.min(...g.dots).toFixed(3)}–${rate(Math.max(...g.dots), 3)}`;
    const rows = [
      show.median && { color: COL.series[2], label: 'FOMC median', value: rate(g.median, 3) },
      show.implied && { color: COL.series[1], label: 'Futures-implied', value: g.implied === null ? 'no price' : rate(g.implied) },
      show.dots && { color: COL.series[0], label: 'Range of dots', value: dotRange },
    ].filter(Boolean);
    const hit = svgEl('rect', {
      x: cx - band / 2,
      y: fr.y0,
      width: band,
      height: fr.y1 - fr.y0,
      fill: 'transparent',
      tabindex: 0,
      role: 'img',
      'aria-label': `${g.label}: ${g.dots.length} projections; ${rows.map((rw) => `${rw.label} ${rw.value}`).join(', ')}`,
    }, hits);
    const on = () => {
      hover.replaceChildren();
      svgEl('rect', {
        x: cx - band / 2 + 4, y: fr.y0, width: band - 8, height: fr.y1 - fr.y0, fill: COL.grid,
      }, hover);
      // beside the column, not over it
      showTip(fr, tipLayer, cx + band / 2, y(g.median), g.label, rows);
    };
    const off = () => { hover.replaceChildren(); tipLayer.replaceChildren(); };
    hit.addEventListener('pointerenter', on);
    hit.addEventListener('focus', on);
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('blur', off);
  });
}

/** Colour of chart series i (0-3) from the design-language tokens. */
export function seriesColor(i) {
  readTokens();
  return COL.series[i];
}
