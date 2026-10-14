/**
 * Account widgets (spec §7, requirements AC-2 to AC-7, B-8, UI-4): positions, orders, executions
 * and the trade log. They read the broker's cache and redraw on the host's events.
 */
import { el, iconButton } from '../ui/dom.js';
import { dialog, confirm, openMenu, toast, segmented, switchField, stepper, field } from '../ui/feedback.js';
import { formatPrice, formatQty, formatMoney, formatDateTime, signClass, LABELS } from '../ui/format.js';
import { createGrid, cancelOrder, errorText, symbolDef } from './common.js';
import { D } from '../../shared/decimal.js';
import { SYMBOLS } from '../../shared/symbols.js';

/** @typedef {import('./common.js').AppContext} AppContext */
/** @typedef {import('../broker/host.js').Position} Position */
/** @typedef {import('../broker/host.js').Order} Order */
/** @typedef {import('../broker/host.js').Execution} Execution */

/**
 * Filter pills; calls onChange with the chosen value.
 * @param {string} label @param {string[]} values @param {string} value @param {(v: string) => void} onChange
 */
function pills(label, values, value, onChange) {
  const node = el('div', { class: 'cme-pills', role: 'group', 'aria-label': label });
  for (const v of values) node.appendChild(el('button', { class: 'cme-pill', type: 'button', value: v, 'aria-pressed': String(v === value) }, v));
  node.addEventListener('cme:change', (e) => onChange(/** @type {CustomEvent} */ (e).detail.value));
  return node;
}

/** Subscribe to host events; returns one stop function. @param {AppContext} ctx @param {Array<keyof import('../broker/host.js').HostEvents>} events @param {() => void} fn */
function onHost(ctx, events, fn) {
  let queued = false;
  const run = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(); }); };
  const stops = events.map((e) => ctx.host.on(e, run));
  return () => stops.forEach((s) => s());
}

// =================================================================================== positions

/**
 * Close all or part of a position (UI-4).
 * @param {AppContext} ctx @param {Position} p
 */
export async function closePositionDialog(ctx, p) {
  const s = symbolDef(p.symbol);
  const pct = segmented({ label: 'Share to close', options: ['25', '50', '75', '100'].map((v) => ({ value: v, label: `${v}%` })), value: '100', block: true });
  const qty = stepper({ name: 'qty', value: p.qty, step: s.lot, min: s.lot, max: p.qty, label: 'Quantity' });
  pct.node.addEventListener('cme:change', () => {
    const share = D(pct.value).div(100);
    const amount = D(p.qty).mul(share).div(s.lot).toDecimalPlaces(0, 1).mul(s.lot);
    qty.input.value = (amount.lte(0) ? D(s.lot) : amount).toFixed(D(s.lot).decimalPlaces());
  });
  const body = [
    el('p', { class: 'cme-mb-0' }, `${LABELS.side[p.side]} ${formatQty(p.symbol, p.qty)} ${p.symbol} at ${formatPrice(p.symbol, p.avgPrice)} · unrealized ${formatMoney(p.unrealizedPL, true)}`),
    pct.node, field('Quantity to close', qty.node),
  ];
  const v = await dialog({
    title: `Close ${p.symbol} position`, body,
    buttons: [{ label: 'Cancel', value: 'cancel', kind: 'outline' }, { label: 'Close at market', value: 'close', kind: 'danger', submit: true }],
    onSubmit: async () => {
      try {
        const amount = D(qty.input.value.replace(/,/g, ''));
        await ctx.broker.closePosition(p.id, amount.gte(p.qty) ? undefined : amount.toString());
        return null;
      } catch (error) { return errorText(error); }
    },
  });
  return v === 'close';
}

/**
 * Edit a position's stop loss, take profit or trailing stop (B-8 editPositionBrackets).
 * @param {AppContext} ctx @param {Position} p
 */
