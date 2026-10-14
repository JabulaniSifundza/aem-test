/**
 * Price ladder / depth of market (spec §5, requirements D-1 to D-5, P-5). 25 levels a side from the
 * L2 stream, depth bars, the last trade, own working orders, the position, and one-click order
 * entry: click a bid size to buy limit at that price, an ask size to sell. With 1-Click off every
 * order is previewed first.
 *
 * How it stays cheap at four or more updates a second:
 * - Prices are integer tick indexes (price / tick), so the book is two Maps index → size and a
 *   level update is O(1). Decimal arithmetic happens only at the edges (labels, orders).
 * - The DOM is a fixed pool of rows sized to the visible height (a ResizeObserver keeps the
 *   height, so drawing never forces layout). Scrolling relabels rows; it never creates them.
 * - Draws are coalesced to one per animation frame (schedule), and each draw touches only what
 *   changed: price labels are memoised per index, text is written only when it differs, and a
 *   cell's order buttons are rebuilt only when its orders change.
 * Per draw: O(R + W) for R visible rows and W working orders on the symbol.
 */
import { el, iconButton, icon, frameFor } from '../ui/dom.js';
import { dialog, confirm, toast, segmented, switchField, stepper, field } from '../ui/feedback.js';
import { formatPrice, formatQty, formatMoney, signClass } from '../ui/format.js';
import { D } from '../../shared/decimal.js';
import { symbolDef, symbolSelect, watchQuotes, placeOrder, cancelOrder, errorText } from './common.js';

/** @typedef {import('./common.js').AppContext} AppContext */
/** @typedef {import('../broker/host.js').Order} Order */

