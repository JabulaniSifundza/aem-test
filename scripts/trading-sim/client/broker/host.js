/**
 * The broker's host: what the TradingView library calls IBrokerConnectionAdapterHost.
 * The broker reports changes to it (orderUpdate, positionUpdate, …); widgets subscribe to it.
 * With the licensed library, the library provides its own host and the same broker plugs in.
 *
 * A tiny typed event bus: listeners per event name in a Set (O(1) add/remove), and a throwing
 * listener is logged without stopping the others.
 */

/** @typedef {import('../../engine/orders.js').Order} Order */
/** @typedef {import('../../engine/gateway.js').PositionWire} Position */
/** @typedef {import('../../engine/gateway.js').Execution} Execution */
/**
 * @typedef {object} Equity
 * @property {string} equity
 * @property {string} unrealizedPL
 * @property {string} [balance]
 * @property {string} [marginUsed]
 * @property {string} [freeMargin]
 */
/** @typedef {{ title: string, text: string, type: 'success' | 'error' | 'info' }} Notification */
/** @typedef {'connecting' | 'connected' | 'disconnected'} ConnectionStatus */

/**
 * @typedef {object} HostEvents
 * @property {Order} order
 * @property {Position} position
 * @property {Execution} execution
 * @property {Equity} equity
 * @property {{ positionId: string, pl: string }} pl
 * @property {Notification} notification
 * @property {ConnectionStatus} connection
 * @property {void} reset   everything was reloaded (after a reconnect or an account reset)
 */

export function createHost() {
  /** @type {Map<keyof HostEvents, Set<(value: any) => void>>} */
  const listeners = new Map();

  /**
   * @template {keyof HostEvents} K
   * @param {K} event @param {HostEvents[K]} value
   */
  function emit(event, value) {
    for (const l of listeners.get(event) ?? []) {
      try { l(value); } catch (error) { console.error(error); }
    }
  }

  return {
    /** @param {Order} order */ orderUpdate: (order) => emit('order', order),
    /** @param {Position} position */ positionUpdate: (position) => emit('position', position),
    /** @param {Execution} execution */ executionUpdate: (execution) => emit('execution', execution),
    /** @param {Equity} equity */ equityUpdate: (equity) => emit('equity', equity),
    /** @param {string} positionId @param {string} pl */ plUpdate: (positionId, pl) => emit('pl', { positionId, pl }),
    /** @param {string} title @param {string} text @param {Notification['type']} [type] */
    showNotification: (title, text, type = 'info') => emit('notification', { title, text, type }),
    /** @param {ConnectionStatus} status */ connectionStatusUpdate: (status) => emit('connection', status),
    reset: () => emit('reset', undefined),
    /**
     * @template {keyof HostEvents} K
     * @param {K} event @param {(value: HostEvents[K]) => void} cb
     * @returns {() => void}
     */
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => { set.delete(cb); };
    },
  };
}

/** @typedef {ReturnType<typeof createHost>} Host */
