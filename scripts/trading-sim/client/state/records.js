/**
 * App records (settings, workspaces, watchlists, trade-log notes) kept on the server through the
 * chart storage API (requirement P-18: settings on the server, not in local storage). Each record
 * is a chart entry whose symbol is "__app__" and whose name is the record key. Writes are debounced.
 */

/** @typedef {import('../storage/save-load.js').SaveLoad} SaveLoad */

const APP_SYMBOL = '__app__';
const DEBOUNCE_MS = 400;

/** @param {SaveLoad} storage */
export function createRecords(storage) {
  /** @type {Map<string, number>} key → chart id */
  const ids = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {Map<string, unknown>} */
  const pending = new Map();
  let loaded = false;

  async function index() {
    if (loaded) return;
    const all = await storage.getAllCharts();
    for (const c of all) if (c.symbol === APP_SYMBOL) ids.set(c.name, c.id);
    loaded = true;
  }

  /** @param {string} key */
  async function write(key) {
    timers.delete(key);
    const value = pending.get(key);
    pending.delete(key);
    const id = await storage.saveChart({ id: ids.get(key), name: key, content: JSON.stringify(value), symbol: APP_SYMBOL, resolution: 'app' });
    ids.set(key, id);
  }

  return {
    /**
     * @template T
     * @param {string} key @param {T} fallback
     * @returns {Promise<T>}
     */
    async load(key, fallback) {
      await index();
      const id = ids.get(key);
      if (id === undefined) return fallback;
      try { return JSON.parse(await storage.getChartContent(id)); } catch { return fallback; }
    },
    /** Save soon (debounced). @param {string} key @param {unknown} value */
    save(key, value) {
      pending.set(key, value);
      const t = timers.get(key);
      if (t) clearTimeout(t);
      timers.set(key, setTimeout(() => { write(key).catch((e) => console.error('Saving', key, e)); }, DEBOUNCE_MS));
    },
    /** Write everything pending now (before unload, in tests). */
    async flush() {
      await Promise.all([...timers.keys()].map((k) => { clearTimeout(/** @type {any} */ (timers.get(k))); return write(k); }));
    },
  };
}

/** @typedef {ReturnType<typeof createRecords>} Records */
