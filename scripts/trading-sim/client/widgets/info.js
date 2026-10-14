/**
 * Information widgets: symbol details and the data window (spec §2 widget bar, P-20), the news
 * feed, and the link-out widgets for CME content that lives on cmegroup.com (DECISIONS D5).
 */
import { el, icon } from '../ui/dom.js';
import { formatPrice, formatQty, formatDateTime, formatDecimal, signClass } from '../ui/format.js';
import { symbolDef, symbolSelect, watchQuotes } from './common.js';

/** @typedef {import('./common.js').AppContext} AppContext */

/** @param {Array<[string, string | Node]>} rows */
const kv = (rows) => {
  const dl = el('dl', { class: 'cme-kv' });
  for (const [k, v] of rows) dl.append(el('dt', {}, k), el('dd', {}, v));
  return dl;
};

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function detailsWidget(ctx) {
  return {
    kind: 'details', icon: 'details', title: (p) => `${p.symbol ?? 'BTCUSDT'} details`,
    create(container, params, api) {
      let symbol = params.symbol ?? 'BTCUSDT';
      /** @type {Record<string, any>} */
      let info = {};
      /** @type {Record<string, any>} */
      let q = {};
      let stop = () => {};
      const body = el('div', { class: 'ts-pad' });
      const picker = symbolSelect({ value: symbol, onChange: (v) => { symbol = v; api.setTitle(`${v} details`); api.setParams({ symbol: v }); load(); } });
      container.append(el('div', { class: 'cme-panel__toolbar' }, picker), body);
      const draw = () => {
        const s = symbolDef(symbol);
        body.replaceChildren(
          el('p', { class: 'cme-ticket__title cme-mb-0' }, info.description ?? s.description),
          kv([
            ['Symbol', symbol], ['Exchange', info.exchange ?? s.exchange], ['Type', s.type === 'crypto' ? 'Crypto' : 'Equity ETF'], ['Currency', info.currency_code ?? s.currency],
            ['Session', info.session_display ?? ''], ['Tick size', s.tick], ['Lot size', s.lot], ['Minimum / maximum', `${s.minQty} / ${s.maxQty}`],
            ['Leverage', `up to ${s.leverage.max}×`], ['Commission', s.commission.rate ? `${formatDecimal(Number(s.commission.rate) * 100, 2)}% of value` : `$${s.commission.perUnit} a share, $${s.commission.minimum} minimum`],
            ['Last', formatPrice(symbol, q.lp)], ['Change', el('span', { class: signClass(q.ch) }, `${formatPrice(symbol, q.ch, true)} (${formatDecimal(q.chp, 2, true)}%)`)],
            ['Day range', `${formatPrice(symbol, q.low_price)} – ${formatPrice(symbol, q.high_price)}`], ['Volume', formatQty(symbol, q.volume)],
            ['Market', q.market_open === false ? 'Closed' : 'Open'],
          ]),
          el('p', { class: 'cme-tfield__hint cme-mb-0' }, 'Prices are simulated.'));
      };
      function load() {
        ctx.datafeed.resolveSymbol(symbol, (i) => { info = i; draw(); }, () => {});
        stop();
        stop = watchQuotes(ctx, [symbol], (x) => { if (x.n === symbol && x.s === 'ok') { q = x.v; draw(); } });
        draw();
      }
      load();
      return { destroy: () => stop(), state: () => ({ symbol }) };
    },
  };
}

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function dataWindowWidget(ctx) {
  return {
    kind: 'data-window', icon: 'data-window', title: () => 'Data window',
    create(container) {
      const body = el('div', { class: 'ts-pad' }, el('div', { class: 'cme-tempty' }, 'Move the pointer over a chart to see its values here.'));
      container.append(body);
      const stop = ctx.on('crosshair', (/** @type {{ symbol: string, resolution: string, bar: any, indicators: Array<{ name: string, value: string }> } | null} */ d) => {
        if (!d || !d.bar) return;
        const { symbol, bar } = d;
        body.replaceChildren(el('p', { class: 'cme-ticket__title cme-mb-0' }, `${symbol} · ${d.resolution}`), kv([
          ['Time', formatDateTime(bar.time)], ['Open', formatPrice(symbol, bar.open)], ['High', formatPrice(symbol, bar.high)],
          ['Low', formatPrice(symbol, bar.low)], ['Close', formatPrice(symbol, bar.close)], ['Volume', formatQty(symbol, bar.volume)],
          ...d.indicators.map((i) => /** @type {[string, string]} */ ([i.name, i.value])),
        ]));
      });
      return { destroy: stop };
    },
  };
}