export async function bracketsDialog(ctx, p) {
  const s = symbolDef(p.symbol);
  const sl = stepper({ name: 'sl', value: p.stopLoss ?? '', step: s.tick, label: 'Stop loss' });
  const tp = stepper({ name: 'tp', value: p.takeProfit ?? '', step: s.tick, label: 'Take profit' });
  const trailing = switchField({ label: 'Trailing stop', checked: p.trailingStopPips !== null });
  const pips = stepper({ name: 'pips', value: String(p.trailingStopPips ?? 100), step: '1', min: '1', label: 'Trail distance (ticks)' });
  const sync = () => { sl.setDisabled(trailing.checked); pips.setDisabled(!trailing.checked); };
  trailing.sw.addEventListener('cme:change', sync);
  sync();
  const v = await dialog({
    title: `Protect ${p.symbol} position`,
    body: [el('p', { class: 'cme-mb-0' }, `${LABELS.side[p.side]} ${formatQty(p.symbol, p.qty)} at ${formatPrice(p.symbol, p.avgPrice)}. Leave a field empty to remove it.`),
      field('Stop loss price', sl.node), trailing.node, field('Trail distance (ticks)', pips.node), field('Take profit price', tp.node)],
    buttons: [{ label: 'Cancel', value: 'cancel', kind: 'outline' }, { label: 'Save', value: 'save', submit: true }],
    onSubmit: async () => {
      const clean = (/** @type {string} */ x) => x.replace(/,/g, '').trim() || null;
      try {
        await ctx.broker.editPositionBrackets(p.id, {
          stopLoss: trailing.checked ? null : clean(sl.input.value), takeProfit: clean(tp.input.value),
          trailingStopPips: trailing.checked ? Number(clean(pips.input.value)) : null,
        });
        return null;
      } catch (error) { return errorText(error); }
    },
  });
  return v === 'save';
}

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function positionsWidget(ctx) {
  return {
    kind: 'positions', icon: 'positions', title: () => 'Positions',
    create(container, params, api) {
      let filter = params.filter ?? 'All';
      /** @type {any[]} */
      let closed = [];
      const grid = createGrid({
        caption: 'Positions', empty: 'No positions to display', rowKey: (r) => r.key,
        rowClass: (r) => (r.closed ? 'is-muted' : ''),
        columns: [
          { id: 'symbol', label: 'Symbol', cell: (r) => el('button', { class: 'cme-contract', type: 'button', onclick: () => ctx.openWidget('chart', { symbol: r.symbol }) }, r.symbol), sortValue: (r) => r.symbol },
          { id: 'side', label: 'Side', cell: (r) => el('span', { class: `cme-side cme-side--${r.side === 'BUY' ? 'buy' : 'sell'}` }, r.side === 'BUY' ? 'Long' : 'Short') },
          { id: 'qty', label: 'Size', num: true, cell: (r) => formatQty(r.symbol, r.qty) },
          { id: 'entry', label: 'Entry', num: true, cell: (r) => formatPrice(r.symbol, r.avgPrice) },
          { id: 'mark', label: 'Mark / exit', num: true, live: true, cell: (r) => formatPrice(r.symbol, r.closed ? r.exitPrice : r.markPrice) },
          { id: 'upl', label: 'Unrealized P&L', num: true, live: true, cell: (r) => (r.closed ? '–' : formatMoney(r.unrealizedPL, true)), cellClass: (r) => (r.closed ? '' : signClass(r.unrealizedPL)), sortValue: (r) => Number(r.unrealizedPL ?? 0) },
          { id: 'rpl', label: 'Realized P&L', num: true, cell: (r) => formatMoney(r.realizedPL, true), cellClass: (r) => signClass(r.realizedPL) },
          { id: 'sl', label: 'Stop loss', num: true, cell: (r) => (r.trailingStopPips ? `Trail ${r.trailingStopPips}` : formatPrice(r.symbol, r.stopLoss)) },
          { id: 'tp', label: 'Take profit', num: true, cell: (r) => formatPrice(r.symbol, r.takeProfit) },
          { id: 'liq', label: 'Liq. price', num: true, live: true, cell: (r) => formatPrice(r.symbol, r.liquidationPrice) },
          {
            id: 'actions', label: '', cell: (r) => (r.closed ? el('span', { class: 'cme-order-status' }, `Closed ${formatDateTime(r.closedAt)}`) : el('div', { class: 'cme-grid__actions' },
              el('button', { class: 'cme-tbtn cme-tbtn--outline', type: 'button', 'aria-label': `Close ${r.symbol} position`, onclick: () => closePositionDialog(ctx, r) }, 'Close'),
              iconButton('kebab', `More for ${r.symbol} position`, { class: 'cme-icon-btn--sm', 'aria-haspopup': 'menu', onclick: (/** @type {MouseEvent} */ e) => openMenu(/** @type {HTMLElement} */ (e.currentTarget), [
                { label: 'Stop loss and take profit…', onSelect: () => bracketsDialog(ctx, r) },
                { label: 'Reverse position', onSelect: async () => {
                  if (await confirm({ title: 'Reverse position', text: `Turn ${LABELS.side[r.side].toLowerCase()} ${formatQty(r.symbol, r.qty)} ${r.symbol} into the opposite position at market?`, confirm: 'Reverse' })) {
                    try { await ctx.broker.reversePosition(r.id); } catch (error) { toast({ title: 'Could not reverse', text: errorText(error), type: 'error' }); }
                  }
                } },
                { label: 'Open chart', onSelect: () => ctx.openWidget('chart', { symbol: r.symbol }) },
              ], { align: 'right' }) }))),
          },
        ],
      });
      const flatten = el('button', { class: 'cme-tbtn cme-tbtn--quiet', type: 'button', onclick: async () => {
        const open = await ctx.broker.positions();
        if (!open.length) return;
        if (!(await confirm({ title: 'Flatten all positions', text: `Close all ${open.length} positions at market?`, confirm: 'Flatten all', kind: 'danger' }))) return;
        for (const p of open) { try { await ctx.broker.closePosition(p.id); } catch (error) { toast({ title: `Could not close ${p.symbol}`, text: errorText(error), type: 'error' }); } }
      } }, 'Flatten all positions');
      container.append(el('div', { class: 'cme-panel__toolbar' }, pills('Show positions', ['All', 'Open', 'Closed'], filter, (v) => { filter = v; api.setParams({ filter }); draw(); }), el('span', { class: 'cme-terminal-header__spacer' }), flatten), grid.node);

      let lastOpenKeys = '';
      async function draw() {
        const open = (await ctx.broker.positions()).map((p) => ({ ...p, key: p.id }));
        const rows = [...(filter !== 'Closed' ? open : []), ...(filter !== 'Open' ? closed.map((c, i) => ({ ...c, key: `closed-${c.closedAt}-${i}`, closed: true })) : [])];
        flatten.disabled = !open.length;
        const keys = rows.map((r) => r.key + r.qty + r.stopLoss + r.takeProfit + r.trailingStopPips).join('|');
        if (keys === lastOpenKeys) return; // only P&L changed: refreshPl patches the cells
        lastOpenKeys = keys;
        grid.setRows(rows);
      }
      // Live P&L updates patch cells in place; structural changes redraw.
      const refreshPl = async () => {
        const byId = new Map((await ctx.broker.positions()).map((p) => [p.id, p]));
        for (const tr of container.querySelectorAll('tbody tr[data-key]')) {
          const p = byId.get(/** @type {HTMLElement} */ (tr).dataset.key ?? '');
          if (!p) continue;
          const tds = tr.children;
          tds[4].textContent = formatPrice(p.symbol, p.markPrice);
          tds[9].textContent = formatPrice(p.symbol, p.liquidationPrice);
          tds[5].textContent = formatMoney(p.unrealizedPL, true);
          tds[5].className = ['cme-num', signClass(p.unrealizedPL)].filter(Boolean).join(' ');
        }
      };
      const loadClosed = async () => { closed = await ctx.broker.closedPositions(); draw(); };
      const stops = [onHost(ctx, ['position', 'reset'], () => { loadClosed(); }), onHost(ctx, ['pl', 'equity'], refreshPl)];
      loadClosed();
      return { destroy() { stops.forEach((s) => s()); }, state: () => ({ filter }) };
    },
  };
}