const ROW_PX = 30;

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function ladderWidget(ctx) {
  return {
    kind: 'ladder', icon: 'ladder', title: (p) => `${p.symbol ?? 'BTCUSDT'} DOM`,
    create(container, params, api) {
      let symbol = params.symbol ?? 'BTCUSDT';
      let s = symbolDef(symbol);
      /** @type {{ avgPrice: boolean, tpOn: boolean, tpTicks: number, slOn: boolean, slTicks: number }} */
      const settings = { avgPrice: true, tpOn: false, tpTicks: 20, slOn: false, slTicks: 20, ...(params.settings ?? {}) };
      /** @type {Map<number, number>} tick index → size */
      let bids = new Map();
      /** @type {Map<number, number>} */
      let asks = new Map();
      /** @type {{ lp?: string, bid?: string, ask?: string, ch?: string, volume?: string }} */
      let quote = {};
      let center = 0;
      let rowsShown = 0;
      /** Whether the ladder keeps the last price in view (off once the user scrolls). */
      let follow = true;
      let depthId = '';
      let stopQuotes = () => {};
      /** Cancels the pending redraw, or null (frameFor: the frame of the window showing the ladder). @type {(() => void) | null} */
      let frame = null;

      // ---------------------------------------------------------------- price <-> tick index
      const tickD = () => D(s.tick);
      const toIndex = (/** @type {string | number} */ price) => Number(D(price).div(tickD()).toDecimalPlaces(0));
      const toPrice = (/** @type {number} */ i) => D(i).mul(tickD()).toFixed(tickD().decimalPlaces());
      /** Formatted price per tick index; rows show the same few dozen prices over and over. @type {Map<number, string>} */
      const labels = new Map();
      /** @param {number} i */
      const label = (i) => {
        let text = labels.get(i);
        if (text === undefined) {
          if (labels.size > 4096) labels.clear(); // bounded: a long scroll session can't grow it forever
          text = formatPrice(symbol, toPrice(i));
          labels.set(i, text);
        }
        return text;
      };
      /** Write text only when it changed (a write replaces the text node and dirties layout). @param {HTMLElement} node @param {string} text */
      const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
      /** @param {HTMLElement} node @param {string} name @param {string} value */
      const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };

      // ---------------------------------------------------------------- controls
      const picker = symbolSelect({ value: symbol, label: 'Symbol', onChange: (v) => setSymbol(v) });
      const positionBox = el('div', { class: 'cme-ladder__position', role: 'status' }, 'Position 0');
      const gear = iconButton('gear', 'Ladder settings', { onclick: () => openSettings() });
      const tif = segmented({ label: 'Time in force', options: [{ value: 'DAY', label: 'Day' }, { value: 'GTC', label: 'GTC' }], value: params.tif ?? 'DAY', block: true });
      const flatten = el('button', { class: 'cme-tbtn', type: 'button', onclick: () => doFlatten() }, 'Flatten');
      const cancelAll = el('button', { class: 'cme-tbtn cme-tbtn--danger', type: 'button', onclick: () => cancelSide(null) }, 'Cancel all');
      const qty = stepper({ name: 'qty', value: params.qty ?? s.minQty, step: s.lot, min: s.minQty, max: s.maxQty, label: 'Quantity' });
      const buyMkt = el('button', { class: 'cme-tbtn cme-tbtn--buy', type: 'button', onclick: () => market('BUY') }, 'Buy mkt');
      const sellMkt = el('button', { class: 'cme-tbtn cme-tbtn--sell', type: 'button', onclick: () => market('SELL') }, 'Sell mkt');
      const bbo = el('div', { class: 'cme-bbo' });
      const head = el('div', { class: 'cme-ladder__head', 'aria-hidden': 'true' }, el('span', {}, 'Qty'), el('span', {}, 'Buy'), el('span', {}, 'Price'), el('span', {}, 'Sell'), el('span', {}, 'Qty'));
      const rows = el('div', { class: 'cme-ladder__rows', role: 'grid', 'aria-label': `${symbol} price ladder`, tabindex: '0' });
      const footer = el('div', { class: 'cme-ladder__footer' },
        iconButton('close', 'Cancel buy orders', { class: 'cme-ladder__cancel', onclick: () => cancelSide('BUY') }, 'sm'),
        iconButton('chevron-up', 'Scroll up', { onclick: () => scroll(Math.max(1, Math.floor(rowsShown / 2))) }),
        iconButton('recenter', 'Centre on the market', { onclick: () => recenter() }),
        iconButton('chevron-down', 'Scroll down', { onclick: () => scroll(-Math.max(1, Math.floor(rowsShown / 2))) }),
        iconButton('close', 'Cancel sell orders', { class: 'cme-ladder__cancel cme-ladder__cancel--sell', onclick: () => cancelSide('SELL') }, 'sm'));
      const controls = el('div', { class: 'cme-ladder__controls' }, picker, el('div', { class: 'ts-ladder-position' }, positionBox, gear),
        tif.node, flatten, cancelAll, buyMkt, qty.node, sellMkt);
      positionBox.style.flex = '1';
      container.appendChild(el('div', { class: 'cme-ladder' }, controls, bbo, head, rows, footer));

      // ---------------------------------------------------------------- row pool
      /** @type {Array<{ row: HTMLElement, cells: HTMLElement[], bidBar: HTMLElement, askBar: HTMLElement, bidQty: HTMLElement, askQty: HTMLElement, index: number }>} */
      const pool = [];
      /** The rows area's height, kept by a ResizeObserver so drawing never forces a layout. */
      let rowsHeight = 0;
      const ro = new ResizeObserver((entries) => { rowsHeight = entries[0].contentRect.height; schedule(); });
      ro.observe(rows);
      function addRow() {
        const bidBar = el('span', { class: 'cme-ladder__bar' });
        const askBar = el('span', { class: 'cme-ladder__bar' });
        const bidQty = el('span', { class: 'cme-ladder__qty' });
        const askQty = el('span', { class: 'cme-ladder__qty' });
        const cells = [
          el('span', { class: 'cme-ladder__cell', role: 'gridcell' }),
          el('button', { class: 'cme-ladder__cell cme-ladder__cell--bid', type: 'button', role: 'gridcell', 'data-col': 'bid' }, bidBar, bidQty),
          el('span', { class: 'cme-ladder__cell cme-ladder__cell--price', role: 'gridcell' }),
          el('button', { class: 'cme-ladder__cell cme-ladder__cell--ask', type: 'button', role: 'gridcell', 'data-col': 'ask' }, askBar, askQty),
          el('span', { class: 'cme-ladder__cell', role: 'gridcell' }),
        ];
        const row = el('div', { class: 'cme-ladder__row', role: 'row' }, ...cells);
        const entry = { row, cells, bidBar, askBar, bidQty, askQty, index: 0 };
        cells[1].addEventListener('click', () => limit('BUY', entry.index));
        cells[3].addEventListener('click', () => limit('SELL', entry.index));
        pool.push(entry);
        rows.appendChild(row);
      }
      /** Grow or shrink the row pool to fill the height; existing rows are kept. */
      function buildRows() {
        const want = Math.max(10, Math.ceil(rowsHeight / ROW_PX) + 1);
        while (pool.length < want) addRow();
        while (pool.length > want) pool.pop()?.row.remove();
        rowsShown = want;
      }

      // ---------------------------------------------------------------- drawing
      /** @type {Order[]} */
      let working = [];
      /** @type {import('../broker/host.js').Position | null} */
      let position = null;

      function schedule() { if (!frame) frame = frameFor(rows, draw); }
      function draw() {
        frame = null;
        buildRows();
        const last = quote.lp ? toIndex(quote.lp) : null;
        const bestAsk = asks.size ? Math.min(...asks.keys()) : null;
        if (!center && last !== null) center = last;
        // Follow the market until the user scrolls; the recentre button resumes following.
        if (follow && last !== null && (last > center + rowsShown / 2 - 2 || last < center - rowsShown / 2 + 2)) center = last;
        const top = center + Math.floor(rowsShown / 2);
        const visibleSizes = [];
        for (let k = 0; k < pool.length; k += 1) { const i = top - k; visibleSizes.push(bids.get(i) ?? 0, asks.get(i) ?? 0); }
        const maxSize = Math.max(1, ...visibleSizes);
        const avg = position && settings.avgPrice ? toIndex(position.avgPrice) : null;
        /** @type {Map<number, Order[]>} */
        const ordersAt = new Map();
        for (const o of working) {
          // A working stop-limit rests at its stop until triggered, then at its limit.
          const px = o.type === 'LIMIT' || (o.type === 'STOP_LIMIT' && o.triggered) ? o.limitPrice : o.stopPrice;
          if (!px) continue;
          const i = toIndex(px);
          const list = ordersAt.get(i);
          if (list) list.push(o); else ordersAt.set(i, [o]);
        }
        for (let k = 0; k < pool.length; k += 1) {
          const p = pool[k];
          const i = top - k;
          p.index = i;
          const priceText = label(i);
          const b = bids.get(i);
          const a = asks.get(i);
          const bText = b ? formatQty(symbol, String(b)) : '';
          const aText = a ? formatQty(symbol, String(a)) : '';
          setText(p.cells[2], priceText);
          setText(p.bidQty, bText);
          setText(p.askQty, aText);
          p.bidBar.style.setProperty('--depth', `${b ? (b / maxSize) * 100 : 0}%`);
          p.askBar.style.setProperty('--depth', `${a ? (a / maxSize) * 100 : 0}%`);
          setAttr(p.cells[1], 'aria-label', `Buy limit at ${priceText}${b ? `, ${bText} bid` : ''}`);
          setAttr(p.cells[3], 'aria-label', `Sell limit at ${priceText}${a ? `, ${aText} offered` : ''}`);
          p.row.classList.toggle('cme-ladder__row--last', i === last);
          p.row.classList.toggle('cme-ladder__row--inside-ask', i === bestAsk);
          p.row.classList.toggle('cme-ladder__row--position', i === avg);
          const here = ordersAt.get(i) ?? [];
          for (const [col, sideName] of /** @type {const} */ ([[0, 'BUY'], [4, 'SELL']])) {
            const mine = here.filter((o) => o.side === sideName);
            // Rebuild a cell's order buttons only when its orders change: the ladder redraws on
            // every depth update, and a button replaced between press and release never clicks.
            const key = `${i}|${mine.map((o) => `${o.id}:${o.qty}:${o.filledQty}`).join(',')}`;
            if (p.cells[col].dataset.orders === key) continue;
            p.cells[col].dataset.orders = key;
            p.cells[col].replaceChildren(...mine.map((o) => el('button', {
              class: `cme-ladder__order${sideName === 'SELL' ? ' cme-ladder__order--sell' : ''}`, type: 'button',
              title: `Cancel ${o.side.toLowerCase()} ${o.type.toLowerCase()} ${formatQty(symbol, o.qty)} at ${priceText}`,
              'aria-label': `Cancel ${o.side.toLowerCase()} order ${formatQty(symbol, o.qty)} at ${priceText}`,
              onclick: () => cancelOrder(ctx, o, { quick: true }),
            }, formatQty(symbol, D(o.qty).minus(o.filledQty).toString()), o.bracket ? (o.bracket === 'stopLoss' ? ' SL' : ' TP') : '', icon('close', 'sm'))));
          }
        }
        const item = (/** @type {string} */ l, /** @type {string} */ v, cls = '') => el('div', { class: 'cme-bbo__item' }, el('span', { class: 'cme-bbo__label' }, l), el('span', { class: `cme-bbo__value ${cls}`.trim() }, v));
        bbo.replaceChildren(item('Bid', formatPrice(symbol, quote.bid)), item('Ask', formatPrice(symbol, quote.ask)), item('Last', formatPrice(symbol, quote.lp)), item('Volume', formatQty(symbol, quote.volume)), item('Change', formatPrice(symbol, quote.ch, true), signClass(quote.ch)));
        positionBox.textContent = position ? `Position ${position.side === 'BUY' ? '' : '−'}${formatQty(symbol, position.qty)} · ${formatMoney(position.unrealizedPL, true)}` : 'Position 0';
        flatten.disabled = !position;
        cancelAll.disabled = !working.length;
      }

      // ---------------------------------------------------------------- data
      /** The symbol's working orders and position from the broker's cache. O(orders held). */
      async function refreshTrading() {
        working = (await ctx.broker.orders()).filter((o) => o.symbol === symbol && ['WORKING', 'PARTIALLY_FILLED'].includes(o.status));
        position = (await ctx.broker.positions()).find((p) => p.symbol === symbol) ?? null;
        schedule();
      }

      function subscribe() {
        bids = new Map(); asks = new Map(); quote = {}; center = 0; follow = true;
        if (depthId) ctx.broker.unsubscribeDepth(depthId);
        depthId = ctx.broker.subscribeDepth(symbol, (d) => {
          if (d.snapshot) { bids = new Map(); asks = new Map(); }
          for (const l of d.bids) { const i = toIndex(l.price); if (l.volume > 0) bids.set(i, l.volume); else bids.delete(i); }
          for (const l of d.asks) { const i = toIndex(l.price); if (l.volume > 0) asks.set(i, l.volume); else asks.delete(i); }
          schedule();
        });
        stopQuotes();
        stopQuotes = watchQuotes(ctx, [symbol], (q) => { if (q.s === 'ok' && q.n === symbol) { quote = q.v; schedule(); } });
        refreshTrading();
      }

      /** @param {string} next */
      function setSymbol(next) {
        symbol = next; s = symbolDef(symbol);
        labels.clear(); // another tick size and price format
        qty.node.dataset.step = s.lot; qty.node.dataset.min = s.minQty; qty.node.dataset.max = s.maxQty; qty.input.value = s.minQty;
        rows.setAttribute('aria-label', `${symbol} price ladder`);
        api.setTitle(`${symbol} DOM`);
        api.setParams({ symbol });
        subscribe();
      }

      // ---------------------------------------------------------------- actions
      const qtyValue = () => qty.input.value.replace(/,/g, '');
      /** @param {'BUY' | 'SELL'} side @param {string} entry */
      function brackets(side, entry) {
        const dir = side === 'BUY' ? 1 : -1;
        const t = tickD();
        return {
          takeProfit: settings.tpOn ? D(entry).plus(t.mul(settings.tpTicks).mul(dir)).toFixed(t.decimalPlaces()) : null,
          stopLoss: settings.slOn ? D(entry).minus(t.mul(settings.slTicks).mul(dir)).toFixed(t.decimalPlaces()) : null,
        };
      }
      /** @param {'BUY' | 'SELL'} side @param {number} index */
      function limit(side, index) {
        const price = toPrice(index);
        placeOrder(ctx, { symbol, side, type: 'LIMIT', qty: qtyValue(), limitPrice: price, duration: /** @type {'DAY' | 'GTC'} */ (tif.value), ...brackets(side, price) }, { quick: true });
      }
      /** @param {'BUY' | 'SELL'} side */
      function market(side) {
        const ref = (side === 'BUY' ? quote.ask : quote.bid) ?? quote.lp ?? '0';
        placeOrder(ctx, { symbol, side, type: 'MARKET', qty: qtyValue(), duration: 'GTC', ...brackets(side, ref) }, { quick: true });
      }
      async function doFlatten() {
        if (!position) return;
        if (!ctx.settings.oneClick && !(await confirm({ title: 'Flatten', text: `Close the ${symbol} position at market?`, confirm: 'Flatten', kind: 'danger' }))) return;
        try { await ctx.broker.closePosition(position.id); } catch (error) { toast({ title: 'Could not flatten', text: errorText(error), type: 'error' }); }
      }
      /** @param {'BUY' | 'SELL' | null} side */
      async function cancelSide(side) {
        const list = working.filter((o) => o.parentType === null && (!side || o.side === side));
        if (!list.length) return;
        const what = side ? `${side === 'BUY' ? 'buy' : 'sell'} orders` : 'orders';
        if (!ctx.settings.oneClick && !(await confirm({ title: `Cancel ${what}`, text: `Cancel ${list.length} working ${symbol} ${what}?`, confirm: 'Cancel orders', kind: 'danger' }))) return;
        try { await ctx.broker.cancelOrders(symbol, side ?? undefined, list.map((o) => o.id)); } catch (error) { toast({ title: 'Could not cancel', text: errorText(error), type: 'error' }); }
      }
      /** @param {number} by */
      function scroll(by) { center += by; follow = false; schedule(); }
      function recenter() { center = quote.lp ? toIndex(quote.lp) : center; follow = true; schedule(); }

      async function openSettings() {
        const avg = switchField({ label: 'Average price', checked: settings.avgPrice });
        const tpOn = switchField({ label: 'Take profit', checked: settings.tpOn });
        const tpTicks = stepper({ name: 'tp', value: String(settings.tpTicks), step: '1', min: '1', label: 'Take profit ticks' });
        const slOn = switchField({ label: 'Stop loss', checked: settings.slOn });
        const slTicks = stepper({ name: 'sl', value: String(settings.slTicks), step: '1', min: '1', label: 'Stop loss ticks' });
        const v = await dialog({
          title: 'Ladder settings',
          body: [avg.node, tpOn.node, field('Take profit distance (ticks)', tpTicks.node), slOn.node, field('Stop loss distance (ticks)', slTicks.node),
            el('p', { class: 'cme-tfield__hint cme-mb-0' }, 'With take profit or stop loss on, every order from this ladder gets those brackets.')],
          buttons: [{ label: 'Cancel', value: 'cancel', kind: 'outline' }, { label: 'Save', value: 'save' }],
        });
        if (v !== 'save') return;
        Object.assign(settings, { avgPrice: avg.checked, tpOn: tpOn.checked, slOn: slOn.checked, tpTicks: Math.max(1, Number(tpTicks.input.value) || 1), slTicks: Math.max(1, Number(slTicks.input.value) || 1) });
        api.setParams({ settings: { ...settings } });
        schedule();
      }

      rows.addEventListener('wheel', (e) => { e.preventDefault(); scroll(e.deltaY < 0 ? 3 : -3); }, { passive: false });
      rows.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); scroll(1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); scroll(-1); }
        if (e.key === 'PageUp') { e.preventDefault(); scroll(rowsShown - 2); }
        if (e.key === 'PageDown') { e.preventDefault(); scroll(-(rowsShown - 2)); }
        if (e.key === 'Home' || e.key === 'c') { e.preventDefault(); recenter(); }
      });
      tif.node.addEventListener('cme:change', () => api.setParams({ tif: tif.value }));
      const stops = [ctx.host.on('order', refreshTrading), ctx.host.on('position', refreshTrading), ctx.host.on('pl', schedule), ctx.host.on('reset', refreshTrading),
        ctx.host.on('pl', () => { ctx.broker.positions().then((ps) => { position = ps.find((p) => p.symbol === symbol) ?? null; schedule(); }); })];
      subscribe();
      return {
        destroy() { stops.forEach((x) => x()); stopQuotes(); if (depthId) ctx.broker.unsubscribeDepth(depthId); frame?.(); ro.disconnect(); },
        resize: schedule,
        show: schedule,
        state: () => ({ symbol, tif: tif.value, qty: qtyValue(), settings: { ...settings } }),
      };
    },
  };
}
