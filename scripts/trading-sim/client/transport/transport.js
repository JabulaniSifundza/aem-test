/**
 * The one object the datafeed, broker and chart storage use to reach services: three REST
 * clients and two streams (docs/PROTOCOL.md). Nothing above this file knows a URL.
 *
 * createTransport works with any backend that speaks the protocol: the mock server, a real
 * gateway, or the in-browser loopback (which passes its own fetch and WebSocket).
 */
import { createRestClient } from './rest.js';
import { createSocket } from './socket.js';

/**
 * @typedef {object} ServiceUrls
 * @property {string} marketDataUrl
 * @property {string} marketDataStream
 * @property {string} tradeUrl
 * @property {string} tradeStream
 * @property {string} chartsStorageUrl
 */

/**
 * All five URLs from one origin, laid out as the mock server serves them.
 * @param {string} base e.g. "http://localhost:8787"
 * @returns {ServiceUrls}
 */
export function urlsFromBase(base) {
  const http = base.replace(/\/$/, '');
  const ws = http.replace(/^http/, 'ws');
  return {
    marketDataUrl: `${http}/marketdata/v1`,
    marketDataStream: `${ws}/marketdata/v1/stream`,
    tradeUrl: `${http}/trade/v1`,
    tradeStream: `${ws}/trade/v1/stream`,
    chartsStorageUrl: `${http}/charts-storage`,
  };
}

/**
 * @param {object} options
 * @param {ServiceUrls} options.urls
 * @param {import('./tokens.js').TokenSource} options.tokens
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {{ heartbeatMs?: number, timeoutMs?: number, backoff?: { initial: number, max: number, factor: number } }} [options.socketOptions]
 */
export function createTransport({ urls, tokens, fetchImpl, WebSocketImpl, socketOptions = {} }) {
  const getToken = () => tokens.getToken();
  const onUnauthorized = () => tokens.invalidate?.();
  const rest = {
    marketdata: createRestClient({ baseUrl: urls.marketDataUrl, getToken, fetchImpl, onUnauthorized }),
    trade: createRestClient({ baseUrl: urls.tradeUrl, getToken, fetchImpl, onUnauthorized }),
    storage: createRestClient({ baseUrl: urls.chartsStorageUrl, getToken, fetchImpl, onUnauthorized }),
  };
  const streams = {
    marketdata: createSocket({ url: urls.marketDataStream, getToken, WebSocketImpl, onUnauthorized, ...socketOptions }),
    trade: createSocket({ url: urls.tradeStream, getToken, WebSocketImpl, onUnauthorized, ...socketOptions }),
  };
  const stopRefresh = tokens.onRefresh((token) => {
    streams.marketdata.reauthenticate(token);
    streams.trade.reauthenticate(token);
  });
  return {
    rest,
    streams,
    urls,
    user: () => tokens.user(),
    close() {
      stopRefresh();
      streams.marketdata.close();
      streams.trade.close();
      tokens.dispose();
    },
  };
}

/** @typedef {ReturnType<typeof createTransport>} Transport */
