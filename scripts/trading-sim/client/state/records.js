/**
 * App records (settings, workspaces, watchlists, trade-log notes) kept on the server through the
 * chart storage API (requirement P-18: settings on the server, not in local storage). Each record
 * is a chart entry whose symbol is "__app__" and whose name is the record key. Writes are debounced.
 *
 * Writes of one key are chained: the first save of a new record has no id until its POST
 * answers, so a second save that overlapped it would otherwise create a duplicate record.
 * Each write sends the latest value, so a burst of saves costs at most two requests.
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
  /** The last write started for each key; the next one waits for it. @type {Map<string, Promise<void>>} */
  const inflight = new Map();
  let loaded = false;

  async function index() {
    if (loaded) return;
    const all = await storage.getAllCharts();
    for (const c of all) if (c.symbol === APP_SYMBOL) ids.set(c.name, c.id);
    loaded = true;
  }

  /** @param {string} key */
  function write(key) {
    timers.delete(key);
    const run = (inflight.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!pending.has(key)) return; // an earlier write in the chain already sent the latest value
      const value = pending.get(key);
      pending.delete(key);
      const id = await storage.saveChart({ id: ids.get(key), name: key, content: JSON.stringify(value), symbol: APP_SYMBOL, resolution: 'app' });
      ids.set(key, id);
    });
    inflight.set(key, run);
    run.finally(() => { if (inflight.get(key) === run) inflight.delete(key); }).catch(() => {});
    return run;
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
    /** Write everything pending now, and wait for writes already under way (before unload, in tests). */
    async flush() {
      const now = [...timers.keys()].map((k) => { clearTimeout(/** @type {any} */ (timers.get(k))); return write(k); });
      await Promise.all([...now, ...inflight.values()]);
    },
  };
}

/** @typedef {ReturnType<typeof createRecords>} Records */
