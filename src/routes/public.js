import path from 'node:path';
import { html, date, dateTime, plural } from '../html.js';
import { simpleBody } from '../views/layout.js';
import { phase, isVotingOpen, t } from '../config.js';
import { ranking, winners } from '../scoring.js';
import { getSetting } from '../db.js';
import { voteBlock } from './vote.js';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

export default async function publicRoutes(app, { ctx }) {
  const { cfg, pool } = ctx;
  const c = cfg.contest;

  // Dates and links for the landing page (konkurs.js).
  app.get('/api/contest', async (req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    const p = (id) => (ctx.providers[id]?.enabled ? `/login/${id}?next=/my` : '');
    return {
      title: c.title,
      registrationStart: c.registrationStart,
      registrationEnd: c.registrationEnd,
      votingStart: c.votingStart,
      votingEnd: c.votingEnd,
      resultsDate: c.resultsDate,
      prizesBy: c.prizesBy,
      phase: phase(c, ctx.now()),
      endpoints: { loginVk: p('vk'), loginSber: p('sber'), rules: cfg.docs.rules, gallery: '/companies', rating: '/rating' },
    };
  });

  app.get('/companies', async (req, reply) => {
    const { rows } = await pool.query(
      `select c.slug, c.name, c.city, c.story, (v.id is not null) as has_video
         from companies c
         left join videos v on v.company_id = c.id and v.status = 'approved'
        where c.status = 'approved' and c.disqualified_at is null
        order by c.moderated_at asc, c.id asc`,
    );
    const body = html`<section class="k-section">
      <h1 class="k-h2">Участники</h1>
      ${rows.length === 0
        ? html`<p>Пока нет одобренных заявок. Карточки появятся здесь после проверки.</p>`
        : html`<ul class="gallery">${rows.map((r) => html`<li class="gallery__item">
            <a href="/c/${r.slug}">
              <b class="gallery__name">${r.name}</b>
              <span class="gallery__city">${r.city}</span>
              <span class="gallery__story">${excerpt(r.story, 160)}</span>
              ${r.has_video ? html`<span class="tag">Есть видео</span>` : ''}
            </a></li>`)}</ul>`}
    </section>`;
    return ctx.page(req, reply, { title: 'Участники', body });
  });

  app.get('/c/:slug', async (req, reply) => {
    const { rows } = await pool.query(
      `select c.id, c.slug, c.name, c.city, c.story, c.disqualified_at,
              v.id as video_id
         from companies c
         left join videos v on v.company_id = c.id and v.status = 'approved'
        where c.slug = $1 and c.status = 'approved'`,
      [req.params.slug],
    );
    const company = rows[0];
    if (!company) return reply.callNotFound();

    // Remember where the voter came from; saved with the vote.
    const utm = Object.fromEntries(UTM_KEYS.filter((k) => req.query[k]).map((k) => [k, String(req.query[k]).slice(0, 200)]));
    if (Object.keys(utm).length || req.headers.referer) {
      req.session.data = { ...req.session.data, source: { utm, referer: (req.headers.referer || '').slice(0, 500), slug: company.slug } };
      req.session.dirty = true;
    }

    const shareUrl = `${cfg.publicUrl}/c/${company.slug}`;
    const body = html`<article class="k-section company">
      <p class="hero__kicker">${company.city}</p>
      <h1 class="k-h2 company__name">${company.name}</h1>
      ${company.disqualified_at ? html`<p class="notice notice--error">Компания дисквалифицирована организатором.</p>` : ''}
      ${company.video_id
        ? html`<video class="company__video" controls preload="metadata" playsinline src="/media/video/${company.video_id}"></video>`
        : ''}
      <div class="company__story">${paragraphs(company.story)}</div>
      ${company.disqualified_at ? '' : await voteBlock(ctx, req, company)}
      <p class="k-note">Ссылка на эту карточку: <span class="mono">${shareUrl}</span></p>
    </article>`;
    return ctx.page(req, reply, { title: company.name, body, head: ctx.captcha.enabled && isVotingOpen(c, ctx.now()) ? ctx.captcha.headTag : '' });
  });

  app.get('/rating', async (req, reply) => {
    const now = ctx.now();
    if (now < t(c.votingStart)) {
      return ctx.page(req, reply, {
        title: 'Рейтинг',
        body: simpleBody('Рейтинг', `Рейтинг откроется вместе с голосованием ${date(c.votingStart)}.`, '/companies'),
      });
    }
    const rows = await ranking(pool, c);
    const body = html`<section class="k-section">
      <h1 class="k-h2">Рейтинг</h1>
      <p class="k-note">Баллы = голоса × ${c.votePoints} + ${c.videoBonus} за принятое видео.
        ${isVotingOpen(c, now) ? `Голосование идёт до ${dateTime(c.votingEnd)}.` : 'Голосование завершено. Окончательные итоги — после проверки голосов.'}</p>
      ${ratingTable(rows, c.videoBonus)}
    </section>`;
    return ctx.page(req, reply, { title: 'Рейтинг', body });
  });

  app.get('/results', async (req, reply) => {
    const published = await getSetting(pool, 'results_published', false);
    if (!published) {
      return ctx.page(req, reply, {
        title: 'Итоги',
        body: simpleBody('Итоги', `Итоги будут опубликованы ${date(c.resultsDate)} после проверки голосов.`, '/rating'),
      });
    }
    const rows = await ranking(pool, c);
    const top = winners(rows, c.winners);
    const body = html`<section class="k-section">
      <h1 class="k-h2">Итоги конкурса</h1>
      <ol class="winners">${top.map((r) => html`<li>
        <span class="winners__place">${r.place} место</span>
        <a href="/c/${r.slug}">${r.name}</a>, ${r.city} — <b>${r.score} ${plural(r.score, 'балл', 'балла', 'баллов')}</b>
      </li>`)}</ol>
      <h2 class="k-h2">Все участники</h2>
      ${ratingTable(rows, c.videoBonus)}
    </section>`;
    return ctx.page(req, reply, { title: 'Итоги', body });
  });

  // Approved videos are public; the captain and the organiser can also watch pending ones.
  app.get('/media/video/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.callNotFound();
    const { rows } = await pool.query(
      `select v.file_name, v.mime, v.status, c.captain_account_id, c.status as company_status, c.disqualified_at
         from videos v join companies c on c.id = v.company_id where v.id = $1`,
      [id],
    );
    const v = rows[0];
    if (!v) return reply.callNotFound();
    const isPublic = v.status === 'approved' && v.company_status === 'approved' && !v.disqualified_at;
    const isOwner = req.session.account_id && req.session.account_id === v.captain_account_id;
    if (!isPublic && !isOwner && !req.session.admin_id) return reply.callNotFound();
    reply.header('cache-control', isPublic ? 'public, max-age=3600' : 'private, no-store');
    if (v.mime) reply.type(v.mime);
    return reply.sendFile(v.file_name, path.resolve(cfg.videoDir));
  });
}

export function ratingTable(rows, bonus) {
  if (!rows.length) return html`<p>Пока нет участников.</p>`;
  return html`<table class="table">
    <thead><tr><th>Место</th><th>Компания</th><th>Голоса</th><th>Видео</th><th>Баллы</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr>
      <td>${r.place}</td>
      <td><a href="/c/${r.slug}">${r.name}</a> <span class="dim">${r.city}</span></td>
      <td>${r.votes}</td>
      <td>${r.has_video_bonus ? `+${bonus}` : '—'}</td>
      <td><b>${r.score}</b></td>
    </tr>`)}</tbody>
  </table>`;
}

const excerpt = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const paragraphs = (s) => s.split(/\n{2,}|\r\n\r\n/).map((p) => html`<p>${p}</p>`);