// ====================================================================================== orders

/**
 * Change a working order (B-5): quantity, prices and brackets.
 * @param {AppContext} ctx @param {Order} o
 */
export async function modifyOrderDialog(ctx, o) {
  const s = symbolDef(o.symbol);
  const isBracket = o.parentType !== null;
  const qty = stepper({ name: 'qty', value: o.qty, step: s.lot, min: s.lot, label: 'Quantity' });
  const limit = stepper({ name: 'limit', value: o.limitPrice ?? '', step: s.tick, label: 'Limit price' });
  const stop = stepper({ name: 'stop', value: o.stopPrice ?? '', step: s.tick, label: 'Stop price' });
  const sl = stepper({ name: 'sl', value: o.stopLoss ?? '', step: s.tick, label: 'Stop loss' });
  const tp = stepper({ name: 'tp', value: o.takeProfit ?? '', step: s.tick, label: 'Take profit' });
  const body = [el('p', { class: 'cme-mb-0' }, `${LABELS.side[o.side]} ${formatQty(o.symbol, o.qty)} ${o.symbol} ${LABELS.type[o.type].toLowerCase()}${isBracket ? ` (${o.bracket === 'stopLoss' ? 'stop loss' : 'take profit'})` : ''}`)];
  if (!isBracket) body.push(field('Quantity', qty.node));
  if (o.type === 'LIMIT' || o.type === 'STOP_LIMIT') body.push(field('Limit price', limit.node));
  if (o.type === 'STOP' || o.type === 'STOP_LIMIT') body.push(field('Stop price', stop.node));
  if (!isBracket) body.push(field('Stop loss', sl.node), field('Take profit', tp.node));
  const clean = (/** @type {string} */ x) => x.replace(/,/g, '').trim() || null;
  const v = await dialog({
    title: `Modify order ${o.id}`, body,
    buttons: [{ label: 'Cancel', value: 'cancel', kind: 'outline' }, { label: 'Modify order', value: 'save', submit: true }],
    onSubmit: async () => {
      /** @type {any} */
      const changes = { id: o.id };
      if (!isBracket) { changes.qty = clean(qty.input.value); changes.stopLoss = clean(sl.input.value); changes.takeProfit = clean(tp.input.value); }
      if (o.type === 'LIMIT' || o.type === 'STOP_LIMIT') changes.limitPrice = clean(limit.input.value);
      if (o.type === 'STOP' || o.type === 'STOP_LIMIT') changes.stopPrice = clean(stop.input.value);
      try { await ctx.broker.modifyOrder(changes); return null; } catch (error) { return errorText(error); }
    },
  });
  return v === 'save';
}

