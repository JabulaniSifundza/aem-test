/**
 * Pieces several widgets share: the order flow (preview → confirm → place), symbol pickers, grids,
 * quote subscriptions. Widgets stay small by building on these.
 */
import { el, clear, uid } from '../ui/dom.js';
import { dialog, toast, confirm } from '../ui/feedback.js';
import { SYMBOLS, getSymbol } from '../../shared/symbols.js';
import { formatQty, formatPrice, LABELS } from '../ui/format.js';
import { ApiError } from '../../shared/protocol.js';

/** @typedef {import('../services.js').Services} Services */
/** @typedef {import('../broker/broker.js').PreOrder} PreOrder */

/**
 * @typedef {Services & {
 *   openTicket: (o: { symbol: string, side?: 'BUY' | 'SELL', type?: PreOrder['type'], price?: string }) => void,
 *   openWidget: (kind: string, params?: Record<string, any>) => void,
 *   root: HTMLElement,
 * }} AppContext
 */

/** One-line description of an order. @param {PreOrder} p */
export function describeOrder(p) {
  const price = p.type === 'LIMIT' || p.type === 'STOP_LIMIT' ? ` at ${formatPrice(p.symbol, p.limitPrice)}` : p.type === 'STOP' ? ` stop ${formatPrice(p.symbol, p.stopPrice)}` : '';
  return `${LABELS.side[p.side]} ${formatQty(p.symbol, p.qty)} ${p.symbol} ${LABELS.type[p.type].toLowerCase()}${price}`;
}

/** @param {unknown} error */
export const errorText = (error) => (error instanceof ApiError || error instanceof Error ? error.message : String(error));

/**
 * Place an order the way the spec asks (P-8): show the preview, then place it with the preview's
 * confirm id. With 1-Click on and `quick` set, skip the preview (ladder and chart buttons).
 * Resolves with the order id, or null if cancelled or rejected (a toast explains why).
 * @param {AppContext} ctx @param {PreOrder} pre @param {{ quick?: boolean }} [o]
 */
export async function placeOrder(ctx, pre, { quick = false } = {}) {
  try {
    if (quick && ctx.settings.oneClick) return (await ctx.broker.placeOrder(pre)).orderId;
    const preview = await ctx.broker.previewOrder(pre);
    const rows = el('dl', { class: 'cme-kv' });
    for (const r of preview.sections[0].rows) rows.append(el('dt', {}, r.title), el('dd', {}, r.value));
    const warnings = preview.warnings.map((w) => el('p', { class: 'cme-tdialog__warning' }, w));
    const side = pre.side === 'BUY' ? 'buy' : 'sell';
    const choice = await dialog({
      title: 'Order preview',
      body: [el('p', { class: 'cme-mb-0' }, describeOrder(pre)), rows, ...warnings],
      buttons: [{ label: 'Cancel', value: 'cancel', kind: 'outline' }, { label: `Place ${LABELS.side[pre.side].toLowerCase()} order`, value: 'place', kind: side }],
    });
    if (choice !== 'place') return null;
    return (await ctx.broker.placeOrder(pre, preview.confirmId)).orderId;
  } catch (error) {
    toast({ title: 'Order rejected', text: errorText(error), type: 'error' });
    return null;
  }
}

/**
 * Cancel an order, asking first unless 1-Click is on.
 * @param {AppContext} ctx @param {import('../broker/host.js').Order} order @param {{ quick?: boolean }} [o]
 */
export async function cancelOrder(ctx, order, { quick = false } = {}) {
  if (!(quick && ctx.settings.oneClick)) {
    const ok = await confirm({ title: 'Cancel order', text: `Cancel ${describeOrder(/** @type {any} */ (order))}?`, confirm: 'Cancel order', cancel: 'Keep order', kind: 'danger' });
    if (!ok) return;
  }
  try { await ctx.broker.cancelOrder(order.id); } catch (error) { toast({ title: 'Could not cancel', text: errorText(error), type: 'error' }); }
}

/**
 * A select of every symbol.
 * @param {{ value: string, label?: string, onChange: (symbol: string) => void, className?: string }} o
 */
export function symbolSelect({ value, label = 'Symbol', onChange, className = '' }) {
  const select = el('select', { class: `cme-tselect ${className}`.trim(), 'aria-label': label, onchange: () => onChange(select.value) });
  for (const s of SYMBOLS) select.appendChild(el('option', { value: s.name, selected: s.name === value }, `${s.name} · ${s.description}`));
  return select;
}

