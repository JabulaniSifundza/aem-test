import { decorateWidgetBlock } from '../../scripts/trading-blocks.js';

/*
 * Markets: every symbol with live prices and a Trade button.
 * Rows (all optional): see scripts/trading-blocks.js.
 */
export default function decorate(block) {
  return decorateWidgetBlock(block, () => ({ w: 'markets' }));
}