const ORDER_FILTERS = /** @type {Record<string, (o: Order) => boolean>} */ ({
  All: () => true,
  Working: (o) => ['WORKING', 'PARTIALLY_FILLED', 'INACTIVE', 'PLACING'].includes(o.status),
  Filled: (o) => o.status === 'FILLED',
  Cancelled: (o) => ['CANCELED', 'REJECTED', 'EXPIRED'].includes(o.status),
});
/** @param {Order} o */
const isLive = (o) => ORDER_FILTERS.Working(o);
/** @param {Order} o */
const statusClass = (o) => (isLive(o) ? 'cme-order-status cme-order-status--working' : o.status === 'FILLED' ? 'cme-order-status cme-order-status--filled' : o.status === 'REJECTED' ? 'cme-order-status cme-order-status--rejected' : 'cme-order-status');

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function ordersWidget(ctx) {
  return {
    kind: 'orders', icon: 'orders', title: () => 'Orders',
    create(container, params, api) {
      let filter = params.filter ?? 'All';
      const grid = createGrid({
        caption: 'Orders', empty: 'No orders to display', rowKey: (o) => o.id,
        columns: [
          { id: 'id', label: 'Order ID', cell: (o) => o.id, sortValue: (o) => o.id },
          { id: 'time', label: 'Time', cell: (o) => formatDateTime(o.createdAt), sortValue: (o) => o.createdAt },
          { id: 'symbol', label: 'Symbol', cell: (o) => o.symbol, sortValue: (o) => o.symbol },
          { id: 'side', label: 'Side', cell: (o) => el('span', { class: `cme-side cme-side--${o.side === 'BUY' ? 'buy' : 'sell'}` }, LABELS.side[o.side]) },
          { id: 'type', label: 'Type', cell: (o) => `${LABELS.type[o.type]}${o.bracket === 'stopLoss' ? ' · SL' : o.bracket === 'takeProfit' ? ' · TP' : ''}` },
          { id: 'qty', label: 'Qty', num: true, cell: (o) => formatQty(o.symbol, o.qty) },
          { id: 'filled', label: 'Filled', num: true, cell: (o) => formatQty(o.symbol, o.filledQty) },
          { id: 'limit', label: 'Limit', num: true, cell: (o) => formatPrice(o.symbol, o.limitPrice) },
          { id: 'stop', label: 'Stop', num: true, cell: (o) => formatPrice(o.symbol, o.stopPrice) },
          { id: 'avg', label: 'Avg fill', num: true, cell: (o) => formatPrice(o.symbol, o.avgFillPrice) },
          { id: 'tif', label: 'TIF', cell: (o) => LABELS.duration[o.duration] },
          { id: 'status', label: 'Status', cell: (o) => el('span', { class: statusClass(o), title: o.message ?? '' }, LABELS.status[o.status]), sortValue: (o) => o.status },
          { id: 'actions', label: '', cell: (o) => (isLive(o) ? el('div', { class: 'cme-grid__actions' },
            el('button', { class: 'cme-tbtn cme-tbtn--outline', type: 'button', 'aria-label': `Modify order ${o.id}`, onclick: () => modifyOrderDialog(ctx, o) }, 'Modify'),
            el('button', { class: 'cme-tbtn cme-tbtn--danger', type: 'button', 'aria-label': `Cancel order ${o.id}`, onclick: () => cancelOrder(ctx, o) }, 'Cancel')) : (o.message ? el('span', { class: 'cme-order-status', title: o.message }, o.message.length > 32 ? `${o.message.slice(0, 32)}…` : o.message) : '')) },
        ],
      });
      const cancelAll = el('button', { class: 'cme-tbtn cme-tbtn--quiet', type: 'button', onclick: async () => {
        const working = (await ctx.broker.orders()).filter((o) => isLive(o) && o.parentType === null);
        if (!working.length) return;
        if (await confirm({ title: 'Cancel all orders', text: `Cancel ${working.length} working orders? Stop loss and take profit orders on positions stay.`, confirm: 'Cancel all', kind: 'danger' })) {
          try { await ctx.broker.cancelOrders(); } catch (error) { toast({ title: 'Could not cancel', text: errorText(error), type: 'error' }); }
        }
      } }, 'Cancel all');
      container.append(el('div', { class: 'cme-panel__toolbar' }, pills('Show orders', Object.keys(ORDER_FILTERS), filter, (v) => { filter = v; api.setParams({ filter }); draw(); }), el('span', { class: 'cme-terminal-header__spacer' }), cancelAll), grid.node);
      async function draw() {
        const all = await ctx.broker.orders();
        cancelAll.disabled = !all.some((o) => isLive(o) && o.parentType === null);
        grid.setRows(all.filter(ORDER_FILTERS[filter] ?? ORDER_FILTERS.All).sort((a, b) => b.createdAt - a.createdAt));
      }
      const stop = onHost(ctx, ['order', 'reset'], draw);
      draw();
      return { destroy: stop, state: () => ({ filter }) };
    },
  };
}

