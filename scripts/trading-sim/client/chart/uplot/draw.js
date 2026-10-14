/**
 * Canvas renderers for the uPlot chart: price bars in each chart type, volume, the volume profile,
 * trading lines, the last-price tag and execution marks. Each takes the uPlot instance (for its
 * context, plot box and scales) and plain data, and draws inside the plot box only.
 *
 * Everything works on the visible index range only (visibleIndices), so drawing cost follows
 * what is on screen, not how much history is loaded. Coordinates are canvas pixels (CSS × DPR).
 */

/** @typedef {import('../../../vendor/uplot.js').default} UPlot */
/** @typedef {import('../indicators/index.js').Bar} Bar */
/** @typedef {import('./palette.js').Palette} Palette */
/** @typedef {import('../adapter.js').ChartType} ChartType */

/** A colour with an alpha, for #RRGGBB tokens; anything else is returned as it is. @param {string} color @param {number} alpha */
export function withAlpha(color, alpha) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
  return color;
}

/** Run fn with the context clipped to the plot box. @param {UPlot} u @param {() => void} fn */
export function clipped(u, fn) {
  const { ctx, bbox } = u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  try { fn(); } finally { ctx.restore(); }
}

/** The visible bar indices, clamped to the data. @param {UPlot} u @param {number} n */
export function visibleIndices(u, n) {
  const min = /** @type {number} */ (u.scales.x.min), max = /** @type {number} */ (u.scales.x.max);
  return [Math.max(0, Math.floor(min)), Math.min(n - 1, Math.ceil(max))];
}

/** Canvas pixels per bar. @param {UPlot} u */
export function barSpacing(u) {
  const min = /** @type {number} */ (u.scales.x.min), max = /** @type {number} */ (u.scales.x.max);
  return u.bbox.width / Math.max(1, max - min);
}

/** @param {number} v */
const crisp = (v) => Math.round(v) + 0.5;

/**
 * Price bars as candles, hollow candles or OHLC bars. Line and area types are uPlot series.
 *
 * Bars are drawn in two batches, rising then falling: one path for all the wicks (or OHLC
 * strokes) of a colour, one for all its filled bodies, one for its hollow bodies. That is about
 * six canvas calls per frame instead of three per bar; style changes and stroke/fill calls are
 * what cost on a canvas, not the path segments. O(v) for v visible bars.
 * @param {UPlot} u @param {Bar[]} bars @param {ChartType} type @param {Palette} pal
 */
export function drawBars(u, bars, type, pal) {
  if (!bars.length || type === 'line' || type === 'area') return;
  const { ctx } = u;
  const [a, b] = visibleIndices(u, bars.length);
  const space = barSpacing(u);
  // An odd body width keeps the wick centred on whole pixels.
  const body = Math.max(1, Math.round(space * 0.7) - (Math.round(space * 0.7) % 2 === 0 ? 1 : 0));
  const tick = Math.max(2, Math.round(space * 0.35));
  const pxr = devicePixelRatio || 1;
  clipped(u, () => {
    ctx.lineWidth = Math.max(1, Math.round(pxr));
    for (const rising of [true, false]) {
      const color = rising ? pal.up : pal.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      const strokes = new Path2D();   // wicks, OHLC ticks, hollow outlines
      const fills = new Path2D();     // solid bodies
      for (let i = a; i <= b; i += 1) {
        const bar = bars[i];
        if ((bar.close >= bar.open) !== rising) continue;
        const x = crisp(u.valToPos(i, 'x', true));
        const yo = u.valToPos(bar.open, 'y', true), yc = u.valToPos(bar.close, 'y', true);
        const yh = u.valToPos(bar.high, 'y', true), yl = u.valToPos(bar.low, 'y', true);
        if (type === 'bars') {
          strokes.moveTo(x, yh); strokes.lineTo(x, yl);
          strokes.moveTo(x - tick, crisp(yo)); strokes.lineTo(x, crisp(yo));
          strokes.moveTo(x, crisp(yc)); strokes.lineTo(x + tick, crisp(yc));
          continue;
        }
        const top = Math.min(yo, yc), height = Math.max(1, Math.abs(yc - yo));
        strokes.moveTo(x, yh); strokes.lineTo(x, top);
        strokes.moveTo(x, top + height); strokes.lineTo(x, yl);
        const left = Math.round(x - body / 2);
        if (type === 'hollow' && rising && body > 2) strokes.rect(left + 0.5, Math.round(top) + 0.5, body - 1, Math.max(1, Math.round(height) - 1));
        else fills.rect(left, Math.round(top), body, Math.max(1, Math.round(height)));
      }
      ctx.stroke(strokes);
      ctx.fill(fills);
    }
  });
}

/**
 * Volume columns along the bottom fifth of the plot, scaled to the visible maximum. Two batched
 * fills (rising and falling bars). O(v).
 * @param {UPlot} u @param {Bar[]} bars @param {Palette} pal
 */
