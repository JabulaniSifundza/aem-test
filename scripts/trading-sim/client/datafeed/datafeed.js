/**
 * The datafeed adapter (spec §3): the method names, arguments and callback order of the
 * TradingView Charting Library's IDatafeedChartApi and IDatafeedQuotesApi, over our transport.
 * The uPlot chart and the widgets call it the same way the licensed library would.
 *
 * REST bootstraps (config, symbols, history, quotes); the market data stream carries ticks and
 * quotes. Bars are built from ticks on the client. After a reconnect, every bar subscriber's
 * reset callback fires so the chart reloads anything it missed.
 *
 * Bars and quotes reach the chart as numbers (display only); money is never computed from them.
 */
import { createBarAggregator } from './aggregator.js';
import { normalizeResolution } from '../../shared/resolution.js';

/** @typedef {import('./aggregator.js').ChartBar} ChartBar */
/** @typedef {import('../transport/transport.js').Transport} Transport */
/** @typedef {Record<string, any>} SymbolInfo  LibrarySymbolInfo */
/** @typedef {{ from: number, to: number, countBack?: number, firstDataRequest?: boolean }} PeriodParams */
/** @typedef {{ n: string, s: 'ok' | 'error', v: Record<string, any> }} QuoteData */

/** @param {any} b @returns {ChartBar} */
const toBar = (b) => ({ time: b.time, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume) });

/** @param {(...args: any[]) => void} fn @param {...any} args  The library expects callbacks to be asynchronous. */
const later = (fn, ...args) => setTimeout(() => fn(...args), 0);

/** @param {unknown} e */
const reason = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @param {Transport} transport
 */
