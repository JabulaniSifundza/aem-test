import { decorateWidgetBlock } from '../../scripts/trading-blocks.js';

/*
 * Account manager: positions, orders, executions and the trade log as tabs.
 * Rows (all optional): see scripts/trading-blocks.js.
 */
export default function decorate(block) {
  return decorateWidgetBlock(block, () => ([{ w: 'positions' }, { w: 'orders' }, { w: 'executions' }, { w: 'trade-log' }]));
}
