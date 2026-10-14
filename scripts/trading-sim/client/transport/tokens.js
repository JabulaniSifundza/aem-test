/**
 * Where the client's access token comes from, and keeping it fresh (SEC-2).
 *
 * The development source signs in to the mock server's /auth/token and refreshes a minute before
 * expiry, telling open sockets the new token so they re-authenticate without dropping.
 * Concurrent callers share one renewal (`pending`), so a burst of requests signs in once.
 * In production, replace createDevTokenSource with one backed by the identity provider; the rest
 * of the client only calls getToken() and onRefresh().
 */

/**
 * @typedef {object} TokenSource
 * @property {() => Promise<string>} getToken
 * @property {(cb: (token: string) => void) => () => void} onRefresh
 * @property {() => string} user
 * @property {() => void} dispose
 * @property {() => void} [invalidate]   the server refused the current token (it restarted with a
 *                                          new signing key, say): the next getToken() signs in again
 */

/**
 * @param {object} options
 * @param {string} options.authUrl          e.g. http://localhost:8787/trade/v1/auth
 * @param {string} [options.user]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.refreshMarginMs]
 * @returns {TokenSource}
 */
export function createDevTokenSource({ authUrl, user = 'demo', fetchImpl = (...a) => fetch(...a), refreshMarginMs = 60_000 }) {
  /** @type {{ token: string, refreshToken: string, expiresAt: number, user: string } | null} */
  let current = null;
  /** @type {Promise<string> | null} */
  let pending = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Set<(token: string) => void>} */
  const listeners = new Set();

  /** @param {string} path @param {object} body */
  async function call(path, body) {
    const res = await fetchImpl(`${authUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
    return res.json();
  }

  async function renew() {
    const next = current ? await call('/refresh', { refreshToken: current.refreshToken }).catch(() => call('/token', { user })) : await call('/token', { user });
    const wasRefresh = current !== null;
    current = next;
    if (timer) clearTimeout(timer);
    const wait = Math.max(1_000, next.expiresAt - Date.now() - refreshMarginMs);
    timer = setTimeout(() => { renew().catch(() => { current = null; }); }, wait);
    if (wasRefresh) for (const l of listeners) l(next.token);
    return next.token;
  }

  return {
    getToken() {
      if (current && current.expiresAt - Date.now() > refreshMarginMs / 2) return Promise.resolve(current.token);
      pending ??= renew().finally(() => { pending = null; });
      return pending;
    },
    onRefresh(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    user: () => current?.user ?? user,
    dispose() { if (timer) clearTimeout(timer); timer = null; },
    invalidate() {
      // Drop the token and its refresh token (both are signed with the same key), unless a
      // renewal is already under way, which will bring a fresh one anyway.
      if (pending) return;
      current = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * A token the host page already has (the spec's initializeTradingPlatform(container, jwtToken)).
 * @param {string} token @param {string} user
 * @returns {TokenSource}
 */
export function createStaticTokenSource(token, user) {
  return { getToken: () => Promise.resolve(token), onRefresh: () => () => {}, user: () => user, dispose: () => {} };
}