export function drawVolume(u, bars, pal) {
  if (!bars.length) return;
  const { ctx, bbox } = u;
  const [a, b] = visibleIndices(u, bars.length);
  let max = 0;
  for (let i = a; i <= b; i += 1) max = Math.max(max, bars[i].volume);
  if (!max) return;
  const h = bbox.height * 0.18, base = bbox.top + bbox.height;
  const width = Math.max(1, Math.round(barSpacing(u) * 0.7));
  clipped(u, () => {
    for (const rising of [true, false]) {
      const columns = new Path2D();
      for (let i = a; i <= b; i += 1) {
        const bar = bars[i];
        if ((bar.close >= bar.open) !== rising) continue;
        const vh = Math.max(1, Math.round((bar.volume / max) * h));
        columns.rect(Math.round(u.valToPos(i, 'x', true) - width / 2), base - vh, width, vh);
      }
      ctx.fillStyle = rising ? pal.volUp : pal.volDown;
      ctx.fill(columns);
    }
  });
}

/**
 * Volume at price, as bars from the right edge of the plot (up to a quarter of its width).
 * @param {UPlot} u @param {{ low: number, step: number, volumes: number[], poc: number } | null} profile
 * @param {Palette} pal @param {string} color the indicator's colour, used for the point of control
 */
export function drawProfile(u, profile, pal, color) {
  if (!profile) return;
  const { ctx, bbox } = u;
  const max = Math.max(...profile.volumes);
  if (!max) return;
  const right = bbox.left + bbox.width;
  clipped(u, () => {
    profile.volumes.forEach((vol, r) => {
      const y1 = u.valToPos(profile.low + r * profile.step, 'y', true);
      const y2 = u.valToPos(profile.low + (r + 1) * profile.step, 'y', true);
      const w = (vol / max) * bbox.width * 0.25;
      ctx.fillStyle = r === profile.poc ? withAlpha(color, 0.55) : withAlpha(pal.axis, 0.22);
      ctx.fillRect(right - w, Math.min(y1, y2) + 1, w, Math.max(1, Math.abs(y2 - y1) - 1));
    });
  });
}

/**
 * A horizontal line across the plot.
 * @param {UPlot} u @param {number} price @param {string} color @param {number[]} dash
 */
export function hLine(u, price, color, dash = []) {
  const { ctx, bbox } = u;
  const y = crisp(u.valToPos(price, 'y', true));
  if (y < bbox.top || y > bbox.top + bbox.height) return;
  const pxr = devicePixelRatio || 1;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.round(pxr));
  ctx.setLineDash(dash.map((d) => d * pxr));
  ctx.beginPath();
  ctx.moveTo(bbox.left, y);
  ctx.lineTo(bbox.left + bbox.width, y);
  ctx.stroke();
  ctx.restore();
}

/**
 * A price tag in the right axis gutter (last price, crosshair).
 * @param {UPlot} u @param {number} price @param {string} text @param {string} bg @param {string} fg @param {string} font
 */
export function axisTag(u, price, text, bg, fg, font) {
  const { ctx, bbox } = u;
  const y = Math.round(u.valToPos(price, 'y', true));
  if (y < bbox.top || y > bbox.top + bbox.height) return;
  const pxr = devicePixelRatio || 1;
  const h = 16 * pxr, x = bbox.left + bbox.width + 2 * pxr;
  ctx.save();
  ctx.font = font.replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${Number(n) * pxr}px`);
  const w = ctx.measureText(text).width + 8 * pxr;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x, y - h / 2, w, h, 2 * pxr);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 4 * pxr, y + 0.5 * pxr);
  ctx.restore();
}

/**
 * Execution marks: a triangle under the bar for a buy, over it for a sell (P-10).
 * @param {UPlot} u @param {Bar[]} bars @param {Array<{ index: number, side: 'buy' | 'sell' }>} marks @param {Palette} pal
 */
export function drawMarks(u, bars, marks, pal) {
  const { ctx } = u;
  const pxr = devicePixelRatio || 1;
  const s = 5 * pxr;
  clipped(u, () => {
    for (const m of marks) {
      const bar = bars[m.index];
      if (!bar) continue;
      const x = u.valToPos(m.index, 'x', true);
      ctx.fillStyle = m.side === 'buy' ? pal.buy : pal.sell;
      ctx.strokeStyle = pal.panel;
      ctx.lineWidth = 2 * pxr;
      ctx.beginPath();
      if (m.side === 'buy') {
        const y = u.valToPos(bar.low, 'y', true) + 6 * pxr;
        ctx.moveTo(x, y); ctx.lineTo(x - s, y + s * 1.6); ctx.lineTo(x + s, y + s * 1.6);
      } else {
        const y = u.valToPos(bar.high, 'y', true) - 6 * pxr;
        ctx.moveTo(x, y); ctx.lineTo(x - s, y - s * 1.6); ctx.lineTo(x + s, y - s * 1.6);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    }
  });
}

/**
 * Histogram columns around zero (MACD).
 * @param {UPlot} u @param {Array<number | null>} values @param {Palette} pal
 */
export function drawHistogram(u, values, pal) {
  const { ctx } = u;
  const [a, b] = visibleIndices(u, values.length);
  const width = Math.max(1, Math.round(barSpacing(u) * 0.6));
  const y0 = u.valToPos(0, 'y', true);
  clipped(u, () => {
    for (let i = a; i <= b; i += 1) {
      const v = values[i];
      if (v === null || v === undefined) continue;
      const y = u.valToPos(v, 'y', true);
      ctx.fillStyle = v >= 0 ? pal.volUp : pal.volDown;
      ctx.fillRect(Math.round(u.valToPos(i, 'x', true) - width / 2), Math.min(y, y0), width, Math.max(1, Math.abs(y0 - y)));
    }
  });
}
