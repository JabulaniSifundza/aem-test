/**
 * One simulated backend: market, gateway, storage, REST router and stream hub, wired together.
 * Used by the Node mock server, the browser loopback Worker and the tests.
 */
import { createMarket } from '../engine/market.js';
import { createGateway } from '../engine/gateway.js';
import { createStore } from '../engine/store.js';
import { createRouter } from './router.js';
import { createHub } from './hub.js';

/**
 * @param {object} options
 * @param {string} [options.seed]             market seed: the same seed gives the same prices
 * @param {() => number} [options.now]       the simulation clock (milliseconds)
 * @param {string} [options.startingBalance]
 * @param {import('../engine/store.js').StoreData} [options.storeData]
 * @param {(data: import('../engine/store.js').StoreData) => void} [options.persist]
 * @param {(token: string) => import('./hub.js').Identity | null} options.verify
 * @param {(error: unknown) => void} [options.onError]
 */
export function createSimulation({ seed, now = () => Date.now(), startingBalance, storeData, persist, verify, onError }) {
  const market = createMarket({ seed });
  const gateway = createGateway({ market, startingBalance });
  const store = createStore({ data: storeData, persist, now });
  const router = createRouter({ market, gateway, store, now, onError });
  const hub = createHub({ market, gateway, router, verify, now });
  return { market, gateway, store, router, hub, now };
}

/** @typedef {ReturnType<typeof createSimulation>} Simulation */
