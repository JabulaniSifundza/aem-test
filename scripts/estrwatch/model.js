/*
 * €STRWatch page model shared by the €STRWatch blocks: the data set (loaded once per page), the
 * user's scenario (a policy change in basis points for every upcoming ECB monetary policy
 * meeting, applied from the maintenance-period start in the data) and the Three-Month €STR (ESR)
 * settlements it implies, computed with the overnight
 * rate engine in ../sofrwatch/engine.js. Views subscribe and re-render on change.
 */
import * as SW from '../sofrwatch/engine.js';

let modelPromise = null;

/** Scenario presets offered in the "Start from" menu. */
export const PRESETS = {
  hold: 'No change at any meeting',
  stepped: 'Market path, in 25 bp steps',
  expected: 'Market-implied path',
};

function compute(M) {
  const { D } = M;
  const path = (changes) => SW.sofrPath({
    asOf: D.asOf,
    fixings: D.fixings,
    lower: D.dfr,
    spread: D.spreadBp / 100,
    moves: D.meetings.map((m, i) => ({ date: m.date, effective: m.effective, change: changes[i] })),
  });
  const user = path(M.scenario);
  const market = M.marketPath || path(D.meetings.map((m) => m.expectedChangeBp));
  M.marketPath = market;
  M.results = {
    user,
    market,
    esr: M.esr.map((c) => {
      const mkt = D.prices.esr[c.code];
      const s = SW.sr3Settlement(c.start, c.end, user);
      return {
        ...c,
        market: mkt,
        implied: s.price,
        impliedRate: s.rate,
        marketRate: mkt === undefined ? null : 100 - mkt,
        diffBp: mkt === undefined ? null : (s.price - mkt) * 100,
        running: c.start <= D.asOf,
      };
    }),
  };
}

export function presetChanges(M, key) {
  const exp = M.D.meetings.map((m) => m.expectedChangeBp);
  if (key === 'expected') return exp.map((x) => Math.round(x * 10) / 10);
  if (key === 'stepped') {
    // round the cumulative expected path to whole 25 bp steps, then take the differences
    let cum = 0;
    let prev = 0;
    return exp.map((x) => {
      cum += x;
      const stepped = Math.round(cum / 25) * 25;
      const change = stepped - prev;
      prev = stepped;
      return change;
    });
  }
  return exp.map(() => 0);
}

export function loadModel(url) {
  if (modelPromise) return modelPromise;
  const src = url || `${window.hlx?.codeBasePath || ''}/scripts/estrwatch/sample-data.json`;
  modelPromise = fetch(src).then((r) => {
    if (!r.ok) throw new Error(`€STRWatch data ${r.status}`);
    return r.json();
  }).then((D) => {
    const M = {
      D,
      esr: SW.sr3Contracts(D.asOf, Object.keys(D.prices.esr).length, 'ESR'),
      preset: 'hold',
      scenario: D.meetings.map(() => 0),
      views: new Set(),
    };
    compute(M);
    return M;
  });
  return modelPromise;
}

/** Replace the scenario (array of bp per meeting) and re-render every view. */
export function setScenario(M, changes, preset = null) {
  M.scenario = changes.map((x) => (Number.isFinite(x) ? x : 0));
  M.preset = preset;
  compute(M);
  M.views.forEach((fn) => fn());
}
