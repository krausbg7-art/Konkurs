// Organiser's admin: moderation of applications and videos, vote review and annulment,
// disqualification, results. Every action is written to admin_log.
import { html, exactTime, dateTime } from '../html.js';
import { csrfToken, checkCsrf, rotate, touch, destroy } from '../session.js';
import { verifyPassword } from '../security.js';
import { adminLog, tx, getSetting, setSetting } from '../db.js';
import { ranking, winners } from '../scoring.js';
import { VIDEO_REQUIREMENTS } from '../video.js';

const COMPANY_FILTERS = {
  pending: "c.status = 'pending' and c.disqualified_at is null",
  approved: "c.status = 'approved' and c.disqualified_at is null",
  rejected: "c.status = 'rejected'",
  disqualified: 'c.disqualified_at is not null',
};
const STATUS_RU = { pending: 'на проверке', approved: 'одобрена', rejected: 'отклонена', valid: 'засчитан', annulled: 'аннулирован' };
const PAGE_SIZE = 200;
const VIDEO_TABS = { pending: 'На проверке', processing: 'Обрабатываются', approved: 'Принятые', rejected: 'Отклонённые', failed: 'Не обработались' };

// Return to the same filtered vote list; only a local path is ever used.
function backToVotes(req) {
  try {
    const u = new URL(req.headers.referer || '', 'http://x');
    if (u.pathname === '/admin/votes') return `/admin/votes${u.search}`;
  } catch { /* ignore */ }
  return '/admin/votes';
}

// Simple in-memory brute-force guard for the admin login.
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, since: now };
  if (now - a.since > 15 * 60e3) { a.n = 0; a.since = now; }
  a.n += 1;
  attempts.set(ip, a);
  return a.n > 10;
}