/**
 * @typedef {object} Column
 * @property {string} id
 * @property {string} label
 * @property {boolean} [num]
 * @property {(row: any) => Node | string} cell
 * @property {(row: any) => string} [cellClass]
 * @property {(row: any) => string | number} [sortValue]
 * @property {boolean} [live]   patch() refreshes this column in place (prices), leaving buttons alone
 */

/**
 * A grid that re-renders rows on demand and keeps its sort.
 * @param {{ caption: string, columns: Column[], empty: string, rowKey: (row: any) => string, rowClass?: (row: any) => string, onRow?: (row: any, tr: HTMLTableRowElement) => void }} o
 */
export function createGrid({ caption, columns, empty, rowKey, rowClass, onRow }) {
  /** @type {{ id: string, dir: 1 | -1 } | null} */
  let sort = null;
  /** @type {any[]} */
  let rows = [];
  const tbody = el('tbody');
  const head = el('tr');
  for (const c of columns) {
    const th = el('th', { scope: 'col', class: c.num ? 'cme-num' : null });
    if (c.sortValue) {
      const btn = el('button', { class: 'cme-grid__sort', type: 'button', onclick: () => { sort = sort?.id === c.id ? { id: c.id, dir: sort.dir === 1 ? -1 : 1 } : { id: c.id, dir: 1 }; head.querySelectorAll('.cme-grid__sort').forEach((b) => b.removeAttribute('aria-sort')); btn.setAttribute('aria-sort', sort.dir === 1 ? 'ascending' : 'descending'); draw(); } }, c.label);
      th.appendChild(btn);
    } else if (c.label) th.textContent = c.label;
    else th.appendChild(el('span', { class: 'cme-visually-hidden' }, 'Actions'));
    head.appendChild(th);
  }
  const table = el('table', { class: 'cme-grid' }, el('caption', { class: 'cme-visually-hidden' }, caption), el('thead', {}, head), tbody);
  const wrap = el('div', { class: 'cme-grid-wrap' }, table);

  function draw() {
    clear(tbody);
    let list = rows;
    if (sort) {
      const col = columns.find((c) => c.id === sort?.id);
      if (col?.sortValue) {
        const sv = col.sortValue;
        const dir = sort.dir;
        list = [...rows].sort((a, b) => { const x = sv(a); const y = sv(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      }
    }
    if (!list.length) {
      tbody.appendChild(el('tr', {}, el('td', { class: 'cme-grid__empty', colspan: String(columns.length) }, el('div', { class: 'cme-tempty' }, empty))));
      return;
    }
    for (const row of list) {
      const tr = el('tr', { class: rowClass?.(row) || null, 'data-key': rowKey(row) });
      for (const c of columns) {
        const extra = c.cellClass?.(row) ?? '';
        tr.appendChild(el('td', { class: [c.num ? 'cme-num' : '', extra].filter(Boolean).join(' ') || null }, c.cell(row)));
      }
      onRow?.(row, tr);
      tbody.appendChild(tr);
    }
  }

  return {
    node: wrap,
    /** @param {any[]} next */
    setRows(next) { rows = next; draw(); },
    redraw: draw,
    /** Refresh the live columns of the rows on screen without rebuilding them (keeps clicks and focus). */
    patch() {
      const byKey = new Map(rows.map((r) => [rowKey(r), r]));
      for (const tr of tbody.querySelectorAll('tr[data-key]')) {
        const row = byKey.get(/** @type {HTMLElement} */ (tr).dataset.key ?? '');
        if (!row) continue;
        const tds = tr.children;
        columns.forEach((c, i) => {
          if (!c.live) return;
          const td = /** @type {HTMLElement} */ (tds[i]);
          const content = c.cell(row);
          if (typeof content === 'string') { if (td.textContent !== content) td.textContent = content; } else td.replaceChildren(content);
          td.className = [c.num ? 'cme-num' : '', c.cellClass?.(row) ?? ''].filter(Boolean).join(' ');
        });
        if (rowClass) /** @type {HTMLElement} */ (tr).className = rowClass(row);
      }
    },
  };
}

/**
 * Keep live quotes for some symbols. Returns a stop function.
 * @param {AppContext} ctx @param {string[]} symbols @param {(q: import('../datafeed/datafeed.js').QuoteData) => void} onQuote
 */
export function watchQuotes(ctx, symbols, onQuote) {
  const guid = uid('q');
  ctx.datafeed.getQuotes(symbols, (list) => list.forEach(onQuote), () => {});
  ctx.datafeed.subscribeQuotes(symbols, [], (list) => list.forEach(onQuote), guid);
  return () => ctx.datafeed.unsubscribeQuotes(guid);
}

/** @param {string} symbol */
export const symbolDef = (symbol) => getSymbol(symbol) ?? SYMBOLS[0];
