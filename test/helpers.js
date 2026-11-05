import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/security.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/konkurs_test';

export const AT = {
  beforeRegistration: '2026-11-05T12:00:00+03:00',
  registration: '2026-11-15T12:00:00+03:00',
  pause: '2026-11-25T23:59:59.500+03:00',
  voting: '2026-11-27T12:00:00+03:00',
  votingLastSecond: '2026-12-05T23:59:59+03:00',
  afterVoting: '2026-12-06T00:00:00+03:00',
};

export async function setup() {
  process.env.NODE_ENV = 'test';
  const cfg = loadConfig({ devLogin: true, videoDir: mkdtempSync(path.join(os.tmpdir(), 'kvid-')), publicUrl: 'http://test.local' });
  cfg.captcha.provider = 'none';
  const pool = createPool(TEST_DB);
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(pool);
  const clock = { now: new Date(AT.registration) };
  const app = await buildApp({ cfg, pool, now: () => clock.now, logger: false });
  await app.ready();
  const setTime = (s) => { clock.now = new Date(s); };
  return { app, pool, cfg, setTime, close: async () => { await app.close(); await pool.end(); } };
}

// A browser-like client: keeps the session cookie and reads CSRF tokens from pages.
export class Client {
  constructor(app) { this.app = app; this.cookie = ''; }

  async req(opts) {
    const res = await this.app.inject({ ...opts, headers: { ...(opts.headers || {}), cookie: this.cookie } });
    const set = res.headers['set-cookie'];
    if (set) {
      const m = [].concat(set).map((c) => c.split(';')[0]).find((c) => c.startsWith('ksid='));
      if (m) this.cookie = m.endsWith('=') ? '' : m;
    }
    return res;
  }

  get(url, headers) { return this.req({ method: 'GET', url, headers }); }

  post(url, form) {
    return this.req({
      method: 'POST', url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    });
  }

  async csrf(url) {
    const res = await this.get(url);
    const m = res.body.match(/name="_csrf" value="([^"]+)"/) || res.body.match(/_csrf=([^"&]+)/);
    if (!m) throw new Error(`no csrf on ${url}: ${res.statusCode}`);
    return decodeURIComponent(m[1]);
  }

  // Full login through the consent page and the dev provider.
  async login(uid, phone, next = '/my') {
    const csrf = await this.csrf(`/login/dev?next=${encodeURIComponent(next)}`);
    const r1 = await this.post('/login/dev', { _csrf: csrf, consent: 'yes', next });
    const state = new URL(r1.headers.location, 'http://x').searchParams.get('state');
    const q = new URLSearchParams({ state, uid, ...(phone ? { phone } : {}) });
    const r2 = await this.get(`/auth/dev/callback?${q}`);
    if (r2.statusCode !== 302) throw new Error(`login failed: ${r2.statusCode} ${r2.body.slice(0, 200)}`);
    return r2;
  }

  async adminLogin(pool, login = 'org') {
    await pool.query(
      'insert into admins (login, password_hash) values ($1, $2) on conflict (login) do nothing',
      [login, await hashPassword('correct horse battery')],
    );
    const csrf = await this.csrf('/admin/login');
    const r = await this.post('/admin/login', { _csrf: csrf, login, password: 'correct horse battery' });
    if (r.headers.location !== '/admin') throw new Error('admin login failed');
    return this.csrf('/admin');
  }

  async uploadVideo(fixture) {
    const csrf = await this.csrf('/my');
    const file = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url));
    const boundary = '----konkurs' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${fixture}"\r\nContent-Type: video/mp4\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return this.req({
      method: 'POST', url: `/my/video?_csrf=${encodeURIComponent(csrf)}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  }
}

export const company = (over = {}) => ({
  name: 'Ромашка', city: 'Казань', story: 'Мы делаем лучшие корпоративные праздники в городе.',
  contact_phone: '+7 900 111-22-33', contact_email: 'cap@example.ru', publish_consent: 'yes', ...over,
});
