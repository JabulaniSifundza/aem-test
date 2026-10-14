import { readBlockConfig, getMetadata, toClassName } from './aem.js';

/*
 * Shared by the trading simulator blocks (trading-workspace, trade-chart, price-ladder,
 * order-ticket, markets, watchlist, account-manager, account-strip). The simulator itself lives in
 * /scripts/trading-sim/ (generated from the trading-sim repository; do not edit it here).
 *
 * Every block on a page shares one set of services, so an order placed in the ticket shows in the
 * chart, the ladder and the account manager. Without an API the market runs in the page.
 *
 * Optional rows in any block's table (key | value), all may be left out:
 *   API        URL of a trading gateway that speaks the simulator's protocol
 *   User       practice user name (dev tokens)
 *   Seed       name of the simulated market (same seed, same prices)
 *   Theme      light (default) or dark
 *   Height     the block's height in pixels
 *   Symbol     BTCUSDT, ETHUSDT, SOLUSDT, SPY or QQQ
 *   Resolution 1, 5, 15, 30, 60, 240, 1D, 1W or 1M (charts)
 *   Start      a simulated start time (ISO date and time), for demos and tests
 * Page metadata "trading-api", "trading-seed" and "trading-theme" set page-wide defaults.
 */

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SPY', 'QQQ'];
const RESOLUTIONS = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'];

let servicesPromise = null;

/**
 * Resolves once the page has loaded and the browser is idle, so the simulator never delays the
 * page's first paint or its other blocks.
 */
const afterLoad = () => new Promise((resolve) => {
  const idle = () => {
    if (window.requestIdleCallback) window.requestIdleCallback(() => resolve(), { timeout: 1500 });
    else setTimeout(resolve, 0);
  };
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
});

/** The shell module, loaded once. */
const shell = () => import('./trading-sim/client/shell.js');

/**
 * Reads the block table; unknown rows are ignored and bad values fall back to defaults.
 * @param {Element} block
 */
export function readTradingConfig(block) {
  const raw = readBlockConfig(block);
  const text = (key) => {
    const v = raw[key];
    return (Array.isArray(v) ? v[0] : v || '').toString().trim();
  };
  const symbol = text('symbol').toUpperCase();
  const resolution = text('resolution').toUpperCase().replace(/^D$/, '1D');
  const theme = toClassName(text('theme') || getMetadata('trading-theme'));
  const height = parseInt(text('height'), 10);
  return {
    api: text('api') || getMetadata('trading-api') || null,
    user: text('user') || 'demo',
    seed: text('seed') || getMetadata('trading-seed') || undefined,
    start: Number.isFinite(Date.parse(text('start'))) ? Date.parse(text('start')) : undefined,
    theme: theme === 'dark' ? 'dark' : 'light',
    height: height >= 200 && height <= 2000 ? height : null,
    symbol: SYMBOLS.includes(symbol) ? symbol : 'BTCUSDT',
    resolution: RESOLUTIONS.includes(resolution) ? resolution : null,
    template: toClassName(text('template')) || 'default',
    menu: toClassName(text('menu')) !== 'hidden',
  };
}

/**
 * The page's services, created by the first block that asks.
 * @param {ReturnType<typeof readTradingConfig>} config
 */
export function tradingServices(config) {
  if (!servicesPromise) {
    servicesPromise = import('./trading-sim/client/services.js').then(({ createServices }) => createServices({
      api: config.api,
      user: config.user,
      seed: config.seed,
      start: config.start,
      theme: config.theme,
      // The market runs in a Worker (head.html allows same-origin workers), or on the page
      // thread if the Content Security Policy does not allow it.
    }));
  }
  return servicesPromise;
}

/**
 * Decorates a trading block: reads its table, shows a loading line, then mounts.
 * @param {Element} block
 * @param {(root: HTMLElement, services: object, config: object, sim: object) => unknown} mount
 */
export function decorateTradingBlock(block, mount) {
  const config = readTradingConfig(block);
  const root = document.createElement('div');
  root.className = 'cme-terminal';
  root.dataset.theme = config.theme;
  if (config.theme === 'dark') root.classList.add('cme-inverse');
  if (config.height) block.style.setProperty('--trading-height', `${config.height}px`);
  const status = document.createElement('p');
  status.className = 'ts-boot__text';
  status.setAttribute('role', 'status');
  status.textContent = 'Starting the trading simulator…';
  root.append(status);
  block.replaceChildren(root);
  // Not awaited: EDS shows the page once the first section's blocks have decorated, so the
  // simulator starts after that, in the background, instead of holding up the first paint.
  (async () => {
    try {
      await afterLoad();
      const [services, sim] = await Promise.all([tradingServices(config), shell()]);
      await mount(root, services, config, sim);
    } catch (error) {
      status.textContent = `The trading simulator could not start: ${error.message}. Reload the page to try again.`;
      // eslint-disable-next-line no-console
      console.error(error);
    }
  })();
}

/**
 * A block that shows one widget (or a few) in its own dock.
 * @param {Element} block
 * @param {(config: object) => object} layout a layout for the shell's mountWidgets()
 */
export function decorateWidgetBlock(block, layout) {
  return decorateTradingBlock(block, (root, services, config, sim) => {
    sim.mountWidgets(root, services, layout(config));
  });
}
