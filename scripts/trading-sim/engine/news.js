/**
 * Mock headlines for the widget bar's News panel and the chart's timescale marks (P-20, M-3).
 * They are written from the simulated prices themselves, so they always match the chart,
 * and they are labelled as simulated.
 */
import { getSymbol, SYMBOLS } from '../shared/symbols.js';

/** @typedef {import('./market.js').Market} Market */
/** @typedef {{ id: string, time: number, symbol: string, title: string, summary: string, source: string }} Headline */

const WINDOW = '240';
const THRESHOLD = 0.012; // a 1.2% move in four hours makes a headline

/**
 * Headlines between two times, newest first.
 * @param {Market} market
 * @param {{ symbol?: string, from: number, to: number, now: number, limit?: number }} query
 * @returns {Headline[]}
 */
export function headlines(market, { symbol, from, to, now, limit = 50 }) {
  const names = symbol ? [getSymbol(symbol)?.name].filter((n) => n !== undefined) : SYMBOLS.map((s) => s.name);
  /** @type {Headline[]} */
  const out = [];
  for (const name of names) {
    const def = /** @type {import('../shared/symbols.js').SymbolDef} */ (getSymbol(name));
    const bars = market.bars(name, WINDOW, { from, to, now });
    for (const b of bars) {
      if (b.time + 4 * 3_600_000 > now) continue; // only finished windows
      const change = (b.close - b.open) / b.open;
      if (Math.abs(change) < THRESHOLD) continue;
      const pct = `${(Math.abs(change) * 100).toFixed(1)}%`;
      const up = change > 0;
      const range = Math.round(((b.high - b.low) / b.open) * 1000) / 10;
      out.push({
        id: `${name}-${b.time}`,
        time: b.time + 4 * 3_600_000,
        symbol: name,
        title: `${def.description} ${up ? 'climbs' : 'slides'} ${pct} in four hours`,
        summary: `${name} moved from ${market.priceString(name, b.open)} to ${market.priceString(name, b.close)}, trading in a ${range}% range on ${market.qtyString(name, b.volume)} volume.`,
        source: 'Simulated market wire',
      });
    }
  }
  return out.sort((a, b) => b.time - a.time).slice(0, limit);
}