// ================================================================================== executions

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function executionsWidget(ctx) {
  return {
    kind: 'executions', icon: 'executions', title: () => 'Executions',
    create(container) {
      const grid = createGrid({
        caption: 'Executions', empty: 'No executions yet', rowKey: (x) => x.id,
        columns: [
          { id: 'id', label: 'Execution ID', cell: (x) => x.id },
          { id: 'order', label: 'Order ID', cell: (x) => x.orderId },
          { id: 'symbol', label: 'Symbol', cell: (x) => x.symbol, sortValue: (x) => x.symbol },
          { id: 'side', label: 'Side', cell: (x) => el('span', { class: `cme-side cme-side--${x.side === 'BUY' ? 'buy' : 'sell'}` }, LABELS.side[x.side]) },
          { id: 'price', label: 'Price', num: true, cell: (x) => formatPrice(x.symbol, x.price) },
          { id: 'qty', label: 'Qty', num: true, cell: (x) => formatQty(x.symbol, x.qty) },
          { id: 'fee', label: 'Commission', num: true, cell: (x) => formatMoney(x.commission) },
          { id: 'pl', label: 'Realized P&L', num: true, cell: (x) => formatMoney(x.realizedPL, true), cellClass: (x) => signClass(x.realizedPL) },
          { id: 'time', label: 'Time', cell: (x) => formatDateTime(x.time), sortValue: (x) => x.time },
        ],
      });
      container.append(grid.node);
      const draw = async () => grid.setRows(await ctx.broker.executions());
      const stop = onHost(ctx, ['execution', 'reset'], draw);
      draw();
      return { destroy: stop };
    },
  };
}

