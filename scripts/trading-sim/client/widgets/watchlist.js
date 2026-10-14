/**
 * Watchlists (spec §2 widget bar, P-21): named symbol lists kept on the server; the default list
 * is the spec's BTCUSDT, ETHUSDT, SOLUSDT, SPY, QQQ. Create, rename, delete, add and remove.
 */
import { el, iconButton } from '../ui/dom.js';
import { confirm, openMenu, promptText } from '../ui/feedback.js';
import { DEFAULT_WATCHLIST, SYMBOLS } from '../../shared/symbols.js';
import { formatPrice, signClass, formatDecimal } from '../ui/format.js';
import { createGrid, watchQuotes } from './common.js';

/** @typedef {import('./common.js').AppContext} AppContext */
/** @typedef {Record<string, string[]>} Lists */

/** One shared copy of the lists per page. @type {Promise<{ lists: Lists, save: () => void, changed: EventTarget }> | null} */
let shared = null;
/** @param {AppContext} ctx */
function store(ctx) {
  shared ??= ctx.records.load('watchlists', /** @type {Lists} */ ({ Default: [...DEFAULT_WATCHLIST] })).then((lists) => {
    if (!Object.keys(lists).length) lists.Default = [...DEFAULT_WATCHLIST];
    const changed = new EventTarget();
    ctx.on('watchlist:add', (symbol) => {
      const first = Object.keys(lists)[0];
      if (!lists[first].includes(symbol)) { lists[first].push(symbol); ctx.records.save('watchlists', lists); changed.dispatchEvent(new Event('change')); }
    });
    return { lists, save: () => { ctx.records.save('watchlists', lists); changed.dispatchEvent(new Event('change')); }, changed };
  });
  return shared;
}

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function watchlistWidget(ctx) {
  return {
    kind: 'watchlist',
    icon: 'watchlist',
    title: (p) => p.list && p.list !== 'Default' ? `Watchlist: ${p.list}` : 'Watchlist',
    create(container, params, api) {
      let current = params.list ?? 'Default';
      /** @type {Map<string, Record<string, any>>} */
      const quotes = new Map();
      let stopQuotes = () => {};
      /** @type {Awaited<ReturnType<typeof store>> | null} */
      let s = null;

      const listSelect = el('select', { class: 'cme-tselect ts-w-md', 'aria-label': 'Watchlist', onchange: () => { current = listSelect.value; api.setParams({ list: current }); api.setTitle(this_title()); draw(); } });
      const addSelect = el('select', { class: 'cme-tselect ts-w-sm', 'aria-label': 'Symbol to add' });
      const this_title = () => (current === 'Default' ? 'Watchlist' : `Watchlist: ${current}`);

      const grid = createGrid({
        caption: 'Watchlist', empty: 'This watchlist is empty. Add a symbol above.', rowKey: (sym) => sym,
        columns: [
          { id: 'symbol', label: 'Symbol', cell: (sym) => el('button', { class: 'cme-contract', type: 'button', onclick: () => ctx.openWidget('chart', { symbol: sym }) }, sym), sortValue: (sym) => sym },
          { id: 'last', label: 'Last', num: true, live: true, cell: (sym) => formatPrice(sym, quotes.get(sym)?.lp) },
          { id: 'chg', label: 'Change', num: true, live: true, cell: (sym) => formatPrice(sym, quotes.get(sym)?.ch, true), cellClass: (sym) => signClass(quotes.get(sym)?.ch) },
          { id: 'chp', label: 'Chg %', num: true, live: true, cell: (sym) => (quotes.get(sym)?.chp === undefined ? '–' : `${formatDecimal(quotes.get(sym)?.chp, 2, true)}%`), cellClass: (sym) => signClass(quotes.get(sym)?.ch), sortValue: (sym) => Number(quotes.get(sym)?.chp ?? 0) },
          { id: 'actions', label: '', cell: (sym) => el('div', { class: 'cme-grid__actions' },
            el('button', { class: 'cme-tbtn cme-tbtn--outline', type: 'button', 'aria-label': `Trade ${sym}`, onclick: () => ctx.openTicket({ symbol: sym }) }, 'Trade'),
            iconButton('close', `Remove ${sym}`, { class: 'cme-icon-btn--sm', onclick: () => { if (!s) return; s.lists[current] = s.lists[current].filter((x) => x !== sym); s.save(); } })) },
        ],
      });

      /** @param {string} name */
      const taken = (name) => (s && s.lists[name] ? 'There is already a watchlist with that name.' : null);
      async function rename() {
        if (!s) return;
        const name = await promptText({ title: 'Rename watchlist', label: 'Watchlist name', value: current, confirm: 'Rename', validate: (v) => (v === current ? null : taken(v)) });
        if (!name || !s || name === current) return;
        s.lists[name] = s.lists[current];
        delete s.lists[current];
        current = name; api.setParams({ list: current }); api.setTitle(this_title()); s.save();
      }
      async function create() {
        if (!s) return;
        let n = 1; while (s.lists[`List ${n}`]) n += 1;
        const name = await promptText({ title: 'New watchlist', label: 'Watchlist name', value: `List ${n}`, confirm: 'Create', validate: taken });
        if (!name || !s) return;
        s.lists[name] = [];
        current = name; api.setParams({ list: current }); api.setTitle(this_title()); s.save();
      }
      async function remove() {
        if (!s || Object.keys(s.lists).length <= 1) return;
        if (!(await confirm({ title: 'Delete watchlist', text: `Delete "${current}"?`, confirm: 'Delete', kind: 'danger' }))) return;
        delete s.lists[current];
        current = Object.keys(s.lists)[0]; api.setParams({ list: current }); api.setTitle(this_title()); s.save();
      }

      function draw() {
        if (!s) return;
        if (!s.lists[current]) current = Object.keys(s.lists)[0];
        listSelect.replaceChildren(...Object.keys(s.lists).map((n) => el('option', { value: n, selected: n === current }, n)));
        const members = s.lists[current];
        addSelect.replaceChildren(el('option', { value: '' }, 'Add symbol…'), ...SYMBOLS.filter((x) => !members.includes(x.name)).map((x) => el('option', { value: x.name }, x.name)));
        grid.setRows(members);
        stopQuotes();
        stopQuotes = members.length ? watchQuotes(ctx, members, (q) => { if (q.s === 'ok') { quotes.set(q.n, q.v); grid.patch(); } }) : () => {};
      }

      addSelect.addEventListener('change', () => { if (s && addSelect.value) { s.lists[current].push(addSelect.value); s.save(); } });
      const more = iconButton('kebab', 'Watchlist options', { 'aria-haspopup': 'menu', onclick: () => openMenu(more, [
        { label: 'New watchlist', onSelect: create }, { label: 'Rename', onSelect: rename }, { label: 'Delete', danger: true, disabled: Boolean(s && Object.keys(s.lists).length <= 1), onSelect: remove },
      ], { align: 'right' }) });
      container.append(el('div', { class: 'cme-panel__toolbar' }, listSelect, addSelect, el('span', { class: 'ts-spacer' }), more), grid.node);

      const onChange = () => draw();
      store(ctx).then((x) => { s = x; s.changed.addEventListener('change', onChange); draw(); });
      return { destroy() { stopQuotes(); s?.changed.removeEventListener('change', onChange); } };
    },
  };
}
