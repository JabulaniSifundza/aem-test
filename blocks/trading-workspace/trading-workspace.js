import { decorateTradingBlock } from '../../scripts/trading-blocks.js';

/*
 * Trading workspace: the whole simulator (account header, widget menu, workspace tabs and the
 * dock). Optional rows: Template (default, blank, chart-ladder, multicharts-ladder, options,
 * charts) for a new user's first workspace, Menu (hidden), plus the rows every trading block
 * takes (scripts/trading-blocks.js).
 */
export default function decorate(block) {
  return decorateTradingBlock(block, (root, services, config, sim) => sim.mountSimulator(
    root,
    services,
    { userName: config.user, template: config.template, menu: config.menu },
  ));
}
