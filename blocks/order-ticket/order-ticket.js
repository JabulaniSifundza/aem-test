import { decorateWidgetBlock } from '../../scripts/trading-blocks.js';

/*
 * Order ticket with preview, take profit and stop loss. Row: Symbol.
 * Rows (all optional): see scripts/trading-blocks.js.
 */
export default function decorate(block) {
  return decorateWidgetBlock(block, (config) => ({ w: 'ticket', p: { symbol: config.symbol } }));
}
