/**
 * Chart storage client (spec §9, requirements P-18, P-19, S-1, S-2), shaped like the TradingView
 * library's save/load adapter so the licensed library can use it directly. Settings and layouts
 * live on the server, not in local storage.
 */

/** @typedef {import('../transport/transport.js').Transport} Transport */
/** @typedef {{ id: number, name: string, timestamp: number, symbol: string, resolution: string }} ChartMeta */

/**
 * @param {object} options
 * @param {Transport} options.transport
 * @param {string} [options.clientId]
 */
export function createSaveLoad({ transport, clientId = 'trading-sim' }) {
  const rest = transport.rest.storage;
  const ids = () => ({ client: clientId, user: transport.user() });

  return {
    /** @returns {Promise<ChartMeta[]>} */
    async getAllCharts() {
      return (await rest.get('/1.1/charts', { query: ids() })).data;
    },
    /** @param {number} id @returns {Promise<string>} */
    async getChartContent(id) {
      return (await rest.get('/1.1/charts', { query: { ...ids(), chart: id } })).data.content;
    },
    /**
     * Save a chart; pass `id` to overwrite. Returns the chart id.
     * @param {{ id?: number, name: string, content: string, symbol: string, resolution: string }} chart
     * @returns {Promise<number>}
     */
    async saveChart({ id, name, content, symbol, resolution }) {
      const query = id === undefined ? ids() : { ...ids(), chart: id };
      return (await rest.request('POST', '/1.1/charts', { query, form: { name, content, symbol, resolution } })).id;
    },
    /** @param {number} id */
    async removeChart(id) {
      await rest.del('/1.1/charts', { query: { ...ids(), chart: id } });
    },
    /** @returns {Promise<Array<{ name: string }>>} */
    async getAllStudyTemplates() {
      return (await rest.get('/1.1/study_templates', { query: ids() })).data;
    },
    /** @param {{ name: string }} t @returns {Promise<string>} */
    async getStudyTemplateContent({ name }) {
      return (await rest.get('/1.1/study_templates', { query: { ...ids(), template: name } })).data.content;
    },
    /** @param {{ name: string, content: string }} t */
    async saveStudyTemplate({ name, content }) {
      await rest.request('POST', '/1.1/study_templates', { query: ids(), form: { name, content } });
    },
    /** @param {{ name: string }} t */
    async removeStudyTemplate({ name }) {
      await rest.del('/1.1/study_templates', { query: { ...ids(), template: name } });
    },
  };
}

/** @typedef {ReturnType<typeof createSaveLoad>} SaveLoad */
