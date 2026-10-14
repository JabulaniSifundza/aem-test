/**
 * The simulated backend behind a message port, for pages with no server (DA and EDS pages,
 * demos). The client keeps its normal code path: client/transport/loopback.js gives it a fetch and
 * a WebSocket that post messages here, and this core answers them with the same router and hub
 * the mock server uses.
 *
 * Messages in:  { kind: 'fetch', id, url, method, contentType, body }
 *               { kind: 'open', conn, url } · { kind: 'frame', conn, data } · { kind: 'close', conn }
 * Messages out: { kind: 'response', id, status, body } · { kind: 'opened', conn }
 *               { kind: 'frame', conn, data } · { kind: 'closed', conn }
 *
 * Everything runs in the page, so there is no real security: any token "loopback.<user>" is accepted.
 */
import { createSimulation } from './index.js';
import { API_PREFIXES, STREAM_PATHS } from '../shared/protocol.js';

const TOKEN_PREFIX = 'loopback.';
const TOKEN_TTL_MS = 24 * 3_600_000;

/**
 * @param {object} options
 * @param {(message: object) => void} options.post
 * @param {string} [options.seed]
 * @param {number} [options.start]         simulated start time (ms)
 * @param {string} [options.startingBalance]
 * @param {boolean} [options.autoTick]     run the clock on a timer (default true)
 * @param {number} [options.tickMs]
 */
export function createLoopbackCore({ post, seed, start, startingBalance, autoTick = true, tickMs = 250 }) {
  const boot = Date.now();
  const now = start === undefined ? () => Date.now() : () => start + (Date.now() - boot);
  const verify = (/** @type {string} */ token) => (
    typeof token === 'string' && token.startsWith(TOKEN_PREFIX) ? { user: token.slice(TOKEN_PREFIX.length), expiresAt: Date.now() + TOKEN_TTL_MS } : null
  );
  const sim = createSimulation({ seed, now, startingBalance, verify });
  /** @type {Map<number, ReturnType<typeof sim.hub.connect>>} */
  const connections = new Map();

  /** @param {string} user */
  const issue = (user) => ({ token: `${TOKEN_PREFIX}${user}`, refreshToken: `${TOKEN_PREFIX}${user}`, expiresAt: Date.now() + TOKEN_TTL_MS, user });

  /** @param {{ id: number, url: string, method: string, contentType?: string, authorization?: string, body?: string }} m */
  function fetchMessage(m) {
    const url = new URL(m.url);
    const path = url.pathname.replace(/\/+$/, '');
    /** @param {number} status @param {unknown} body */
    const reply = (status, body) => post({ kind: 'response', id: m.id, status, body: JSON.stringify(body) });
    let body = null;
    if (m.body) {
      if ((m.contentType ?? '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(m.body));
      else {
        try { body = JSON.parse(m.body); } catch { return reply(400, { message: 'Body is not valid JSON', code: 'bad_request' }); }
      }
    }
    if (path === '/trade/v1/auth/token') return reply(200, issue(String(body?.user ?? 'local')));
    if (path === '/trade/v1/auth/refresh') {
      const id = verify(String(body?.refreshToken ?? ''));
      return id ? reply(200, issue(id.user)) : reply(401, { message: 'Invalid refresh token', code: 'unauthorized' });
    }
    const api = API_PREFIXES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    if (!api) return reply(404, { message: 'Not found', code: 'not_found' });
    const id = verify(String(m.authorization ?? '').replace(/^Bearer /, ''));
    if (!id) return reply(401, { message: 'Missing or expired token', code: 'unauthorized' });
    const out = sim.router.handle({
      service: api[1], method: m.method, path: path.slice(api[0].length) || '/',
      query: Object.fromEntries(url.searchParams), body, user: id.user,
    });
    return reply(out.status, out.body);
  }

  /** @param {any} m */
  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'fetch') { fetchMessage(m); return; }
    if (m.kind === 'open') {
      const service = STREAM_PATHS[new URL(m.url).pathname];
      if (!service) { post({ kind: 'closed', conn: m.conn }); return; }
      const session = sim.hub.connect(service, (frame) => post({ kind: 'frame', conn: m.conn, data: JSON.stringify(frame) }), () => {
        connections.delete(m.conn);
        post({ kind: 'closed', conn: m.conn });
      });
      connections.set(m.conn, session);
      post({ kind: 'opened', conn: m.conn });
      return;
    }
    if (m.kind === 'frame') {
      let frame;
      try { frame = JSON.parse(m.data); } catch { return; }
      connections.get(m.conn)?.receive(frame);
      return;
    }
    if (m.kind === 'close') {
      connections.get(m.conn)?.disconnect();
      connections.delete(m.conn);
      post({ kind: 'closed', conn: m.conn });
    }
  }

  const timer = autoTick ? setInterval(() => sim.hub.tick(), tickMs) : null;
  return {
    onMessage,
    sim,
    tick: () => sim.hub.tick(),
    stop: () => { if (timer) clearInterval(timer); },
  };
}
