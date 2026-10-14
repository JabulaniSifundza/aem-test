import { decorateTradingBlock } from '../../scripts/trading-blocks.js';

/*
 * Account strip: practice funds, profit/loss, margin and available funds, the clock, the
 * 1-Click switch and the user menu (theme, reset account). Rows: see scripts/trading-blocks.js.
 */
export default function decorate(block) {
  return decorateTradingBlock(block, (root, services, config, sim) => {
    sim.mountAccountStrip(root, services, { userName: config.user });
  });
}
