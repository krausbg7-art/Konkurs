// Server-side sessions in Postgres; the cookie holds only a random id.
import { randomToken, safeEqual } from './security.js';

const COOKIE = 'ksid';

export function registerSessions(app, { pool, cfg }) {
  app.decorateRequest('session', null);

  app.addHook('preHandler', async (req, reply) => {
    const id = req.cookies[COOKIE];
    let row = null;
    if (id) {
      const r = await pool.query('select * from sessions where id = $1 and expires_at > now()', [id]);
      row = r.rows[0] || null;
    }
    if (!row) {
      row = { id: null, account_id: null, admin_id: null, csrf: randomToken(24), data: {}, dirty: true };
    }
    req.session = row;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const s = req.session;
    if (!s || !s.dirty) return payload;
    // Do not create sessions for anonymous visitors who only read pages.
    if (!s.id && !s.account_id && !s.admin_id && Object.keys(s.data).length === 0 && !s.needCsrf) return payload;
    if (!s.id) s.id = randomToken(32);
    const expires = new Date(Date.now() + cfg.sessionDays * 86400e3);
    await pool.query(
      `insert into sessions (id, account_id, admin_id, csrf, data, expires_at) values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set account_id = excluded.account_id, admin_id = excluded.admin_id,
         csrf = excluded.csrf, data = excluded.data, expires_at = excluded.expires_at`,
      [s.id, s.account_id, s.admin_id, s.csrf, JSON.stringify(s.data), expires],
    );
    reply.setCookie(COOKIE, s.id, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: cfg.production, expires,
    });
    return payload;
  });
}

export function touch(req, patch = {}) {
  Object.assign(req.session, patch);
  req.session.dirty = true;
}

export function setData(req, patch) {
  req.session.data = { ...req.session.data, ...patch };
  req.session.dirty = true;
}

// Rotate the session id on login to prevent session fixation.
export async function rotate(req, pool) {
  if (req.session.id) await pool.query('delete from sessions where id = $1', [req.session.id]);
  req.session.id = null;
  req.session.csrf = randomToken(24);
  req.session.dirty = true;
}

export async function destroy(req, reply, pool) {
  if (req.session.id) await pool.query('delete from sessions where id = $1', [req.session.id]);
  req.session = { id: null, account_id: null, admin_id: null, csrf: randomToken(24), data: {}, dirty: false };
  reply.clearCookie(COOKIE, { path: '/' });
}

// Pages with forms call this so the anonymous session (and its CSRF token) gets saved.
export function csrfToken(req) {
  req.session.needCsrf = true;
  req.session.dirty = true;
  return req.session.csrf;
}

export function checkCsrf(req, token) {
  return Boolean(req.session?.id) && safeEqual(token, req.session.csrf);
}
