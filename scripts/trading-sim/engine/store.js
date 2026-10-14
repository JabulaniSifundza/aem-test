/**
 * Chart and study-template storage (spec §9): the same records as the charts and study_templates
 * tables (server/db/migrations/001_chart_storage.sql), kept in memory and indexed by owner.
 *
 * Where the records live depends on the host:
 *   - mock server with DATABASE_URL: PostgreSQL. The server loads the rows at start, and writes
 *     each takeChanges() batch in a transaction (server/db/repository.js).
 *   - mock server without a database: a JSON file, rewritten through `persist` after each change.
 *   - browser loopback: nothing; records last as long as the page.
 *
 * Every record belongs to an owner, the (client, user) pair from the request, and every call is
 * scoped to one owner, so records are indexed by owner first:
 *
 *   charts     owner → (id → chart)
 *   templates  owner → (name → template)
 *
 * Complexity (n = the owner's records): list O(n), get/save/delete O(1). The JSON fallback adds
 * O(total records) per write to serialise the file, which is why the database is the path for
 * anything beyond a single developer.
 */

/**
 * @typedef {object} ChartRecord
 * @property {number} id
 * @property {string} client
 * @property {string} user
 * @property {string} name
 * @property {string} symbol
 * @property {string} resolution
 * @property {string} content     serialised chart state, stored as given
 * @property {number} timestamp   seconds since 1970 (last saved)
 */

/**
 * @typedef {object} TemplateRecord
 * @property {string} client
 * @property {string} user
 * @property {string} name
 * @property {string} content
 */

/** The persisted form (JSON file, database load). @typedef {{ nextId: number, charts: ChartRecord[], templates: TemplateRecord[] }} StoreData */

/**
 * Changes since the last takeChanges(). A null record means deleted.
 * @typedef {object} StoreChanges
 * @property {Array<{ id: number, client: string, user: string, record: ChartRecord | null }>} charts
 * @property {Array<{ client: string, user: string, name: string, record: TemplateRecord | null }>} templates
 */

const MAX_CONTENT_BYTES = 2_000_000;

/** One key per owner. The separator can't appear in a client id or user name. @param {string} client @param {string} user */
const ownerKey = (client, user) => `${client}\u0000${user}`;

/**
 * @param {{ data?: StoreData, persist?: (data: StoreData) => void, now?: () => number, journal?: boolean }} [options]
 *   data: records to start with; persist: called with all records after each change (JSON file);
 *   journal: record changes for takeChanges() (database).
 */
