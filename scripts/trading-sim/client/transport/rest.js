/**
 * A small fetch wrapper for one REST service: base URL, bearer token, JSON in and out, and
 * errors as ApiError with the server's message.
 */
import { ApiError } from '../../shared/protocol.js';

/**
 * @typedef {object} RequestOptions
 * @property {Record<string, string | number | boolean | undefined | null>} [query]
 * @property {unknown} [body]                 sent as JSON
 * @property {Record<string, string>} [form]  sent as application/x-www-form-urlencoded (chart storage)
 * @property {AbortSignal} [signal]
 */

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {() => Promise<string>} options.getToken
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export function createRestClient({ baseUrl, getToken, fetchImpl = (...a) => fetch(...a), timeoutMs = 15_000 }) {
  /**
   * @param {string} method @param {string} path @param {RequestOptions} [options]
   * @returns {Promise<any>}
   */
  async function request(method, path, { query, body, form, signal } = {}) {
    const url = new URL(baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${await getToken()}` };
    /** @type {BodyInit | undefined} */
    let payload;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(url.toString(), { method, headers, body: payload, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      throw new ApiError(0, 'network', `Could not reach the service (${/** @type {Error} */ (error).message})`);
    }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!response.ok) throw new ApiError(response.status, data?.code ?? 'error', data?.message ?? `Request failed (${response.status})`);
    return data;
  }

  return {
    request,
    /** @param {string} path @param {RequestOptions} [o] */ get: (path, o) => request('GET', path, o),
    /** @param {string} path @param {unknown} body */ post: (path, body) => request('POST', path, { body }),
    /** @param {string} path @param {unknown} body */ put: (path, body) => request('PUT', path, { body }),
    /** @param {string} path @param {unknown} body */ patch: (path, body) => request('PATCH', path, { body }),
    /** @param {string} path @param {RequestOptions} [o] */ del: (path, o) => request('DELETE', path, o),
  };
}

/** @typedef {ReturnType<typeof createRestClient>} RestClient */
