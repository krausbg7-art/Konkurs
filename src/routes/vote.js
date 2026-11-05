// Voting. Rules enforced on the server, not only in the page:
//  - only between VOTING_START and VOTING_END (Moscow time);
//  - one vote per person for the whole contest: unique account AND unique phone hash,
//    so the same person cannot vote once via VK ID and once via Sber ID;
//  - accounts without a confirmed phone cannot vote;
//  - captcha must pass;
//  - time, IP, browser, referer and UTM are stored with every vote.
import { html, date, dateTime } from '../html.js';
import { simpleBody } from '../views/layout.js';
import { csrfToken, checkCsrf } from '../session.js';
import { isVotingOpen, t } from '../config.js';
import { captchaTokenField } from '../captcha.js';

export async function voteBlock(ctx, req, company) {
  const { cfg, pool } = ctx;
  const c = cfg.contest;
  const now = ctx.now();
  const back = `/c/${company.slug}`;

  if (now < t(c.votingStart)) {
    return html`<div class="vote"><button class="btn btn--primary" disabled aria-disabled="true">Проголосовать</button>
      <p class="k-note">Голосование откроется ${date(c.votingStart)} у всех участников одновременно.</p></div>`;
  }
  if (!isVotingOpen(c, now)) {
    return html`<div class="vote"><p class="k-note">Голосование завершено.</p></div>`;
  }

  const accountId = req.session.account_id;
  if (!accountId) {
    const login = Object.values(ctx.providers).filter((p) => p.enabled);
    return html`<div class="vote">
      <p>Чтобы проголосовать, войдите через ${login.map((p) => p.title).join(' или ')}. Голос можно отдать один раз за весь конкурс.</p>
      <div class="k-actions">${login.map((p) => html`<a class="btn btn--primary k-btn-${p.id}" href="/login/${p.id}?next=${encodeURIComponent(back)}">Войти через ${p.title}</a>`)}</div>
    </div>`;
  }

  const existing = await findVote(pool, accountId);
  if (existing) {
    return html`<div class="vote"><p class="notice">Вы уже проголосовали${existing.company_id === company.id ? ' за эту компанию' : html` за <a href="/c/${existing.slug}">${existing.name}</a>`}.
      Голос можно отдать один раз за весь конкурс.</p></div>`;
  }

  return html`<form class="vote form" method="post" action="/c/${company.slug}/vote">
    <input type="hidden" name="_csrf" value="${csrfToken(req)}">
    ${ctx.captcha.widget()}
    <button class="btn btn--primary">Проголосовать за «${company.name}»</button>
    <p class="k-note">Голос можно отдать один раз за весь конкурс и только за одну компанию. Голосование до ${dateTime(c.votingEnd)}.</p>
  </form>`;
}

// Vote by this account, or by another account with the same phone.
async function findVote(db, accountId) {
  const { rows } = await db.query(
    `select v.company_id, c.slug, c.name
       from votes v join companies c on c.id = v.company_id
      where v.account_id = $1
         or v.phone_hash = (select phone_hash from accounts where id = $1 and phone_hash is not null)
      limit 1`,
    [accountId],
  );
  return rows[0] || null;
}

export default async function voteRoutes(app, { ctx }) {
  const { cfg, pool } = ctx;

  app.post('/c/:slug/vote', async (req, reply) => {
    const slug = req.params.slug;
    const back = `/c/${slug}`;
    const done = (title, text, status = 400) => ctx.page(req, reply, { status, title, body: simpleBody(title, text, back) });

    if (!checkCsrf(req, req.body?._csrf)) return done('Страница устарела', 'Обновите страницу и попробуйте ещё раз.', 403);
    if (!isVotingOpen(cfg.contest, ctx.now())) return done('Голосование закрыто', 'Сейчас голоса не принимаются.');

    const accountId = req.session.account_id;
    if (!accountId) return reply.redirect(back);

    const acc = (await pool.query('select id, provider, phone_hash from accounts where id = $1', [accountId])).rows[0];
    if (!acc) return reply.redirect(back);
    if (!acc.phone_hash) {
      return done('Нужен подтверждённый телефон',
        'В вашем аккаунте нет подтверждённого номера телефона или вы не разрешили его передать. Войдите снова и разрешите доступ к номеру или используйте другой способ входа.');
    }

    const company = (await pool.query(
      `select id, name from companies where slug = $1 and status = 'approved' and disqualified_at is null`, [slug],
    )).rows[0];
    if (!company) return reply.callNotFound();

    const captchaOk = await ctx.captcha.verify(req.body?.[captchaTokenField], req.ip);
    if (!captchaOk) return done('Проверка не пройдена', 'Подтвердите, что вы не робот, и попробуйте ещё раз.');

    const src = req.session.data.source?.slug === slug ? req.session.data.source : {};
    try {
      await pool.query(
        `insert into votes (company_id, account_id, phone_hash, provider, ip, user_agent, referer, utm, captcha_ok)
         values ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [
          company.id, acc.id, acc.phone_hash, acc.provider, req.ip,
          (req.headers['user-agent'] || '').slice(0, 500),
          src.referer || null,
          src.utm && Object.keys(src.utm).length ? JSON.stringify(src.utm) : null,
        ],
      );
    } catch (err) {
      if (err.code === '23505') return done('Вы уже голосовали', 'Голос можно отдать один раз за весь конкурс.', 409);
      throw err;
    }
    return done('Спасибо, голос принят', `Вы проголосовали за «${company.name}».`, 200);
  });
}
