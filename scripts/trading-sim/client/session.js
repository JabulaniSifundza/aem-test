/**
 * Signing in to a server, shared by the app page and the EDS blocks: use the session kept for
 * this tab if it is still good, otherwise show the sign-in screen (client/ui/signin.js) in the
 * given element and wait for the user.
 *
 * The session is kept in sessionStorage under one key per page origin, tagged with the server
 * it belongs to: a reload in the same tab stays signed in, a new tab or another server asks
 * again. Storage can be unavailable (private browsing, blocked): then the session lasts until
 * the page closes. A session that ends while open (signed out on another device) leaves a notice
 * for the next sign-in screen.
 */
import { createSessionTokenSource } from './transport/tokens.js';
import { showSignIn } from './ui/signin.js';

const SESSION_KEY = 'trading-sim.session';
const NOTICE_KEY = 'trading-sim.notice';

/** @param {string} api */
function saved(api) {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
    return value && value.api === api ? value.session : null;
  } catch { return null; }
}
/** @param {string} api @param {import('./transport/tokens.js').Session | null} session */
function keep(api, session) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ api, session }));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* storage unavailable */ }
}
/** The notice left by an ended session, read once. */
function takeNotice() {
  try {
    const notice = sessionStorage.getItem(NOTICE_KEY) ?? undefined;
    sessionStorage.removeItem(NOTICE_KEY);
    return notice;
  } catch { return undefined; }
}

/**
 * A signed-in token source for the server at `api`.
 * @param {string} api @param {HTMLElement} root  where the sign-in screen goes if needed
 * @returns {Promise<{ tokens: ReturnType<typeof createSessionTokenSource>, email: string }>}
 */
export async function signedIn(api, root) {
  const authUrl = `${api.replace(/\/$/, '')}/trade/v1/auth`;
  const make = (/** @type {import('./transport/tokens.js').Session} */ session) => {
    const tokens = createSessionTokenSource({ authUrl, session, onChange: (s) => keep(api, s) });
    // Ended elsewhere: leave a notice and start again at the sign-in screen.
    tokens.onSignedOut(() => {
      try { sessionStorage.setItem(NOTICE_KEY, 'You were signed out. Sign in again to continue.'); } catch { /* no storage */ }
      location.reload();
    });
    return tokens;
  };
  const kept = saved(api);
  if (kept) {
    const tokens = make(kept);
    try { await tokens.getToken(); return { tokens, email: tokens.email() ?? '' }; } catch { tokens.dispose(); keep(api, null); }
  }
  const session = await showSignIn(root, { authUrl, notice: takeNotice() });
  keep(api, session);
  return { tokens: make(session), email: session.email ?? '' };
}
