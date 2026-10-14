import { decorateWidgetBlock } from '../../scripts/trading-blocks.js';

/*
 * Watchlist: the default list (BTCUSDT, ETHUSDT, SOLUSDT, SPY, QQQ) and the user's own lists.
 * Rows (all optional): see scripts/trading-blocks.js.
 */
export default function decorate(block) {
  return decorateWidgetBlock(block, () => ({ w: 'watchlist' }));
}