export function createDatafeed(transport) {
  const rest = transport.rest.marketdata;
  const stream = transport.streams.marketdata;
  /** @type {Promise<any> | null} */
  let config = null;
  /** @type {Map<string, SymbolInfo>} */
  const symbolCache = new Map();
  /** @type {Map<string, ChartBar>} newest bar per "symbol|resolution" from getBars */
  const lastBars = new Map();
  /** @type {Map<string, { symbol: string, resolution: string, aggregator: ReturnType<typeof createBarAggregator>, onTick: (bar: ChartBar) => void, reset: () => void, stop: () => void }>} */
  const barSubs = new Map();
  /** @type {Map<string, { symbols: string[], onRealtime: (data: QuoteData[]) => void }>} */
  const quoteSubs = new Map();
  /** Listeners per symbol: the stream subscription stays until the last one leaves. @type {Map<string, number>} */
  const quoteRefs = new Map();
  /** @type {Map<string, () => void>} */
  const quoteStops = new Map();
  /** @type {Map<string, QuoteData>} */
  const lastQuotes = new Map();

  stream.onFrame((frame) => {
    if (frame.type === 'tick') {
      const t = frame.data;
      const tick = { price: Number(t.price), volume: Number(t.volume), timestamp: t.timestamp };
      for (const sub of barSubs.values()) {
        if (sub.symbol !== t.symbol) continue;
        const bar = sub.aggregator.update(tick);
        if (bar) sub.onTick(bar);
      }
    } else if (frame.type === 'quote') {
      const q = /** @type {QuoteData} */ (frame.data);
      lastQuotes.set(q.n, q);
      for (const sub of quoteSubs.values()) if (sub.symbols.includes(q.n)) sub.onRealtime([q]);
    } else if (frame.type === 'reset') {
      for (const sub of barSubs.values()) if (sub.symbol === frame.symbol) sub.reset();
    }
  });
  stream.onReconnect(() => { for (const sub of barSubs.values()) sub.reset(); });

  const ensureOpen = () => stream.open();

  return {
    /** @param {(config: any) => void} callback */
    onReady(callback) {
      config ??= rest.get('/config');
      config.then((c) => later(callback, c), () => later(callback, { supported_resolutions: [] }));
    },

    /**
     * @param {string} userInput @param {string} exchange @param {string} symbolType
     * @param {(items: any[]) => void} onResult
     */
    searchSymbols(userInput, exchange, symbolType, onResult) {
      rest.get('/search', { query: { query: userInput, exchange: exchange || undefined, type: symbolType || undefined } })
        .then((items) => onResult(items), () => onResult([]));
    },

    /**
     * @param {string} symbolName
     * @param {(info: SymbolInfo) => void} onResolve
     * @param {(reason: string) => void} onError
     */
    resolveSymbol(symbolName, onResolve, onError) {
      const key = String(symbolName).toUpperCase();
      const cached = symbolCache.get(key);
      if (cached) { later(onResolve, cached); return; }
      rest.get('/symbols', { query: { symbol: symbolName } })
        .then((info) => { symbolCache.set(key, info); onResolve(info); }, (e) => onError(reason(e)));
    },

    /**
     * @param {SymbolInfo} symbolInfo @param {string} resolution @param {PeriodParams} period
     * @param {(bars: ChartBar[], meta: { noData: boolean }) => void} onResult
     * @param {(reason: string) => void} onError
     */
    getBars(symbolInfo, resolution, period, onResult, onError) {
      const symbol = symbolInfo.ticker ?? symbolInfo.name;
      rest.get('/history', { query: { symbol, resolution, from: period.from, to: period.to, countback: period.countBack } })
        .then((data) => {
          const bars = (data.bars ?? []).map(toBar);
          const key = `${symbol}|${normalizeResolution(resolution)}`;
          const newest = bars[bars.length - 1];
          if (newest && (period.firstDataRequest || !lastBars.has(key) || newest.time >= /** @type {ChartBar} */ (lastBars.get(key)).time)) lastBars.set(key, newest);
          onResult(bars, { noData: Boolean(data.noData) });
        }, (e) => onError(reason(e)));
    },

    /**
     * @param {SymbolInfo} symbolInfo @param {string} resolution
     * @param {(bar: ChartBar) => void} onTick @param {string} listenerGuid
     * @param {() => void} onResetCacheNeeded
     */
    subscribeBars(symbolInfo, resolution, onTick, listenerGuid, onResetCacheNeeded) {
      ensureOpen();
      const symbol = symbolInfo.ticker ?? symbolInfo.name;
      const res = normalizeResolution(resolution);
      const stop = stream.subscribe(`bars:${listenerGuid}`, { action: 'subscribe_bars', symbol, resolution: res }, { action: 'unsubscribe_bars', symbol, resolution: res });
      barSubs.set(listenerGuid, {
        symbol, resolution: res, aggregator: createBarAggregator(symbol, res, lastBars.get(`${symbol}|${res}`) ?? null), onTick,
        reset: () => {
          const sub = barSubs.get(listenerGuid);
          if (sub) sub.aggregator = createBarAggregator(symbol, res, null);
          onResetCacheNeeded();
        },
        stop,
      });
    },

    /** @param {string} listenerGuid */
    unsubscribeBars(listenerGuid) {
      barSubs.get(listenerGuid)?.stop();
      barSubs.delete(listenerGuid);
    },

    /** @param {(time: number) => void} callback */
    getServerTime(callback) {
      rest.get('/time').then((d) => callback(d.time), () => {});
    },

    /**
     * Executions as chart marks (P-10).
     * @param {SymbolInfo} symbolInfo @param {number} from @param {number} to @param {(marks: any[]) => void} onData
     */
    getMarks(symbolInfo, from, to, onData) {
      rest.get('/marks', { query: { symbol: symbolInfo.ticker ?? symbolInfo.name, from, to } }).then(onData, () => onData([]));
    },

    /** @param {SymbolInfo} symbolInfo @param {number} from @param {number} to @param {(marks: any[]) => void} onData */
    getTimescaleMarks(symbolInfo, from, to, onData) {
      rest.get('/timescale_marks', { query: { symbol: symbolInfo.ticker ?? symbolInfo.name, from, to } }).then(onData, () => onData([]));
    },

    /**
     * 1-minute bars for a volume profile over a long range (spec §3 item 5).
     * @param {SymbolInfo} symbolInfo @param {string} _resolution @param {number} from @param {number} to
     * @param {(bars: ChartBar[]) => void} onData
     */
    getVolumeProfileResolutionBars(symbolInfo, _resolution, from, to, onData) {
      rest.get('/volume-profile-bars', { query: { symbol: symbolInfo.name, from, to } })
        .then((d) => onData((d.bars ?? []).map(toBar)), () => onData([]));
    },

    // ---------------------------------------------------------------- quotes (IDatafeedQuotesApi)

    /**
     * @param {string[]} symbols @param {(data: QuoteData[]) => void} onData @param {(reason: string) => void} onError
     */
    getQuotes(symbols, onData, onError) {
      rest.get('/quotes', { query: { symbols: symbols.join(',') } })
        .then((data) => { for (const q of data) lastQuotes.set(q.n, q); onData(data); }, (e) => onError(reason(e)));
    },

    /**
     * @param {string[]} symbols @param {string[]} fastSymbols
     * @param {(data: QuoteData[]) => void} onRealtime @param {string} listenerGuid
     */
    subscribeQuotes(symbols, fastSymbols, onRealtime, listenerGuid) {
      ensureOpen();
      const all = [...new Set([...symbols, ...fastSymbols])];
      for (const s of all) {
        const count = quoteRefs.get(s) ?? 0;
        quoteRefs.set(s, count + 1);
        if (count === 0) quoteStops.set(s, stream.subscribe(`quote:${s}`, { action: 'subscribe_quotes', symbols: [s] }, { action: 'unsubscribe_quotes', symbols: [s] }));
      }
      quoteSubs.set(listenerGuid, { symbols: all, onRealtime });
      const known = all.map((s) => lastQuotes.get(s)).filter((q) => q !== undefined);
      if (known.length) later(onRealtime, known);
    },

    /** @param {string} listenerGuid */
    unsubscribeQuotes(listenerGuid) {
      const sub = quoteSubs.get(listenerGuid);
      quoteSubs.delete(listenerGuid);
      for (const s of sub?.symbols ?? []) {
        const count = (quoteRefs.get(s) ?? 1) - 1;
        if (count > 0) { quoteRefs.set(s, count); continue; }
        quoteRefs.delete(s);
        quoteStops.get(s)?.();
        quoteStops.delete(s);
      }
    },

    /** The latest quote seen for a symbol, if any (widgets use it to render at once). @param {string} symbol */
    lastQuote: (symbol) => lastQuotes.get(symbol) ?? null,

    /** News headlines for the widget bar (P-20). @param {{ symbol?: string, limit?: number }} [q] */
    news: (q = {}) => rest.get('/news', { query: q }),
  };
}

/** @typedef {ReturnType<typeof createDatafeed>} Datafeed */