/** @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function newsWidget(ctx) {
  return {
    kind: 'news', icon: 'news', title: () => 'News',
    create(container, params, api) {
      let symbol = params.symbol ?? '';
      const list = el('ul', { class: 'cme-tnews' });
      const picker = el('select', { class: 'cme-tselect ts-w-md', 'aria-label': 'Symbol', onchange: () => { symbol = picker.value; api.setParams({ symbol }); load(); } },
        el('option', { value: '' }, 'All symbols'), ...['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SPY', 'QQQ'].map((s) => el('option', { value: s, selected: s === symbol }, s)));
      container.append(el('div', { class: 'cme-panel__toolbar' }, picker, el('span', { class: 'cme-tfield__hint' }, 'Simulated headlines from simulated prices')), el('div', { class: 'ts-scroll' }, list));
      async function load() {
        const items = await ctx.datafeed.news({ symbol: symbol || undefined, limit: 40 });
        if (!items.length) { list.replaceChildren(el('li', { class: 'cme-tempty' }, 'No headlines in the last week')); return; }
        list.replaceChildren(...items.map((/** @type {any} */ n) => el('li', { class: 'cme-tnews__item' },
          el('div', { class: 'cme-tnews__meta' }, el('span', {}, formatDateTime(n.time)), el('span', {}, n.symbol), el('span', {}, n.source)),
          el('p', { class: 'cme-tnews__title' }, n.title), el('p', { class: 'cme-tnews__summary' }, n.summary))));
      }
      load();
      const timer = setInterval(load, 60_000);
      return { destroy: () => clearInterval(timer), state: () => ({ symbol }) };
    },
  };
}

/**
 * CME content widgets that link out (simulator menu items whose content is CME's own). Every URL
 * was checked on 13 Oct 2026.
 */
export const LINK_WIDGETS = [
  { kind: 'options', icon: 'options', title: 'Options', text: 'Options chains and strategies for CME products.', link: 'Options on cmegroup.com', href: 'https://www.cmegroup.com/markets/options.html' },
  { kind: 'calendar', icon: 'calendar', title: 'Economic calendar', text: 'Upcoming economic releases and events.', link: 'Open the calendar', href: 'https://www.cmegroup.com/education/events/economic-releases-calendar.html' },
  { kind: 'commentary', icon: 'commentary', title: 'Commentary', text: 'Product analysis and market commentary from CME Group.', link: 'Read the commentary', href: 'https://www.cmegroup.com/insights/product-analysis-and-commentary.html' },
  { kind: 'cme-news', icon: 'news', title: 'CME news', text: 'Press releases from CME Group.', link: 'Open the news room', href: 'https://www.cmegroup.com/media-room/press-releases.html' },
  { kind: 'discover', icon: 'discover', title: 'Discover', text: 'Trading challenges to practise against other traders.', link: 'See the trading challenge', href: 'https://www.cmegroup.com/education/trading-challenge.html' },
  { kind: 'education', icon: 'education', title: 'Education', text: 'Courses on futures, options and trading.', link: 'Start learning', href: 'https://www.cmegroup.com/education.html' },
  { kind: 'trade-plan', icon: 'trade-plan', title: 'Trade plan', text: 'How to build a trade plan before you trade.', link: 'Build a trade plan', href: 'https://www.cmegroup.com/education/courses/building-a-trade-plan.html' },
];

/** @returns {import('../ui/dock.js').WidgetDef[]} */
export function linkWidgets() {
  return LINK_WIDGETS.map((w) => ({
    kind: w.kind, icon: w.icon, title: () => w.title,
    create(container) {
      container.append(el('div', { class: 'cme-widget-link' },
        icon(w.icon, undefined, 'cme-widget-link__icon'),
        el('h3', { class: 'cme-widget-link__title' }, w.title),
        el('p', { class: 'cme-widget-link__text' }, `${w.text} This content lives on cmegroup.com.`),
        el('a', { class: 'cme-tbtn cme-tbtn--outline', href: w.href, target: '_blank', rel: 'noopener' }, w.link)));
      return { destroy() {} };
    },
  }));
}
