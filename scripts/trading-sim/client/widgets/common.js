/**
 * Pieces several widgets share: the order flow (preview → confirm → place), symbol pickers, grids,
 * quote subscriptions. Widgets stay small by building on these.
 *
 * AppContext is what every widget receives: the services (transport, datafeed, broker, host,
 * storage, settings, records) plus the shell's openTicket/openWidget and its root element.
 */
import { el, uid } from '../ui/dom.js';
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
 * A table of records that keeps its sort, re-renders on demand, and stays fast as histories grow.
 *
 * Rendering is keyed: each row's <tr> is remembered by rowKey, and when `rowVersion` is given and
 * returns the same value as last time (by ===), the existing row is reused instead of rebuilt.
 * The broker replaces an order or execution object whenever it changes, so `rowVersion: (r) => r`
 * makes an order event rebuild one row, not the whole table, and keeps focus on reused buttons.
 * Only the first `pageSize` rows are in the DOM; a "Show more" row adds another page.
 *
 * Cost of setRows(n rows): O(n) to key them (O(n log n) if the user sorted a column), plus DOM
 * work for the rows that changed among the ≤ limit shown.
 *
 * @param {{
 *   caption: string, columns: Column[], empty: string, rowKey: (row: any) => string,
 *   rowClass?: (row: any) => string, onRow?: (row: any, tr: HTMLTableRowElement) => void,
 *   rowVersion?: (row: any) => unknown, pageSize?: number,
 * }} o
 */
export function createGrid({ caption, columns, empty, rowKey, rowClass, onRow, rowVersion, pageSize = 200 }) {
  /** @type {{ id: string, dir: 1 | -1 } | null} */
  let sort = null;
  /** @type {any[]} */
  let rows = [];
  let limit = pageSize;
  /** Rendered rows by key, with the version they were built from. @type {Map<string, { version: unknown, tr: HTMLTableRowElement }>} */
  const rendered = new Map();
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

  /** One <tr> for a record. @param {any} row */
  function build(row) {
    const tr = /** @type {HTMLTableRowElement} */ (el('tr', { class: rowClass?.(row) || null, 'data-key': rowKey(row) }));
    for (const c of columns) {
      const extra = c.cellClass?.(row) ?? '';
      tr.appendChild(el('td', { class: [c.num ? 'cme-num' : '', extra].filter(Boolean).join(' ') || null }, c.cell(row)));
    }
    onRow?.(row, tr);
    return tr;
  }

  function draw() {
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
      rendered.clear();
      tbody.replaceChildren(el('tr', {}, el('td', { class: 'cme-grid__empty', colspan: String(columns.length) }, el('div', { class: 'cme-tempty' }, empty))));
      return;
    }
    const shown = list.length > limit ? list.slice(0, limit) : list;
    /** @type {Set<string>} */
    const used = new Set();
    /** @type {HTMLTableRowElement[]} */
    const wanted = [];
    for (const row of shown) {
      const key = rowKey(row);
      const version = rowVersion ? rowVersion(row) : undefined;
      let entry = rendered.get(key);
      if (!entry || !rowVersion || entry.version !== version) {
        entry = { version, tr: build(row) };
        rendered.set(key, entry);
      }
      used.add(key);
      wanted.push(entry.tr);
    }
    for (const key of rendered.keys()) if (!used.has(key)) rendered.delete(key); // only what is shown is kept
    if (list.length > shown.length) {
      const more = Math.min(pageSize, list.length - shown.length);
      wanted.push(/** @type {HTMLTableRowElement} */ (el('tr', { class: 'cme-grid__more' }, el('td', { colspan: String(columns.length) },
        el('button', { class: 'cme-tbtn cme-tbtn--quiet', type: 'button', onclick: () => { limit += pageSize; draw(); } },
          `Show ${more} more (${shown.length} of ${list.length})`)))));
    }
    // Reconcile in place: walk the wanted rows against what is in the table and insert only the
    // ones not already in position. A row that stays is never detached, which matters because
    // detaching a node drops keyboard focus inside it. O(rows shown) DOM operations at most.
    // Rows that are no longer wanted (a rebuilt row's old <tr>, a filtered-out order) are removed
    // as the walk meets them; otherwise the cursor would stick on one and every later row would
    // be moved in front of it.
    const keep = new Set(wanted);
    let cursor = tbody.firstChild;
    const skipStale = () => { while (cursor && !keep.has(/** @type {HTMLTableRowElement} */ (cursor))) { const next = cursor.nextSibling; cursor.remove(); cursor = next; } };
    for (const tr of wanted) {
      skipStale();
      if (tr === cursor) { cursor = cursor.nextSibling; continue; }
      tbody.insertBefore(tr, cursor);
    }
    skipStale();
  }

  return {
    node: wrap,
    /** @param {any[]} next */
    setRows(next) { rows = next; draw(); },
    redraw: draw,
    /** Refresh the live columns of the rows on screen without rebuilding them (keeps clicks and focus). O(rows shown). */
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
