import { decorateWidgetBlock } from '../../scripts/trading-blocks.js';

/*
 * Price ladder (depth of market) with one-click orders. Row: Symbol.
 * Rows (all optional): see scripts/trading-blocks.js.
 */
export default function decorate(block) {
  return decorateWidgetBlock(block, (config) => ({ w: 'ladder', p: { symbol: config.symbol } }));
}