export default async function adminRoutes(app, { ctx }) {
  const { cfg, pool } = ctx;
  const c = cfg.contest;
  const page = (req, reply, opts) => ctx.page(req, reply, { ...opts, admin: true });
  const csrf = (req) => html`<input type="hidden" name="_csrf" value="${csrfToken(req)}">`;
  const reasonInput = (placeholder) => html`<input name="reason" required maxlength="500" placeholder="${placeholder}">`;

  app.addHook('preHandler', async (req, reply) => {
    if (req.routeOptions.url === '/admin/login') return;
    if (!req.session.admin_id) return reply.redirect('/admin/login');
    if (req.method === 'POST' && !checkCsrf(req, req.body?._csrf)) return reply.code(403).send('Bad CSRF token');
  });

  // ---------- login ----------
  const loginForm = (req, error) => html`<section class="k-section narrow">
    <h1 class="k-h2">Вход для организатора</h1>
    ${error ? html`<p class="notice notice--error">${error}</p>` : ''}
    <form method="post" action="/admin/login" class="form">${csrf(req)}
      <label>Логин<input name="login" required autocomplete="username"></label>
      <label>Пароль<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn btn--primary">Войти</button>
    </form></section>`;

  app.get('/login', (req, reply) => page(req, reply, { title: 'Вход', body: loginForm(req) }));

  app.post('/login', async (req, reply) => {
    if (!checkCsrf(req, req.body?._csrf)) return reply.code(403).send('Bad CSRF token');
    if (tooManyAttempts(req.ip)) return page(req, reply, { status: 429, title: 'Вход', body: loginForm(req, 'Слишком много попыток. Подождите 15 минут.') });
    const { rows } = await pool.query('select id, password_hash from admins where login = $1', [String(req.body.login || '')]);
    const ok = rows[0] && (await verifyPassword(String(req.body.password || ''), rows[0].password_hash));
    if (!ok) return page(req, reply, { status: 401, title: 'Вход', body: loginForm(req, 'Неверный логин или пароль.') });
    attempts.delete(req.ip);
    await rotate(req, pool);
    touch(req, { admin_id: rows[0].id, account_id: null });
    await adminLog(pool, rows[0].id, 'login', null, null, { ip: req.ip });
    return reply.redirect('/admin');
  });

  app.post('/logout', async (req, reply) => {
    await destroy(req, reply, pool);
    return reply.redirect('/admin/login');
  });

  // ---------- dashboard ----------
  app.get('/', async (req, reply) => {
    const q = async (sql) => (await pool.query(sql)).rows[0].n;
    const stats = {
      pending: await q("select count(*)::int n from companies where status = 'pending' and disqualified_at is null"),
      approved: await q("select count(*)::int n from companies where status = 'approved' and disqualified_at is null"),
      videos: await q("select count(*)::int n from videos where status = 'pending'"),
      processing: await q("select count(*)::int n from videos where status = 'processing'"),
      votes: await q("select count(*)::int n from votes where status = 'valid'"),
      annulled: await q("select count(*)::int n from votes where status = 'annulled'"),
    };
    const body = html`<section class="k-section">
      <h1 class="k-h2">${c.title}</h1>
      <ul class="stats">
        <li><a href="/admin/companies?status=pending"><b>${stats.pending}</b> заявок на проверке</a></li>
        <li><a href="/admin/videos"><b>${stats.videos}</b> видео на проверке</a></li>
        ${stats.processing ? html`<li><a href="/admin/videos?status=processing"><b>${stats.processing}</b> видео обрабатываются</a></li>` : ''}
        <li><a href="/admin/companies?status=approved"><b>${stats.approved}</b> компаний в конкурсе</a></li>
        <li><a href="/admin/votes"><b>${stats.votes}</b> голосов засчитано</a></li>
        <li><a href="/admin/votes?status=annulled"><b>${stats.annulled}</b> аннулировано</a></li>
      </ul>
      <p class="k-note">Регистрация: ${dateTime(c.registrationStart)} – ${dateTime(c.registrationEnd)}.
        Голосование: ${dateTime(c.votingStart)} – ${dateTime(c.votingEnd)}. Время московское.</p>
      <p><a href="/admin/log">Журнал действий</a></p>
    </section>`;
    return page(req, reply, { title: 'Админка', body });
  });

  // ---------- companies ----------
  app.get('/companies', async (req, reply) => {
    const status = COMPANY_FILTERS[req.query.status] ? req.query.status : 'pending';
    const { rows } = await pool.query(
      `select c.*, (select count(*)::int from votes v where v.company_id = c.id and v.status = 'valid') as votes
         from companies c where ${COMPANY_FILTERS[status]} order by c.created_at asc`,
    );
    const tabs = Object.keys(COMPANY_FILTERS).map((k) => html`<a href="?status=${k}" ${k === status ? html`aria-current="page"` : ''}>${{ pending: 'На проверке', approved: 'Одобренные', rejected: 'Отклонённые', disqualified: 'Дисквалифицированные' }[k]}</a>`);
    const body = html`<section class="k-section">
      <h1 class="k-h2">Заявки</h1>
      <nav class="tabs">${tabs}</nav>
      ${rows.length === 0 ? html`<p>Пусто.</p>` : html`<table class="table">
        <thead><tr><th>Подана</th><th>Компания</th><th>Город</th><th>Капитан</th><th>Голоса</th><th></th></tr></thead>
        <tbody>${rows.map((r) => html`<tr>
          <td>${dateTime(r.created_at)}</td>
          <td>${r.name}</td><td>${r.city}</td>
          <td>${r.contact_phone}<br>${r.contact_email}</td>
          <td>${r.votes}</td>
          <td><a href="/admin/companies/${r.id}">Открыть</a></td>
        </tr>`)}</tbody></table>`}
    </section>`;
    return page(req, reply, { title: 'Заявки', body });
  });

  app.get('/companies/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const co = (await pool.query('select * from companies where id = $1', [id])).rows[0];
    if (!co) return reply.callNotFound();
    const videos = (await pool.query('select * from videos where company_id = $1 order by uploaded_at desc', [id])).rows;
    const votes = (await pool.query(
      "select status, count(*)::int n from votes where company_id = $1 group by status", [id])).rows;
    const vcount = Object.fromEntries(votes.map((v) => [v.status, v.n]));

    const body = html`<section class="k-section">
      <p><a href="/admin/companies?status=${co.disqualified_at ? 'disqualified' : co.status}">← К списку</a></p>
      <h1 class="k-h2">${co.name}</h1>
      <dl class="dl">
        <dt>Статус</dt><dd>${STATUS_RU[co.status]}${co.reject_reason ? ` — ${co.reject_reason}` : ''}${co.disqualified_at ? html` · <b>дисквалифицирована</b> ${dateTime(co.disqualified_at)}: ${co.disqualified_reason}` : ''}</dd>
        <dt>Город</dt><dd>${co.city}</dd>
        <dt>Рассказ</dt><dd class="pre">${co.story}</dd>
        <dt>Телефон капитана</dt><dd>${co.contact_phone}</dd>
        <dt>E-mail капитана</dt><dd>${co.contact_email}</dd>
        <dt>Карточка</dt><dd>${co.status === 'approved' ? html`<a href="/c/${co.slug}" target="_blank">/c/${co.slug}</a>` : 'появится после одобрения'}</dd>
        <dt>Голоса</dt><dd>засчитано ${vcount.valid || 0}, аннулировано ${vcount.annulled || 0} · <a href="/admin/votes?company=${co.id}">смотреть</a></dd>
        <dt>Подана</dt><dd>${exactTime(co.created_at)}</dd>
      </dl>

      <div class="admin-actions">
        ${co.status !== 'approved' && !co.disqualified_at ? html`
          <form method="post" action="/admin/companies/${co.id}/approve">${csrf(req)}<button class="btn btn--primary">Одобрить</button></form>` : ''}
        ${co.status === 'pending' && !co.disqualified_at ? html`
          <form method="post" action="/admin/companies/${co.id}/reject" class="inline-form">${csrf(req)}
            ${reasonInput('Причина отказа (её увидит капитан)')}<button class="btn btn--ghost">Отклонить</button></form>` : ''}
        ${!co.disqualified_at ? html`
          <form method="post" action="/admin/companies/${co.id}/disqualify" class="inline-form">${csrf(req)}
            ${reasonInput('Причина дисквалификации')}<button class="btn btn--danger">Дисквалифицировать</button></form>`
          : html`<form method="post" action="/admin/companies/${co.id}/reinstate">${csrf(req)}<button class="btn btn--ghost">Отменить дисквалификацию</button></form>`}
      </div>

      <h2 class="k-h2">Видео</h2>
      ${videos.length === 0 ? html`<p>Видео не загружено.</p>` : videos.map((v) => html`<p>${dateTime(v.uploaded_at)} · ${v.duration_sec} с · ${v.status}${v.reject_reason ? ` — ${v.reject_reason}` : ''}
        · <a href="/admin/videos?status=${v.status}#v${v.id}">к модерации</a></p>`)}
    </section>`;
    return page(req, reply, { title: co.name, body });
  });

  const companyAction = (name, sql, needReason) => app.post(`/companies/:id/${name}`, async (req, reply) => {
    const id = Number(req.params.id);
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (needReason && !reason) return reply.redirect(`/admin/companies/${id}`);
    await tx(pool, async (db) => {
      const r = await db.query(sql, [id, req.session.admin_id, reason || null]);
      if (r.rowCount) await adminLog(db, req.session.admin_id, `company.${name}`, 'company', id, reason ? { reason } : null);
    });
    return reply.redirect(`/admin/companies/${id}`);
  });

  companyAction('approve',
    `update companies set status = 'approved', reject_reason = null, moderated_at = now(), moderated_by = $2, updated_at = now()
      where id = $1 and status <> 'approved' and disqualified_at is null and $3::text is null`, false);
  companyAction('reject',
    `update companies set status = 'rejected', reject_reason = $3, moderated_at = now(), moderated_by = $2, updated_at = now()
      where id = $1 and status = 'pending'`, true);
  companyAction('disqualify',
    `update companies set disqualified_at = now(), disqualified_reason = $3, disqualified_by = $2, updated_at = now()
      where id = $1 and disqualified_at is null`, true);
  companyAction('reinstate',
    `update companies set disqualified_at = null, disqualified_reason = null, disqualified_by = $2, updated_at = now()
      where id = $1 and disqualified_at is not null and $3::text is null`, false);

  // ---------- videos ----------
  app.get('/videos', async (req, reply) => {
    const status = Object.keys(VIDEO_TABS).includes(req.query.status) ? req.query.status : 'pending';
    const { rows } = await pool.query(
      `select v.*, c.name, c.city, c.id as company_id
         from videos v join companies c on c.id = v.company_id
        where v.status = $1 order by v.uploaded_at asc`, [status]);
    const body = html`<section class="k-section">
      <h1 class="k-h2">Видео</h1>
      <nav class="tabs">${Object.entries(VIDEO_TABS).map(([k, label]) => html`<a href="?status=${k}" ${k === status ? html`aria-current="page"` : ''}>${label}</a>`)}</nav>
      <details class="k-note" open><summary>Требования к видео</summary><ul>${VIDEO_REQUIREMENTS.map((r) => html`<li>${r}</li>`)}</ul></details>
      ${rows.length === 0 ? html`<p>Пусто.</p>` : rows.map((v) => html`<article class="video-mod" id="v${v.id}">
        <h2 class="k-h2"><a href="/admin/companies/${v.company_id}">${v.name}</a> <span class="dim">${v.city}</span></h2>
        ${['processing', 'failed'].includes(v.status) ? '' : html`<video controls preload="metadata" playsinline src="/media/video/${v.id}"></video>`}
        ${v.processing_error ? html`<p class="notice notice--error">Ошибка обработки: <span class="mono">${v.processing_error}</span></p>` : ''}
        <p class="k-note">${v.duration_sec} с · ${(v.size_bytes / 1048576).toFixed(1)} МБ · загружено ${dateTime(v.uploaded_at)}
          ${v.reject_reason ? ` · причина отказа: ${v.reject_reason}` : ''}</p>
        ${v.status === 'pending' ? html`<div class="admin-actions">
          <form method="post" action="/admin/videos/${v.id}/approve">${csrf(req)}<button class="btn btn--primary">Принять (+${c.videoBonus})</button></form>
          <form method="post" action="/admin/videos/${v.id}/reject" class="inline-form">${csrf(req)}
            ${reasonInput('Причина отказа (её увидит капитан)')}<button class="btn btn--ghost">Отклонить</button></form>
        </div>` : ''}
      </article>`)}
    </section>`;
    return page(req, reply, { title: 'Видео', body });
  });

  app.post('/videos/:id/approve', async (req, reply) => {
    const id = Number(req.params.id);
    try {
      await tx(pool, async (db) => {
        const r = await db.query(
          `update videos set status = 'approved', moderated_at = now(), moderated_by = $2
            where id = $1 and status = 'pending' returning company_id`, [id, req.session.admin_id]);
        if (r.rowCount) await adminLog(db, req.session.admin_id, 'video.approve', 'video', id, { company_id: r.rows[0].company_id });
      });
    } catch (err) {
      if (err.code !== '23505') throw err; // company already has an approved video
    }
    return reply.redirect('/admin/videos');
  });

  app.post('/videos/:id/reject', async (req, reply) => {
    const id = Number(req.params.id);
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) return reply.redirect('/admin/videos');
    await tx(pool, async (db) => {
      const r = await db.query(
        `update videos set status = 'rejected', reject_reason = $3, moderated_at = now(), moderated_by = $2
          where id = $1 and status = 'pending' returning company_id`, [id, req.session.admin_id, reason]);
      if (r.rowCount) await adminLog(db, req.session.admin_id, 'video.reject', 'video', id, { reason, company_id: r.rows[0].company_id });
    });
    return reply.redirect('/admin/videos');
  });

  // ---------- votes ----------
  function voteFilter(query) {
    const where = [];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (query.company && Number.isInteger(Number(query.company))) add('v.company_id = ?', Number(query.company));
    if (['valid', 'annulled'].includes(query.status)) add('v.status = ?', query.status);
    if (query.ip && /^[0-9a-fA-F:.\/]+$/.test(query.ip)) add(query.ip.includes('/') ? 'v.ip <<= ?::inet' : 'v.ip = ?::inet', query.ip);
    if (query.provider && ['vk', 'sber', 'dev'].includes(query.provider)) add('v.provider = ?', query.provider);
    return { where: where.length ? `where ${where.join(' and ')}` : '', params };
  }

  app.get('/votes', async (req, reply) => {
    const { where, params } = voteFilter(req.query);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { rows } = await pool.query(
      `select v.*, host(v.ip) as ip_text, c.name as company_name
         from votes v join companies c on c.id = v.company_id ${where}
        order by v.created_at desc limit ${PAGE_SIZE} offset ${offset}`, params);
    const total = (await pool.query(`select count(*)::int n from votes v ${where}`, params)).rows[0].n;

    // Signals of possible cheating within the current filter.
    const byIp = (await pool.query(
      `select host(v.ip) as ip, count(*)::int n, count(distinct v.company_id)::int companies
         from votes v ${where} group by v.ip having count(*) >= 3 order by n desc limit 20`, params)).rows;
    const bySubnet = (await pool.query(
      `select host(network(set_masklen(v.ip, 24))) || '/24' as net, count(*)::int n
         from votes v ${where ? `${where} and` : 'where'} family(v.ip) = 4
        group by 1 having count(*) >= 10 order by n desc limit 20`, params)).rows;
    const byMinute = (await pool.query(
      `select c.name, date_trunc('minute', v.created_at) as minute, count(*)::int n
         from votes v join companies c on c.id = v.company_id ${where}
        group by c.name, minute having count(*) >= 10 order by n desc limit 20`, params)).rows;

    const qs = new URLSearchParams(Object.entries(req.query).filter(([k, v]) => v && k !== 'offset'));
    const body = html`<section class="k-section">
      <h1 class="k-h2">Голоса</h1>
      <form method="get" class="filters">
        <label>Компания (id)<input name="company" value="${req.query.company || ''}" size="6"></label>
        <label>IP или подсеть<input name="ip" value="${req.query.ip || ''}" placeholder="1.2.3.4 или 1.2.3.0/24"></label>
        <label>Статус<select name="status">
          <option value="">все</option>
          <option value="valid" ${req.query.status === 'valid' ? html`selected` : ''}>засчитанные</option>
          <option value="annulled" ${req.query.status === 'annulled' ? html`selected` : ''}>аннулированные</option></select></label>
        <label>Вход<select name="provider"><option value="">любой</option>
          <option value="vk" ${req.query.provider === 'vk' ? html`selected` : ''}>VK ID</option>
          <option value="sber" ${req.query.provider === 'sber' ? html`selected` : ''}>Сбер ID</option></select></label>
        <button class="btn btn--ghost">Показать</button>
        <a href="/admin/votes.csv?${qs.toString()}">Выгрузить CSV</a>
      </form>

      ${byIp.length || bySubnet.length || byMinute.length ? html`<div class="signals">
        <h2 class="k-h2">На что посмотреть</h2>
        ${byIp.length ? html`<p>Много голосов с одного IP:</p><ul>${byIp.map((r) => html`<li><a href="?ip=${r.ip}">${r.ip}</a> — ${r.n} (компаний: ${r.companies})</li>`)}</ul>` : ''}
        ${bySubnet.length ? html`<p>Много голосов из одной подсети /24:</p><ul>${bySubnet.map((r) => html`<li><a href="?ip=${encodeURIComponent(r.net)}">${r.net}</a> — ${r.n}</li>`)}</ul>` : ''}
        ${byMinute.length ? html`<p>Всплески (10+ голосов за минуту):</p><ul>${byMinute.map((r) => html`<li>${r.name} — ${dateTime(r.minute)}: ${r.n}</li>`)}</ul>` : ''}
        <p class="k-note">Это только подсказки: офисы и мобильные операторы дают много голосов с одного IP. Решение — за организатором.</p>
      </div>` : ''}

      <form method="post" action="/admin/votes/annul" class="votes-form">${csrf(req)}
        <p>Найдено: ${total}. Показаны ${Math.min(total, offset + 1)}–${Math.min(total, offset + rows.length)}.</p>
        <table class="table table--dense">
          <thead><tr><th><input type="checkbox" data-check-all aria-label="Выбрать все"></th><th>Время (МСК)</th><th>Компания</th><th>Вход</th><th>IP</th><th>Браузер</th><th>Источник</th><th>Статус</th></tr></thead>
          <tbody>${rows.map((v) => html`<tr class="${v.status === 'annulled' ? 'is-annulled' : ''}">
            <td><input type="checkbox" name="ids" value="${v.id}"></td>
            <td class="mono">${exactTime(v.created_at)}</td>
            <td><a href="?company=${v.company_id}">${v.company_name}</a></td>
            <td>${v.provider}</td>
            <td><a href="?ip=${v.ip_text || ''}">${v.ip_text || '—'}</a></td>
            <td class="ua">${v.user_agent || '—'}</td>
            <td>${v.utm ? Object.entries(v.utm).map(([k, val]) => `${k}=${val}`).join(' ') : ''} ${v.referer || ''}</td>
            <td>${STATUS_RU[v.status]}${v.annul_reason ? html`<br><span class="dim">${v.annul_reason}</span>` : ''}</td>
          </tr>`)}</tbody>
        </table>
        ${offset + rows.length < total ? html`<p><a href="?${qs.toString()}&offset=${offset + PAGE_SIZE}">Следующие ${PAGE_SIZE}</a></p>` : ''}
        <div class="admin-actions">
          <label>Причина ${reasonInput('Например: накрутка с одного IP')}</label>
          <button class="btn btn--danger" name="action" value="annul">Аннулировать выбранные</button>
          <button class="btn btn--ghost" name="action" value="restore" formnovalidate>Вернуть выбранные</button>
        </div>
      </form>
      <script>
        document.querySelector('[data-check-all]')?.addEventListener('change', (e) => {
          document.querySelectorAll('input[name="ids"]').forEach((c) => { c.checked = e.target.checked; });
        });
      </script>
    </section>`;
    return page(req, reply, { title: 'Голоса', body });
  });

  app.post('/votes/annul', async (req, reply) => {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Number.isInteger);
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    const restore = req.body.action === 'restore';
    if (!ids.length || (!restore && !reason)) return reply.redirect(backToVotes(req));
    await tx(pool, async (db) => {
      const r = restore
        ? await db.query(
          `update votes set status = 'valid', annul_reason = null, annulled_at = null, annulled_by = null
            where id = any($1) and status = 'annulled' returning id`, [ids])
        : await db.query(
          `update votes set status = 'annulled', annul_reason = $2, annulled_at = now(), annulled_by = $3
            where id = any($1) and status = 'valid' returning id`, [ids, reason, req.session.admin_id]);
      if (r.rowCount) {
        await adminLog(db, req.session.admin_id, restore ? 'votes.restore' : 'votes.annul', 'vote', null,
          { ids: r.rows.map((x) => x.id), reason: reason || null });
      }
    });
    return reply.redirect(backToVotes(req));
  });

  app.get('/votes.csv', async (req, reply) => {
    const { where, params } = voteFilter(req.query);
    const { rows } = await pool.query(
      `select v.id, v.created_at, c.id as company_id, c.name as company, v.provider, host(v.ip) as ip, v.user_agent,
              v.referer, v.utm, v.status, v.annul_reason
         from votes v join companies c on c.id = v.company_id ${where} order by v.created_at`, params);
    const cell = (x) => {
      let s = x === null || x === undefined ? '' : typeof x === 'object' && !(x instanceof Date) ? JSON.stringify(x) : String(x instanceof Date ? exactTime(x) : x);
      if (/^[=+\-@]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['id', 'время МСК', 'company_id', 'компания', 'вход', 'ip', 'браузер', 'referer', 'utm', 'статус', 'причина'];
    const csv = [head, ...rows.map((r) => [r.id, r.created_at, r.company_id, r.company, r.provider, r.ip, r.user_agent, r.referer, r.utm, r.status, r.annul_reason])]
      .map((line) => line.map(cell).join(';')).join('\r\n');
    await adminLog(pool, req.session.admin_id, 'votes.export', null, null, { filter: req.query, rows: rows.length });
    reply.header('content-disposition', 'attachment; filename="votes.csv"');
    return reply.type('text/csv; charset=utf-8').send(`﻿${csv}`);
  });

  // ---------- results ----------
  app.get('/results', async (req, reply) => {
    const rows = await ranking(pool, c);
    const top = winners(rows, c.winners);
    const published = await getSetting(pool, 'results_published', false);
    const ties = rows.some((r) => r.unresolvedTie && r.place <= c.winners);
    const body = html`<section class="k-section">
      <h1 class="k-h2">Итоги</h1>
      <p>Баллы = засчитанные голоса × ${c.votePoints} + ${c.videoBonus} за принятое видео.
        При равенстве выше та компания, которая раньше набрала итоговую сумму (момент последнего засчитанного голоса или принятия видео).</p>
      ${ties ? html`<p class="notice notice--error">В призовых местах есть полное совпадение баллов и времени. Правило ничьей не различает эти компании — нужно решение по Положению.</p>` : ''}
      <table class="table">
        <thead><tr><th>Место</th><th>Компания</th><th>Голоса</th><th>Видео</th><th>Баллы</th><th>Итог набран (МСК)</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr class="${r.place <= c.winners && r.score > 0 ? 'is-winner' : ''}">
          <td>${r.place}${r.unresolvedTie ? ' ⚠' : ''}</td>
          <td><a href="/admin/companies/${r.id}">${r.name}</a></td>
          <td>${r.votes}</td><td>${r.has_video_bonus ? `+${c.videoBonus}` : '—'}</td>
          <td><b>${r.score}</b></td><td class="mono">${exactTime(r.reached_at)}</td>
        </tr>`)}</tbody>
      </table>
      <p>Победители сейчас: ${top.length ? top.map((r) => `${r.place}. ${r.name}`).join(', ') : 'нет'}.</p>
      <form method="post" action="/admin/results/publish" class="admin-actions">${csrf(req)}
        <input type="hidden" name="value" value="${published ? 'no' : 'yes'}">
        <span>Публичная страница /results: <b>${published ? 'опубликована' : 'скрыта'}</b></span>
        <button class="btn ${published ? 'btn--ghost' : 'btn--primary'}">${published ? 'Скрыть итоги' : 'Опубликовать итоги'}</button>
      </form>
    </section>`;
    return page(req, reply, { title: 'Итоги', body });
  });

  app.post('/results/publish', async (req, reply) => {
    const value = req.body.value === 'yes';
    await tx(pool, async (db) => {
      await setSetting(db, 'results_published', value);
      await adminLog(db, req.session.admin_id, value ? 'results.publish' : 'results.hide', null, null);
    });
    return reply.redirect('/admin/results');
  });

  // ---------- log ----------
  app.get('/log', async (req, reply) => {
    const { rows } = await pool.query(
      `select l.*, a.login from admin_log l left join admins a on a.id = l.admin_id order by l.id desc limit 500`);
    const body = html`<section class="k-section"><h1 class="k-h2">Журнал действий</h1>
      <table class="table table--dense"><thead><tr><th>Время (МСК)</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Детали</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td class="mono">${exactTime(r.created_at)}</td><td>${r.login}</td><td>${r.action}</td>
        <td>${r.target_type ? `${r.target_type} #${r.target_id ?? ''}` : ''}</td><td class="ua">${r.details ? JSON.stringify(r.details) : ''}</td></tr>`)}</tbody></table>
    </section>`;
    return page(req, reply, { title: 'Журнал', body });
  });
}