// =================================================================================== trade log

const PERIODS = /** @type {Record<string, number>} */ ({ Today: 1, '7 days': 7, '30 days': 30, All: Infinity });

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function tradeLogWidget(ctx) {
  return {
    kind: 'trade-log', icon: 'trade-log', title: () => 'Trade log',
    create(container, params, api) {
      let period = params.period ?? '7 days';
      let product = params.product ?? 'all';
      /** @type {Record<string, string>} */
      let notes = {};
      /** @type {Map<string, Order>} */
      let orders = new Map();
      /** @type {Execution[]} */
      let rows = [];

      const periodSel = el('select', { class: 'cme-tselect ts-w-sm', 'aria-label': 'Period', onchange: () => { period = periodSel.value; api.setParams({ period }); draw(); } },
        ...Object.keys(PERIODS).map((p) => el('option', { value: p, selected: p === period }, p)));
      const productSel = el('select', { class: 'cme-tselect ts-w-sm', 'aria-label': 'Product', onchange: () => { product = productSel.value; api.setParams({ product }); draw(); } },
        el('option', { value: 'all', selected: product === 'all' }, 'All products'), ...SYMBOLS.map((s) => el('option', { value: s.name, selected: s.name === product }, s.name)));

      const editNote = async (/** @type {Execution} */ x) => {
        const input = el('textarea', { class: 'cme-tinput ts-note', rows: '4', 'aria-label': 'Note', maxlength: '500' });
        input.value = notes[x.id] ?? '';
        if (await dialog({ title: `Note for ${x.symbol} ${LABELS.side[x.side].toLowerCase()} ${formatDateTime(x.time)}`, body: input, buttons: [{ label: 'Cancel', value: '', kind: 'outline' }, { label: 'Save note', value: 'save' }] }) === 'save') {
          if (input.value.trim()) notes[x.id] = input.value.trim(); else delete notes[x.id];
          ctx.records.save('trade-notes', notes);
          draw();
        }
      };
      const order = (/** @type {Execution} */ x) => orders.get(x.orderId);
      const grid = createGrid({
        caption: 'Trade log', empty: 'No trades in this period', rowKey: (x) => x.id,
        columns: [
          { id: 'time', label: 'Date & time', cell: (x) => formatDateTime(x.time), sortValue: (x) => x.time },
          { id: 'effect', label: 'Open/close', cell: (x) => (x.effect === 'open' ? 'Open' : x.effect === 'reverse' ? 'Reverse' : 'Close') },
          { id: 'side', label: 'Buy/sell', cell: (x) => el('span', { class: `cme-side cme-side--${x.side === 'BUY' ? 'buy' : 'sell'}` }, LABELS.side[x.side]) },
          { id: 'symbol', label: 'Symbol', cell: (x) => x.symbol },
          { id: 'qty', label: 'Qty', num: true, cell: (x) => formatQty(x.symbol, x.qty) },
          { id: 'type', label: 'Type', cell: (x) => (order(x) ? LABELS.type[/** @type {Order} */ (order(x)).type] : '–') },
          { id: 'px', label: 'Order px', num: true, cell: (x) => formatPrice(x.symbol, order(x)?.limitPrice ?? order(x)?.stopPrice ?? null) },
          { id: 'tif', label: 'TIF', cell: (x) => (order(x) ? LABELS.duration[/** @type {Order} */ (order(x)).duration] : '–') },
          { id: 'fill', label: 'Fill px', num: true, cell: (x) => formatPrice(x.symbol, x.price) },
          { id: 'fee', label: 'Commission', num: true, cell: (x) => formatMoney(x.commission) },
          { id: 'pl', label: 'P&L', num: true, cell: (x) => formatMoney(x.realizedPL, true), cellClass: (x) => signClass(x.realizedPL) },
          { id: 'note', label: 'Note', cell: (x) => el('button', { class: 'cme-tbtn cme-tbtn--quiet', type: 'button', title: notes[x.id] ?? 'Add a note', onclick: () => editNote(x) }, notes[x.id] ? (notes[x.id].length > 24 ? `${notes[x.id].slice(0, 24)}…` : notes[x.id]) : 'Add note') },
        ],
      });
      const download = el('button', { class: 'cme-tbtn cme-tbtn--outline', type: 'button', onclick: () => {
        const header = ['Date & time', 'Open/close', 'Buy/sell', 'Symbol', 'Qty', 'Type', 'Order px', 'TIF', 'Fill px', 'Commission', 'P&L', 'Note'];
        const lines = rows.map((x) => [new Date(x.time).toISOString(), x.effect, x.side, x.symbol, x.qty, order(x)?.type ?? '', order(x)?.limitPrice ?? order(x)?.stopPrice ?? '', order(x)?.duration ?? '', x.price, x.commission, x.realizedPL, notes[x.id] ?? '']);
        const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `trade-log-${new Date(ctx.now()).toISOString().slice(0, 10)}.csv` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, 'Download CSV');
      container.append(el('div', { class: 'cme-panel__toolbar' }, periodSel, productSel, el('span', { class: 'cme-terminal-header__spacer' }), download), grid.node);

      async function draw() {
        const all = await ctx.broker.executions();
        orders = new Map((await ctx.broker.orders()).map((o) => [o.id, o]));
        const since = ctx.now() - PERIODS[period] * 86_400_000;
        rows = all.filter((x) => (period === 'All' || x.time >= since) && (product === 'all' || x.symbol === product));
        download.disabled = !rows.length;
        grid.setRows(rows);
      }
      ctx.records.load('trade-notes', /** @type {Record<string, string>} */ ({})).then((n) => { notes = n; draw(); });
      const stop = onHost(ctx, ['execution', 'reset'], draw);
      return { destroy: stop, state: () => ({ period, product }) };
    },
  };
}
