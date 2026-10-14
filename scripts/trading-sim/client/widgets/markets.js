/**
 * Markets (requirement X-4): every symbol with live last price, change, open, high, low and volume;
 * a Trade button and a row menu (chart, ladder, watchlist, details). Prices flash up or down.
 */
import { el, iconButton } from '../ui/dom.js';
import { openMenu } from '../ui/feedback.js';
import { SYMBOLS } from '../../shared/symbols.js';
import { formatPrice, formatQty, signClass, formatDecimal } from '../ui/format.js';
import { createGrid, watchQuotes } from './common.js';

/** @typedef {import('./common.js').AppContext} AppContext */

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function marketsWidget(ctx) {
  return {
    kind: 'markets',
    icon: 'markets',
    title: () => 'Markets',
    create(container, params, api) {
      /** @type {Map<string, Record<string, any>>} */
      const quotes = new Map();
      let filter = params.assetClass ?? 'all';

      const select = el('select', { class: 'cme-tselect ts-w-md', 'aria-label': 'Asset class', onchange: () => { filter = select.value; api.setParams({ assetClass: filter }); draw(); } },
        el('option', { value: 'all', selected: filter === 'all' }, 'All markets'),
        el('option', { value: 'crypto', selected: filter === 'crypto' }, 'Crypto'),
        el('option', { value: 'stock', selected: filter === 'stock' }, 'Equity ETFs'));

      /** @param {string} s */
      const q = (s) => quotes.get(s) ?? {};
      const grid = createGrid({
        caption: 'Markets',
        empty: 'No markets to display',
        rowKey: (s) => s.name,
        rowClass: (s) => (q(s.name).market_open === false ? 'is-muted' : ''),
        columns: [
          { id: 'name', label: 'Name', cell: (s) => el('span', { class: 'cme-grid__name', title: s.description }, s.description), sortValue: (s) => s.description },
          { id: 'contract', label: 'Contract', cell: (s) => el('button', { class: 'cme-contract', type: 'button', onclick: () => ctx.openWidget('chart', { symbol: s.name }) }, s.name), sortValue: (s) => s.name },
          { id: 'last', label: 'Last price', num: true, cell: (s) => formatPrice(s.name, q(s.name).lp), cellClass: (s) => signClass(q(s.name).ch) },
          { id: 'change', label: 'Change', num: true, cell: (s) => (q(s.name).ch === undefined ? '–' : `${formatPrice(s.name, q(s.name).ch, true)} (${formatDecimal(q(s.name).chp, 2, true)}%)`), cellClass: (s) => signClass(q(s.name).ch), sortValue: (s) => Number(q(s.name).chp ?? 0) },
          { id: 'open', label: 'Open', num: true, cell: (s) => formatPrice(s.name, q(s.name).open_price) },
          { id: 'high', label: 'High', num: true, cell: (s) => formatPrice(s.name, q(s.name).high_price) },
          { id: 'low', label: 'Low', num: true, cell: (s) => formatPrice(s.name, q(s.name).low_price) },
          { id: 'volume', label: 'Volume', num: true, cell: (s) => formatQty(s.name, q(s.name).volume), sortValue: (s) => Number(q(s.name).volume ?? 0) },
          {
            id: 'actions', label: '', cell: (s) => el('div', { class: 'cme-grid__actions' },
              el('button', { class: 'cme-tbtn cme-tbtn--outline', type: 'button', 'aria-label': `Trade ${s.name}`, onclick: () => ctx.openTicket({ symbol: s.name }) }, 'Trade'),
              iconButton('kebab', `More for ${s.name}`, { class: 'cme-icon-btn--sm', 'aria-haspopup': 'menu', onclick: (/** @type {MouseEvent} */ e) => openMenu(/** @type {HTMLElement} */ (e.currentTarget), [
                { label: 'Open chart', onSelect: () => ctx.openWidget('chart', { symbol: s.name }) },
                { label: 'Open price ladder', onSelect: () => ctx.openWidget('ladder', { symbol: s.name }) },
                { label: 'Open order ticket', onSelect: () => ctx.openWidget('ticket', { symbol: s.name }) },
                { label: 'Symbol details', onSelect: () => ctx.openWidget('details', { symbol: s.name }) },
                'separator',
                { label: 'Add to watchlist', onSelect: () => ctx.emit('watchlist:add', s.name) },
              ], { align: 'right' }) })),
          },
        ],
      });

      const visible = () => SYMBOLS.filter((s) => filter === 'all' || s.type === filter);
      const draw = () => grid.setRows(visible());
      container.append(el('div', { class: 'cme-panel__toolbar' }, select), grid.node);
      draw();

      /** @type {Map<string, string>} */
      const lastPrices = new Map();
      const stop = watchQuotes(ctx, SYMBOLS.map((s) => s.name), (quote) => {
        if (quote.s !== 'ok') return;
        quotes.set(quote.n, quote.v);
        const prev = lastPrices.get(quote.n);
        lastPrices.set(quote.n, quote.v.lp);
        const tr = container.querySelector(`tr[data-key="${quote.n}"]`);
        if (!tr) { draw(); return; }
        const s = /** @type {import('../../shared/symbols.js').SymbolDef} */ (SYMBOLS.find((x) => x.name === quote.n));
        const cells = tr.querySelectorAll('td');
        const v = quote.v;
        cells[2].textContent = formatPrice(s.name, v.lp);
        cells[2].className = ['cme-num', signClass(v.ch)].filter(Boolean).join(' ');
        cells[3].textContent = `${formatPrice(s.name, v.ch, true)} (${formatDecimal(v.chp, 2, true)}%)`;
        cells[3].className = ['cme-num', signClass(v.ch)].filter(Boolean).join(' ');
        cells[4].textContent = formatPrice(s.name, v.open_price);
        cells[5].textContent = formatPrice(s.name, v.high_price);
        cells[6].textContent = formatPrice(s.name, v.low_price);
        cells[7].textContent = formatQty(s.name, v.volume);
        tr.classList.toggle('is-muted', v.market_open === false);
        if (prev !== undefined && prev !== v.lp) {
          tr.classList.remove('ts-flash-up', 'ts-flash-down');
          void /** @type {HTMLElement} */ (tr).offsetWidth;
          tr.classList.add(Number(v.lp) > Number(prev) ? 'ts-flash-up' : 'ts-flash-down');
        }
      });
      return { destroy: stop };
    },
  };
}
