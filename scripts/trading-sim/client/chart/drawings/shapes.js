/**
 * Drawing tools (spec §2 chart toolbar). Each shape knows how many points it needs, how to draw
 * itself on a 2D canvas and whether a pointer is on it. Points arrive in canvas pixels inside the
 * plot box; the chart converts to and from time/price. Adding a tool is adding an entry here and
 * one in DRAWING_TOOLS (adapter.js).
 */

/**
 * @typedef {{ x: number, y: number }} Pt
 * @typedef {{ left: number, top: number, width: number, height: number }} Box
 * @typedef {{ color: string, text: string, font: string, pxr: number, selected: boolean, formatPrice: (p: number) => string, prices: number[] }} Style
 * @typedef {object} Shape
 * @property {1 | 2} points
 * @property {(ctx: CanvasRenderingContext2D, pts: Pt[], box: Box, style: Style) => void} draw
 * @property {(pts: Pt[], box: Box, x: number, y: number, tol: number) => boolean} hit
 */

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** Distance from (x, y) to the segment a–b. @param {Pt} a @param {Pt} b @param {number} x @param {number} y */
function segDist(a, b, x, y) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/** The point where the ray a→b leaves the box. @param {Pt} a @param {Pt} b @param {Box} box */
function rayEnd(a, b, box) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!dx && !dy) return b;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (box.left + box.width - a.x) / dx);
  if (dx < 0) t = Math.min(t, (box.left - a.x) / dx);
  if (dy > 0) t = Math.min(t, (box.top + box.height - a.y) / dy);
  if (dy < 0) t = Math.min(t, (box.top - a.y) / dy);
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** @param {CanvasRenderingContext2D} ctx @param {Style} s */
function stroke(ctx, s) {
  ctx.strokeStyle = s.color;
  ctx.lineWidth = (s.selected ? 2 : 1.5) * s.pxr;
}

/** Small squares on the anchor points of a selected drawing. @param {CanvasRenderingContext2D} ctx @param {Pt[]} pts @param {Style} s */
function handles(ctx, pts, s) {
  if (!s.selected) return;
  const r = 4 * s.pxr;
  for (const p of pts) {
    ctx.fillStyle = s.color;
    ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {Pt} a @param {Pt} b */
function line(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** @type {Record<string, Shape>} */
export const SHAPES = {
  hline: {
    points: 1,
    draw(ctx, [a], box, s) {
      stroke(ctx, s);
      line(ctx, { x: box.left, y: a.y }, { x: box.left + box.width, y: a.y });
      ctx.font = s.font;
      ctx.fillStyle = s.color;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      ctx.fillText(s.formatPrice(s.prices[0]), box.left + 4 * s.pxr, a.y - 2 * s.pxr);
      handles(ctx, [a], s);
    },
    hit: ([a], _box, _x, y, tol) => Math.abs(y - a.y) <= tol,
  },
  vline: {
    points: 1,
    draw(ctx, [a], box, s) {
      stroke(ctx, s);
      line(ctx, { x: a.x, y: box.top }, { x: a.x, y: box.top + box.height });
      handles(ctx, [a], s);
    },
    hit: ([a], _box, x, _y, tol) => Math.abs(x - a.x) <= tol,
  },
  trend: {
    points: 2,
    draw(ctx, pts, _box, s) { stroke(ctx, s); line(ctx, pts[0], pts[1]); handles(ctx, pts, s); },
    hit: ([a, b], _box, x, y, tol) => segDist(a, b, x, y) <= tol,
  },
  ray: {
    points: 2,
    draw(ctx, [a, b], box, s) { stroke(ctx, s); line(ctx, a, rayEnd(a, b, box)); handles(ctx, [a, b], s); },
    hit: ([a, b], box, x, y, tol) => segDist(a, rayEnd(a, b, box), x, y) <= tol,
  },
  rect: {
    points: 2,
    draw(ctx, [a, b], _box, s) {
      stroke(ctx, s);
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = s.color;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      handles(ctx, [a, b], s);
    },
    hit([a, b], _box, x, y, tol) {
      const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x), t = Math.min(a.y, b.y), bo = Math.max(a.y, b.y);
      return x >= l - tol && x <= r + tol && y >= t - tol && y <= bo + tol;
    },
  },
  fib: {
    points: 2,
    draw(ctx, [a, b], _box, s) {
      stroke(ctx, s);
      ctx.save();
      ctx.setLineDash([4 * s.pxr, 4 * s.pxr]);
      line(ctx, a, b);
      ctx.restore();
      const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x);
      ctx.font = s.font;
      ctx.fillStyle = s.color;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      FIB_LEVELS.forEach((lv, i) => {
        const y = b.y + (a.y - b.y) * lv;
        ctx.lineWidth = 1 * s.pxr;
        line(ctx, { x: l, y }, { x: r, y });
        ctx.fillText(`${lv} (${s.formatPrice(s.prices[i])})`, l + 2 * s.pxr, y - 1 * s.pxr);
      });
      handles(ctx, [a, b], s);
    },
    hit([a, b], _box, x, y, tol) {
      const l = Math.min(a.x, b.x) - tol, r = Math.max(a.x, b.x) + tol;
      if (x < l || x > r) return false;
      return FIB_LEVELS.some((lv) => Math.abs(y - (b.y + (a.y - b.y) * lv)) <= tol);
    },
  },
};

/**
 * The prices a drawing labels (the hline's price; the fib's levels), from its anchor prices.
 * @param {string} type @param {number[]} prices
 */
export function labelPrices(type, prices) {
  if (type === 'fib') return FIB_LEVELS.map((lv) => prices[1] + (prices[0] - prices[1]) * lv);
  return prices;
}
