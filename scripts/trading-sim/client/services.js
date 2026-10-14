/**
 * Everything a page needs to talk to a backend, created once per page and shared by every widget:
 * transport, datafeed, broker (+ host), chart storage, app records, settings, server clock and an
 * event bus. The plain app and the EDS blocks both start here.
 *
 *   createServices({ api: 'http://localhost:8787' })   real HTTP + WebSocket backend
 *   createServices({})                                  in-page loopback (no server)
 *
 * Start-up:
 *   1. transport: REST clients and two sockets for the backend (or a loopback over a Worker port)
 *   2. datafeed, broker + host, chart storage, app records on top of the transport
 *   3. in parallel, since none needs another: GET /time (widgets show the simulated clock, which
 *      may not be this computer's time), the saved settings (records, falling back to defaults),
 *      and broker.connect() (open the trading stream; load orders, positions, executions, account)
 * Widgets mount after this resolves, so they always start from a loaded account.
 */
import { createTransport, urlsFromBase } from './transport/transport.js';
import { createDevTokenSource } from './transport/tokens.js';
import { createLoopbackTransport } from './transport/loopback.js';
import { createAutoPort } from './transport/auto-port.js';
import { createDatafeed } from './datafeed/datafeed.js';
import { createBroker } from './broker/broker.js';
import { createHost } from './broker/host.js';
import { createSaveLoad } from './storage/save-load.js';
import { createRecords } from './state/records.js';

/**
 * @typedef {object} Settings
 * @property {'light' | 'dark'} theme
 * @property {boolean} oneClick       place orders from the ladder and chart without confirming
 * @property {boolean} menuCollapsed
 */

/** @type {Settings} */
const DEFAULT_SETTINGS = { theme: 'light', oneClick: false, menuCollapsed: false };

/**
 * @param {{ api?: string | null, user?: string, start?: number, seed?: string, inPage?: boolean, theme?: 'light' | 'dark' }} options
 *   inPage: run the loopback on the page's thread even where a Worker is allowed
 *   theme: the theme to use until the user picks one
 */
export async function createServices({ api, user = 'demo', start, seed, inPage = false, theme } = {}) {
  const transport = api
    ? createTransport({ urls: urlsFromBase(api), tokens: createDevTokenSource({ authUrl: `${api.replace(/\/$/, '')}/trade/v1/auth`, user }) })
    : createLoopbackTransport({ user, start, seed, port: createAutoPort({ preferWorker: !inPage }) });
  const host = createHost();
  const datafeed = createDatafeed(transport);
  const broker = createBroker({ transport, host, datafeed });
  const storage = createSaveLoad({ transport });
  const records = createRecords(storage);
  const bus = new EventTarget();

  // The server clock (the simulated time can differ from this computer's) and the saved
  // settings don't depend on each other: ask for both at once, one round trip instead of two.
  // The account load (broker.connect) is independent too, so it joins the same round trip.
  const [serverTime, saved] = await Promise.all([transport.rest.marketdata.get('/time'), records.load('settings', {}), broker.connect()]);
  const clockOffset = serverTime.time * 1000 - Date.now();
  const now = () => Date.now() + clockOffset;

  /** @type {Settings} */
  const settings = { ...DEFAULT_SETTINGS, ...(theme ? { theme } : {}), ...saved };

  return {
    transport, host, datafeed, broker, storage, records, bus, now, mode: api ? 'server' : 'loopback',
    settings,
    /** @template {keyof Settings} K @param {K} key @param {Settings[K]} value */
    setSetting(key, value) {
      settings[key] = value;
      records.save('settings', settings);
      bus.dispatchEvent(new CustomEvent('settings', { detail: { key, value } }));
    },
    /** @param {string} type @param {unknown} [detail] */
    emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); },
    /** @param {string} type @param {(detail: any) => void} fn */
    on(type, fn) {
      const h = (/** @type {Event} */ e) => fn(/** @type {CustomEvent} */ (e).detail);
      bus.addEventListener(type, h);
      return () => bus.removeEventListener(type, h);
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof createServices>>} Services */
