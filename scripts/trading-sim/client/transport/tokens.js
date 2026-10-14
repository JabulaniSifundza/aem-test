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

/**
 * @typedef {object} Session  what /auth/login and /auth/refresh return
 * @property {string} token
 * @property {string} refreshToken
 * @property {number} expiresAt
 * @property {string} user          the account's id
 * @property {string | null} [email]
 */

/**
 * Sign in with an email address and password. The server creates the account on its first
 * sign-in. Rejects with an Error whose message is the server's (wrong password, too many
 * attempts, bad address) and whose `status` is the HTTP status.
 * @param {string} authUrl e.g. http://localhost:8787/trade/v1/auth
 * @param {string} email @param {string} password
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Session & { created: boolean }>}
 */
export async function signIn(authUrl, email, password, fetchImpl = (...a) => fetch(...a)) {
  let res;
  try {
    res = await fetchImpl(`${authUrl}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? `Sign-in failed (${res.status})`), { status: res.status });
  return body;
}

/**
 * The token source for a signed-in user: keeps the session's access token fresh with its
 * refresh token, a minute before it expires, and tells open sockets the new token.
 *
 * If the server refuses the refresh token (the user signed out elsewhere, or the session ran
 * out), the session is over: listeners of onSignedOut are told, so the app can show the sign-in
 * screen. onChange receives the session whenever it changes (null when it ends), so the page can
 * keep it for a reload.
 * @param {object} options
 * @param {string} options.authUrl
 * @param {Session} options.session
 * @param {(session: Session | null) => void} [options.onChange]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.refreshMarginMs]
 * @returns {TokenSource & { email: () => string | null, signOut: () => Promise<void>, onSignedOut: (cb: () => void) => () => void }}
 */
export function createSessionTokenSource({ authUrl, session, onChange = () => {}, fetchImpl = (...a) => fetch(...a), refreshMarginMs = 60_000 }) {
  /** @type {Session | null} */
  let current = session;
  /** @type {Promise<string> | null} */
  let pending = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Set<(token: string) => void>} */
  const listeners = new Set();
  /** @type {Set<() => void>} */
  const ended = new Set();

  function end() {
    if (timer) clearTimeout(timer);
    timer = null;
    const was = current;
    current = null;
    onChange(null);
    if (was) for (const l of ended) l();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (!current) return;
    const wait = Math.max(1_000, current.expiresAt - Date.now() - refreshMarginMs);
    timer = setTimeout(() => { getToken().catch(() => {}); }, wait);
  }

  async function refresh() {
    if (!current) throw new Error('Signed out');
    const res = await fetchImpl(`${authUrl}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: current.refreshToken }) });
    if (res.status === 401) { end(); throw new Error('The session has ended; sign in again'); }
    if (!res.ok) throw new Error(`Could not refresh the session (${res.status})`);
    const next = await res.json();
    /** @type {Session} */
    const updated = { ...next, email: next.email ?? current?.email ?? null };
    current = updated;
    onChange(updated);
    schedule();
    for (const l of listeners) l(updated.token);
    return updated.token;
  }

  function getToken() {
    if (current && current.expiresAt - Date.now() > refreshMarginMs / 2) return Promise.resolve(current.token);
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  }

  schedule();
  return {
    getToken,
    onRefresh(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    user: () => current?.user ?? session.user,
    email: () => current?.email ?? session.email ?? null,
    dispose() { if (timer) clearTimeout(timer); timer = null; },
    // A 401 on a request: the access token is no longer accepted; try the refresh token next.
    invalidate() { if (current && !pending) current = { ...current, expiresAt: 0 }; },
    /** End the session here and on the server (every device). */
    async signOut() {
      const token = current?.token;
      if (token) await fetchImpl(`${authUrl}/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
      ended.clear(); // onSignedOut is for sessions that end on their own, not for this
      end();
    },
    onSignedOut(cb) { ended.add(cb); return () => ended.delete(cb); },
  };
}
