/**
 * The words both sides of the wire agree on: enums, frame names and the order-status rules.
 * Everything here mirrors docs/PROTOCOL.md. Change both together.
 */

/** @typedef {'BUY' | 'SELL'} Side */
/** @typedef {'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | 'TRAILING_STOP'} OrderType */
/** @typedef {'DAY' | 'GTC' | 'IOC' | 'FOK'} Duration */
/**
 * @typedef {'PLACING' | 'INACTIVE' | 'WORKING' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'} OrderStatus
 */

export const SIDES = /** @type {const} */ (['BUY', 'SELL']);
export const ORDER_TYPES = /** @type {const} */ (['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP']);
export const DURATIONS = /** @type {const} */ (['DAY', 'GTC', 'IOC', 'FOK']);

/** Statuses an order can move to from each status (spec §6, requirement O-10). */
export const STATUS_TRANSITIONS = /** @type {Record<OrderStatus, OrderStatus[]>} */ ({
  PLACING: ['WORKING', 'INACTIVE', 'REJECTED'],
  INACTIVE: ['WORKING', 'CANCELED'],
  WORKING: ['FILLED', 'PARTIALLY_FILLED', 'CANCELED', 'EXPIRED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
});

/** Statuses after which an order never changes again. */
export const FINAL_STATUSES = /** @type {OrderStatus[]} */ (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

/** @param {OrderStatus} status */
export const isFinal = (status) => FINAL_STATUSES.includes(status);

/** @param {OrderStatus} from @param {OrderStatus} to */
export const canTransition = (from, to) => STATUS_TRANSITIONS[from].includes(to);

/** Trading gateway events (spec §4). */
export const GATEWAY_EVENTS = /** @type {const} */ ({
  ORDER_UPDATED: 'ORDER_UPDATED',
  POSITION_UPDATED: 'POSITION_UPDATED',
  EXECUTION_FILLED: 'EXECUTION_FILLED',
  EQUITY_UPDATED: 'EQUITY_UPDATED',
});

/** Stream actions sent by the client. */
export const ACTIONS = /** @type {const} */ ({
  AUTH: 'auth',
  PING: 'ping',
  SUBSCRIBE_BARS: 'subscribe_bars',
  UNSUBSCRIBE_BARS: 'unsubscribe_bars',
  SUBSCRIBE_QUOTES: 'subscribe_quotes',
  UNSUBSCRIBE_QUOTES: 'unsubscribe_quotes',
  SUBSCRIBE_L2: 'subscribe_l2',
  UNSUBSCRIBE_L2: 'unsubscribe_l2',
});

/** The two services with a stream, and the three with REST routes. */
export const SERVICES = /** @type {const} */ (['marketdata', 'trade', 'storage']);
/** @typedef {'marketdata' | 'trade' | 'storage'} Service */

/** Depth levels per side (spec §5). */
export const DEPTH_LEVELS = 25;

/**
 * An error a route returns to the client: HTTP status, a stable code and a readable message.
 */
export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** URL path prefix of each REST service, as the mock server and the loopback serve them. */
export const API_PREFIXES = /** @type {Array<[string, Service]>} */ ([
  ['/marketdata/v1', 'marketdata'], ['/trade/v1', 'trade'], ['/charts-storage', 'storage'],
]);

/** URL path of each stream. */
export const STREAM_PATHS = /** @type {Record<string, 'marketdata' | 'trade'>} */ ({
  '/marketdata/v1/stream': 'marketdata', '/trade/v1/stream': 'trade',
});
