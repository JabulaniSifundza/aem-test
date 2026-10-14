/**
 * Chart and study-template storage (spec §9). The same records as the spec's PostgreSQL tables
 * (charts, study_templates; server/schema.sql), kept in memory. The mock server persists them to
 * a JSON file through the `persist` callback; the browser loopback keeps them for the session.
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

/** @typedef {{ nextId: number, charts: ChartRecord[], templates: TemplateRecord[] }} StoreData */

const MAX_CONTENT_BYTES = 2_000_000;

/**
 * @param {{ data?: StoreData, persist?: (data: StoreData) => void, now?: () => number }} [options]
 */
export function createStore({ data, persist = () => {}, now = () => Date.now() } = {}) {
  /** @type {StoreData} */
  const db = data ?? { nextId: 1, charts: [], templates: [] };
  const commit = () => persist(db);

  /** @param {string} text @param {string} field */
  function checkText(text, field) {
    if (typeof text !== 'string' || text.length === 0) throw new RangeError(`${field} is required`);
    if (text.length > MAX_CONTENT_BYTES) throw new RangeError(`${field} is too large`);
  }

  return {
    /** @param {string} client @param {string} user */
    listCharts(client, user) {
      return db.charts
        .filter((c) => c.client === client && c.user === user)
        .map(({ id, name, timestamp, symbol, resolution }) => ({ id, name, timestamp, symbol, resolution }));
    },

    /** @param {string} client @param {string} user @param {number} id */
    getChart(client, user, id) {
      const c = db.charts.find((x) => x.client === client && x.user === user && x.id === id);
      return c ? { id: c.id, name: c.name, timestamp: c.timestamp, content: c.content } : null;
    },

    /**
     * Save a new chart, or overwrite chart `id`.
     * @param {string} client @param {string} user
     * @param {{ name: string, content: string, symbol: string, resolution: string }} fields
     * @param {number} [id]
     */
    saveChart(client, user, { name, content, symbol, resolution }, id) {
      checkText(name, 'name');
      checkText(content, 'content');
      const timestamp = Math.floor(now() / 1000);
      if (id !== undefined) {
        const c = db.charts.find((x) => x.client === client && x.user === user && x.id === id);
        if (!c) return null;
        Object.assign(c, { name, content, symbol: symbol ?? c.symbol, resolution: resolution ?? c.resolution, timestamp });
        commit();
        return c.id;
      }
      const record = { id: db.nextId, client, user, name, content, symbol: symbol ?? '', resolution: resolution ?? '', timestamp };
      db.nextId += 1;
      db.charts.push(record);
      commit();
      return record.id;
    },

    /** @param {string} client @param {string} user @param {number} id */
    deleteChart(client, user, id) {
      const i = db.charts.findIndex((x) => x.client === client && x.user === user && x.id === id);
      if (i < 0) return false;
      db.charts.splice(i, 1);
      commit();
      return true;
    },

    /** @param {string} client @param {string} user */
    listTemplates(client, user) {
      return db.templates.filter((t) => t.client === client && t.user === user).map(({ name }) => ({ name }));
    },

    /** @param {string} client @param {string} user @param {string} name */
    getTemplate(client, user, name) {
      const t = db.templates.find((x) => x.client === client && x.user === user && x.name === name);
      return t ? { name: t.name, content: t.content } : null;
    },

    /** @param {string} client @param {string} user @param {{ name: string, content: string }} fields */
    saveTemplate(client, user, { name, content }) {
      checkText(name, 'name');
      checkText(content, 'content');
      const existing = db.templates.find((x) => x.client === client && x.user === user && x.name === name);
      if (existing) existing.content = content;
      else db.templates.push({ client, user, name, content });
      commit();
    },

    /** @param {string} client @param {string} user @param {string} name */
    deleteTemplate(client, user, name) {
      const i = db.templates.findIndex((x) => x.client === client && x.user === user && x.name === name);
      if (i < 0) return false;
      db.templates.splice(i, 1);
      commit();
      return true;
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