export function createStore({ data, persist, now = () => Date.now(), journal = false } = {}) {
  /** @type {Map<string, Map<number, ChartRecord>>} */
  const charts = new Map();
  /** @type {Map<string, Map<string, TemplateRecord>>} */
  const templates = new Map();
  let nextId = 1;

  /** @type {{ charts: Map<number, StoreChanges['charts'][number]>, templates: Map<string, StoreChanges['templates'][number]> } | null} */
  let changes = journal ? { charts: new Map(), templates: new Map() } : null;

  /**
   * The owner's bucket in an index, created on first write.
   * @template V @param {Map<string, Map<any, V>>} index @param {string} client @param {string} user @param {boolean} create
   */
  function bucket(index, client, user, create) {
    const key = ownerKey(client, user);
    let b = index.get(key);
    if (!b && create) { b = new Map(); index.set(key, b); }
    return b;
  }

  /** All records in the persisted shape. O(total). @returns {StoreData} */
  function snapshot() {
    return {
      nextId,
      charts: [...charts.values()].flatMap((b) => [...b.values()]).sort((a, b) => a.id - b.id),
      templates: [...templates.values()].flatMap((b) => [...b.values()]),
    };
  }

  /** @param {StoreData} d */
  function load(d) {
    charts.clear();
    templates.clear();
    nextId = d.nextId;
    for (const c of d.charts) {
      /** @type {Map<number, ChartRecord>} */ (bucket(charts, c.client, c.user, true)).set(c.id, c);
      if (c.id >= nextId) nextId = c.id + 1; // never hand out an id that is in use
    }
    for (const t of d.templates) /** @type {Map<string, TemplateRecord>} */ (bucket(templates, t.client, t.user, true)).set(t.name, t);
  }

  if (data) load(data);

  /** After every change: the JSON file gets everything (O(total)); the journal gets the change. */
  const commit = () => { if (persist) persist(snapshot()); };

  /** @param {number} id @param {string} client @param {string} user @param {ChartRecord | null} record */
  const chartChanged = (id, client, user, record) => { changes?.charts.set(id, { id, client, user, record }); commit(); };
  /** @param {string} client @param {string} user @param {string} name @param {TemplateRecord | null} record */
  const templateChanged = (client, user, name, record) => {
    changes?.templates.set(`${ownerKey(client, user)}\u0000${name}`, { client, user, name, record });
    commit();
  };

  /** @param {string} text @param {string} field */
  function checkText(text, field) {
    if (typeof text !== 'string' || text.length === 0) throw new RangeError(`${field} is required`);
    if (text.length > MAX_CONTENT_BYTES) throw new RangeError(`${field} is too large`);
  }

  return {
    /** The owner's charts without their content, in id order. O(n). @param {string} client @param {string} user */
    listCharts(client, user) {
      const b = bucket(charts, client, user, false);
      return b ? [...b.values()].map(({ id, name, timestamp, symbol, resolution }) => ({ id, name, timestamp, symbol, resolution })) : [];
    },

    /** O(1). @param {string} client @param {string} user @param {number} id */
    getChart(client, user, id) {
      const c = bucket(charts, client, user, false)?.get(id);
      return c ? { id: c.id, name: c.name, timestamp: c.timestamp, content: c.content } : null;
    },

    /**
     * Save a new chart, or overwrite chart `id`. Returns the id, or null if the owner has no
     * chart `id`. O(1).
     * @param {string} client @param {string} user
     * @param {{ name: string, content: string, symbol: string, resolution: string }} fields
     * @param {number} [id]
     */
    saveChart(client, user, { name, content, symbol, resolution }, id) {
      checkText(name, 'name');
      checkText(content, 'content');
      const timestamp = Math.floor(now() / 1000);
      if (id !== undefined) {
        const c = bucket(charts, client, user, false)?.get(id);
        if (!c) return null;
        Object.assign(c, { name, content, symbol: symbol ?? c.symbol, resolution: resolution ?? c.resolution, timestamp });
        chartChanged(c.id, client, user, c);
        return c.id;
      }
      const record = { id: nextId, client, user, name, content, symbol: symbol ?? '', resolution: resolution ?? '', timestamp };
      nextId += 1;
      /** @type {Map<number, ChartRecord>} */ (bucket(charts, client, user, true)).set(record.id, record);
      chartChanged(record.id, client, user, record);
      return record.id;
    },

    /** O(1). @param {string} client @param {string} user @param {number} id */
    deleteChart(client, user, id) {
      if (!bucket(charts, client, user, false)?.delete(id)) return false;
      chartChanged(id, client, user, null);
      return true;
    },

    /** O(n). @param {string} client @param {string} user */
    listTemplates(client, user) {
      const b = bucket(templates, client, user, false);
      return b ? [...b.values()].map(({ name }) => ({ name })) : [];
    },

    /** O(1). @param {string} client @param {string} user @param {string} name */
    getTemplate(client, user, name) {
      const t = bucket(templates, client, user, false)?.get(name);
      return t ? { name: t.name, content: t.content } : null;
    },

    /** Save or replace a template by name. O(1). @param {string} client @param {string} user @param {{ name: string, content: string }} fields */
    saveTemplate(client, user, { name, content }) {
      checkText(name, 'name');
      checkText(content, 'content');
      const b = /** @type {Map<string, TemplateRecord>} */ (bucket(templates, client, user, true));
      const existing = b.get(name);
      if (existing) existing.content = content;
      else b.set(name, { client, user, name, content });
      templateChanged(client, user, name, /** @type {TemplateRecord} */ (b.get(name)));
    },

    /** O(1). @param {string} client @param {string} user @param {string} name */
    deleteTemplate(client, user, name) {
      if (!bucket(templates, client, user, false)?.delete(name)) return false;
      templateChanged(client, user, name, null);
      return true;
    },

    /** Hand over the changes since the last call (null if none). @returns {StoreChanges | null} */
    takeChanges() {
      if (!changes) throw new Error('createStore({ journal: true }) to record changes');
      if (!changes.charts.size && !changes.templates.size) return null;
      // Copies, so a later in-place edit (Object.assign above) can't change a batch being written.
      const out = {
        charts: [...changes.charts.values()].map((c) => ({ ...c, record: c.record && { ...c.record } })),
        templates: [...changes.templates.values()].map((t) => ({ ...t, record: t.record && { ...t.record } })),
      };
      changes = { charts: new Map(), templates: new Map() };
      return out;
    },

    snapshot,
    load,
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
