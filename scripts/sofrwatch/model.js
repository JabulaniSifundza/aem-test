/*
 * SOFRWatch page model shared by the SOFRWatch blocks: the data set (loaded once per page), the
 * user's scenario (a policy change in basis points for every upcoming FOMC meeting) and the
 * results it implies, computed with ./engine.js. Views subscribe and re-render on change.
 */
import * as SW from './engine.js';

let modelPromise = null;

/** Scenario presets offered in the "Start from" menu. */
export const PRESETS = {
  likely: 'FedWatch most likely',
  expected: 'FedWatch expected',
  hold: 'No change at any meeting',
};

function compute(M) {
  const { D } = M;
  const spread = (D.spreads.effrToLowerBp + D.spreads.sofrToEffrBp) / 100;
  const path = (changes) => SW.sofrPath({
    asOf: D.asOf,
    fixings: D.fixings,
    lower: D.targetLower,
    spread,
    moves: D.meetings.map((m, i) => ({ date: m.date, change: changes[i] })),
  });
  const user = path(M.scenario);
  const market = M.marketPath || path(D.meetings.map((m) => m.expectedChangeBp));
  M.marketPath = market;
  const row = (c, prices, settle) => {
    const mkt = prices[c.code];
    const s = settle(c.start, c.end, user);
    return {
      ...c,
      market: mkt,
      implied: s.price,
      impliedRate: s.rate,
      marketRate: mkt === undefined ? null : 100 - mkt,
      diffBp: mkt === undefined ? null : (s.price - mkt) * 100,
      running: c.start <= D.asOf,
    };
  };
  M.results = {
    user,
    market,
    sr3: M.sr3.map((c) => row(c, D.prices.sr3, SW.sr3Settlement)),
    sr1: M.sr1.map((c) => row(c, D.prices.sr1, SW.sr1Settlement)),
  };
}

export function loadModel(url) {
  if (modelPromise) return modelPromise;
  const src = url || `${window.hlx?.codeBasePath || ''}/scripts/sofrwatch/sample-data.json`;
  modelPromise = fetch(src).then((r) => {
    if (!r.ok) throw new Error(`SOFRWatch data ${r.status}`);
    return r.json();
  }).then((D) => {
    const M = {
      D,
      sr3: SW.sr3Contracts(D.asOf, Object.keys(D.prices.sr3).length),
      sr1: SW.sr1Contracts(D.asOf, Object.keys(D.prices.sr1).length),
      preset: 'likely',
      scenario: D.meetings.map((m) => m.mostLikelyChangeBp),
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

export function presetChanges(M, key) {
  if (key === 'expected') return M.D.meetings.map((m) => Math.round(m.expectedChangeBp * 10) / 10);
  if (key === 'hold') return M.D.meetings.map(() => 0);
  return M.D.meetings.map((m) => m.mostLikelyChangeBp);
}
