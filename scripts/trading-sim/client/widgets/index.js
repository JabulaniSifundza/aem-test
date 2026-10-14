/**
 * The widget registry: every widget the side menu can add, in the simulator's menu order
 * (EXTRACTION.md). Adding a widget is one file and one line here.
 */
import { marketsWidget } from './markets.js';
import { watchlistWidget } from './watchlist.js';
import { chartWidget } from './chart.js';
import { ladderWidget } from './ladder.js';
import { ticketWidget } from './ticket.js';
import { positionsWidget, ordersWidget, executionsWidget, tradeLogWidget } from './account.js';
import { detailsWidget, dataWindowWidget, newsWidget, linkWidgets } from './info.js';

/** @typedef {import('./common.js').AppContext} AppContext */
/** @typedef {import('../ui/dock.js').WidgetDef} WidgetDef */

/** @param {AppContext} ctx @returns {Map<string, WidgetDef>} */
export function widgetDefs(ctx) {
  const defs = [
    marketsWidget(ctx), watchlistWidget(ctx), chartWidget(ctx), ladderWidget(ctx), ticketWidget(ctx),
    positionsWidget(ctx), ordersWidget(ctx), executionsWidget(ctx), tradeLogWidget(ctx),
    detailsWidget(ctx), dataWindowWidget(ctx), newsWidget(ctx), ...linkWidgets(),
  ];
  return new Map(defs.map((d) => [d.kind, d]));
}

/**
 * The side menu: sections and the widgets in each, with their labels, in the simulator's order
 * (its widgets first, then the ones this rewrite adds). `picker` items open the product picker
 * first (client/ui/sheet.js), as the simulator's Chart and Price Ladder do; the picker's titles
 * are the simulator's.
 * @typedef {{ title: string, intro: string, add: string }} Picker
 * @type {Array<{ title: string, items: Array<{ kind: string, label: string, params?: Record<string, any>, picker?: Picker }> }>}
 */
export const MENU = [
  {
    title: 'Add widgets',
    items: [
      { kind: 'markets', label: 'Markets' }, { kind: 'watchlist', label: 'Watchlists' },
      { kind: 'chart', label: 'Chart', picker: { title: 'New chart', intro: 'Please select a product in order to add a chart.', add: 'Add chart' } },
      { kind: 'ladder', label: 'Price Ladder', picker: { title: 'New price ladder', intro: 'Please select a product in order to add a price ladder.', add: 'Add price ladder' } },
      { kind: 'options', label: 'Options' }, { kind: 'positions', label: 'Positions' }, { kind: 'orders', label: 'Orders' },
      { kind: 'commentary', label: 'Commentary' }, { kind: 'calendar', label: 'Calendar' }, { kind: 'news', label: 'News' },
      { kind: 'ticket', label: 'Trade' }, { kind: 'executions', label: 'Executions' }, { kind: 'details', label: 'Symbol details' },
      { kind: 'data-window', label: 'Data window' }, { kind: 'cme-news', label: 'CME news' },
    ],
  },
  { title: 'Challenge', items: [{ kind: 'discover', label: 'Discover' }] },
  {
    title: 'Resources',
    items: [{ kind: 'education', label: 'Education' }, { kind: 'trade-plan', label: 'Trade Plan' }, { kind: 'trade-log', label: 'Trade Log' }],
  },
];
