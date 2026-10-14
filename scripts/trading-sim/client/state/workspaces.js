/**
 * Workspaces (requirement X-1): named dock layouts, one active at a time, kept on the server as an
 * app record. New workspaces start from a template, as in the simulator.
 */
import { DEFAULT_WATCHLIST } from '../../shared/symbols.js';

/** @typedef {import('../ui/dock.js').DockState} DockState */
/** @typedef {{ id: string, name: string, favorite: boolean, dock: DockState }} Workspace */
/** @typedef {{ list: Workspace[], active: string }} WorkspaceStore */

let seq = 0;
const wid = () => `t${Date.now().toString(36)}${(seq += 1)}`;

/**
 * Build a dock state from a compact layout description.
 * ['row', [2, 1], A, B] is a split; { w: 'chart', p: {...} } or [{...}, {...}] (tabs) is a panel.
 * @param {any} spec
 * @returns {DockState}
 */
export function fromSpec(spec) {
  /** @type {DockState['widgets']} */
  const widgets = {};
  /** @param {any} node @returns {import('../ui/dock.js').DockNode | null} */
  const build = (node) => {
    if (!node) return null;
    if (Array.isArray(node) && (node[0] === 'row' || node[0] === 'column')) {
      const [dir, sizes, ...children] = node;
      return { type: 'split', dir, sizes, children: /** @type {import('../ui/dock.js').DockNode[]} */ (children.map(build).filter(Boolean)) };
    }
    const tabs = (Array.isArray(node) ? node : [node]).map((t) => {
      const id = wid();
      widgets[id] = { kind: t.w, params: t.p ?? {} };
      return id;
    });
    return { type: 'group', id: wid(), tabs, active: tabs[0] };
  };
  return { layout: build(spec), widgets, maximized: null };
}

const chart = (/** @type {string} */ symbol, resolution = '1D') => ({ w: 'chart', p: { symbol, resolution } });

/** The simulator's new-workspace templates (EXTRACTION.md), with the spec's symbols. */
export const TEMPLATES = [
  { id: 'blank', name: 'Blank', description: 'An empty workspace.', spec: null },
  {
    id: 'default', name: 'CME Group workspace', description: 'Markets, calendar, positions, orders, chart and price ladder.',
    spec: ['row', [5, 4, 3],
      ['column', [3, 2], [{ w: 'markets' }, { w: 'watchlist', p: { list: 'Default' } }], [{ w: 'positions' }, { w: 'orders' }, { w: 'executions' }, { w: 'calendar' }]],
      ['column', [1], chart('BTCUSDT')],
      [{ w: 'ladder', p: { symbol: 'BTCUSDT' } }, { w: 'ticket', p: { symbol: 'BTCUSDT' } }]],
  },
  { id: 'chart-ladder', name: 'Chart + ladder', description: 'One chart and its price ladder.', spec: ['row', [3, 1], chart('BTCUSDT', '5'), { w: 'ladder', p: { symbol: 'BTCUSDT' } }] },
  {
    id: 'multicharts-ladder', name: 'Multicharts + ladder', description: 'Four charts and a price ladder.',
    spec: ['row', [4, 1], ['column', [1, 1], ['row', [1, 1], chart('BTCUSDT', '5'), chart('ETHUSDT', '5')], ['row', [1, 1], chart('SPY', '5'), chart('QQQ', '5')]], { w: 'ladder', p: { symbol: 'BTCUSDT' } }],
  },
  { id: 'options', name: 'Options', description: 'Options grid with a chart.', spec: ['row', [1, 1], { w: 'options' }, chart('SPY', '1D')] },
  { id: 'charts', name: 'Charts', description: 'Four charts.', spec: ['column', [1, 1], ['row', [1, 1], chart('BTCUSDT', '1D'), chart('ETHUSDT', '1D')], ['row', [1, 1], chart('SPY', '1D'), chart('QQQ', '1D')]] },
];

/** The first workspace a new user sees. @param {string} [templateId] */
export function defaultStore(templateId = 'default') {
  const template = /** @type {(typeof TEMPLATES)[number]} */ (TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES.find((t) => t.id === 'default'));
  const ws = { id: wid(), name: template.name, favorite: true, dock: fromSpec(template.spec) };
  return /** @type {WorkspaceStore} */ ({ list: [ws], active: ws.id });
}

/**
 * @param {import('./records.js').Records} records
 * @param {string} [templateId] the template of a new user's first workspace
 */
export async function loadWorkspaces(records, templateId) {
  /** @type {WorkspaceStore} */
  const store = await records.load('workspaces', defaultStore(templateId));
  if (!store.list.length) Object.assign(store, defaultStore(templateId));
  if (!store.list.some((w) => w.id === store.active)) store.active = store.list[0].id;

  const save = () => records.save('workspaces', store);
  return {
    store,
    get active() { return /** @type {Workspace} */ (store.list.find((w) => w.id === store.active)); },
    /** @param {string} id */
    activate(id) { store.active = id; save(); },
    /** @param {DockState} dock */
    updateActive(dock) { const ws = store.list.find((w) => w.id === store.active); if (ws) { ws.dock = dock; save(); } },
    /** @param {string} templateId @param {string} [name] */
    create(templateId, name) {
      const t = TEMPLATES.find((x) => x.id === templateId) ?? TEMPLATES[0];
      const base = name ?? (t.id === 'blank' ? 'New workspace' : t.name);
      let n = 1;
      let unique = base;
      while (store.list.some((w) => w.name === unique)) { n += 1; unique = `${base}-${n}`; }
      const ws = { id: wid(), name: unique, favorite: false, dock: fromSpec(t.spec) };
      store.list.push(ws);
      store.active = ws.id;
      save();
      return ws;
    },
    /** @param {string} id @param {string} name */
    rename(id, name) { const ws = store.list.find((w) => w.id === id); if (ws && name.trim()) { ws.name = name.trim().slice(0, 60); save(); } },
    /** @param {string} id */
    duplicate(id) {
      const ws = store.list.find((w) => w.id === id);
      if (!ws) return null;
      const copy = { id: wid(), name: `${ws.name} copy`, favorite: false, dock: JSON.parse(JSON.stringify(ws.dock)) };
      store.list.splice(store.list.indexOf(ws) + 1, 0, copy);
      store.active = copy.id;
      save();
      return copy;
    },
    /** @param {string} id */
    remove(id) {
      if (store.list.length <= 1) return false;
      const i = store.list.findIndex((w) => w.id === id);
      store.list.splice(i, 1);
      if (store.active === id) store.active = store.list[Math.max(0, i - 1)].id;
      save();
      return true;
    },
    /** Mark one workspace as the favourite (opened first). @param {string} id */
    setFavorite(id) { for (const w of store.list) w.favorite = w.id === id; save(); },
  };
}

export { DEFAULT_WATCHLIST };
