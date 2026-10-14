import { decorateWidgetBlock } from '../../scripts/trading-blocks.js';

/*
 * Trade chart: candles, indicators, drawings and trading on the chart. Rows: Symbol, Resolution.
 * Rows (all optional): see scripts/trading-blocks.js.
 */
export default function decorate(block) {
  return decorateWidgetBlock(block, (config) => ({ w: 'chart', p: { symbol: config.symbol, resolution: config.resolution || '1D' } }));
}
