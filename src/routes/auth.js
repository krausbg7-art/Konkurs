// Login via VK ID / Sber ID with a consent step before leaving for the provider.
import { html } from '../html.js';
import { simpleBody } from '../views/layout.js';
import { csrfToken, checkCsrf, setData, rotate, destroy, touch } from '../session.js';
import { pkcePair, randomToken, phoneHash, safeNext, safeEqual } from '../security.js';

export default async function authRoutes(app, { ctx }) {
  const { cfg, pool, providers } = ctx;
  const redirectUri = (id) => `${cfg.publicUrl}/auth/${id}/callback`;

  const consentBody = (req, provider, next, error) => {
    const d = cfg.docs;
    const doc = (url, text) => (url ? html`<a href="${url}" target="_blank" rel="noopener">${text}</a>` : text);
    return html`<section class="k-section narrow">
      <h1 class="k-h2">Вход через ${provider.title}</h1>
      ${error ? html`<p class="notice notice--error">${error}</p>` : ''}
      <p>Мы получим от ${provider.title} только идентификатор аккаунта и подтверждённый номер телефона.
         Номер нужен, чтобы один человек не проголосовал дважды через разные сервисы.
         Мы храним не сам номер, а его зашифрованный отпечаток. Имя и фото не запрашиваем и не публикуем.</p>
      <form method="post" action="/login/${provider.id}" class="form">
        <input type="hidden" name="_csrf" value="${csrfToken(req)}">
        <input type="hidden" name="next" value="${next}">
        <label class="check">
          <input type="checkbox" name="consent" value="yes" required>
          <span>Даю ${doc(d.consent, 'согласие на обработку персональных данных')}
            и принимаю ${doc(d.privacy, 'политику конфиденциальности')}
            и ${doc(d.rules, 'Положение о конкурсе')}.</span>
        </label>
        <button class="btn btn--primary">Продолжить</button>
      </form>
    </section>`;
  };

  const getProvider = (id) => {
    const p = providers[id];
    return p && p.enabled ? p : null;
  };

  app.get('/login/:provider', async (req, reply) => {
    const p = getProvider(req.params.provider);
    if (!p) {
      return ctx.page(req, reply, { status: 404, title: 'Вход недоступен', body: simpleBody('Вход недоступен', 'Этот способ входа пока не подключён.', '/') });
    }
    const next = safeNext(req.query.next, '/my');
    return ctx.page(req, reply, { title: `Вход через ${p.title}`, body: consentBody(req, p, next) });
  });

  app.post('/login/:provider', async (req, reply) => {
    const p = getProvider(req.params.provider);
    if (!p) return reply.code(404).send();
    if (!checkCsrf(req, req.body?._csrf)) return reply.code(403).send('Bad CSRF token');
    const next = safeNext(req.body?.next, '/my');
    if (req.body?.consent !== 'yes') {
      return ctx.page(req, reply, { status: 400, title: 'Нужно согласие', body: consentBody(req, p, next, 'Отметьте согласие, чтобы продолжить.') });
    }
    const { verifier, challenge } = pkcePair();
    const state = randomToken(24);
    const nonce = randomToken(16);
    setData(req, {
      oauth: { provider: p.id, state, verifier, nonce, next, consentAt: new Date().toISOString(), consentIp: req.ip },
    });
    return reply.redirect(p.authorizeUrl({ state, challenge, nonce, redirectUri: redirectUri(p.id) }));
  });

  // Dev-only fake provider page.
  if (providers.dev) {
    app.get('/auth/dev/form', async (req, reply) => ctx.page(req, reply, {
      title: 'Тестовый вход',
      body: html`<section class="k-section narrow"><h1 class="k-h2">Тестовый вход</h1>
        <form method="get" action="/auth/dev/callback" class="form">
          <input type="hidden" name="state" value="${req.query.state}">
          <label>ID аккаунта<input name="uid" required></label>
          <label>Телефон<input name="phone" placeholder="+7 900 000-00-00"></label>
          <button class="btn btn--primary">Войти</button>
        </form></section>`,
    }));
  }

  app.get('/auth/:provider/callback', async (req, reply) => {
    const p = getProvider(req.params.provider);
    const o = req.session.data.oauth;
    const fail = (text) => ctx.page(req, reply, { status: 400, title: 'Не удалось войти', body: simpleBody('Не удалось войти', text, '/') });

    if (!p || !o || o.provider !== p.id) return fail('Сессия входа устарела. Начните вход заново.');
    if (!safeEqual(req.query.state, o.state)) return fail('Сессия входа устарела. Начните вход заново.');
    if (req.query.error) return fail('Вход отменён.');

    let profile;
    try {
      profile = await p.complete({ query: req.query, verifier: o.verifier, nonce: o.nonce, state: o.state, redirectUri: redirectUri(p.id) });
    } catch (err) {
      req.log.warn({ err: err.message, provider: p.id }, 'oauth failed');
      return fail('Сервис входа не ответил. Попробуйте ещё раз.');
    }

    const hash = profile.phone ? phoneHash(profile.phone, cfg.phoneHashSecret) : null;
    const { rows } = await pool.query(
      `insert into accounts (provider, provider_user_id, phone_hash, consent_at, consent_version, consent_ip)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (provider, provider_user_id) do update
         set phone_hash = coalesce(excluded.phone_hash, accounts.phone_hash),
             consent_at = excluded.consent_at, consent_version = excluded.consent_version,
             consent_ip = excluded.consent_ip, last_login_at = now()
       returning id`,
      [p.id, profile.providerUserId, hash, o.consentAt, cfg.docs.consentVersion, o.consentIp],
    );

    const { oauth, ...rest } = req.session.data;
    await rotate(req, pool);
    touch(req, { account_id: rows[0].id, data: rest });
    return reply.redirect(safeNext(o.next, '/my'));
  });

  app.post('/logout', async (req, reply) => {
    if (!checkCsrf(req, req.body?._csrf)) return reply.code(403).send('Bad CSRF token');
    await destroy(req, reply, pool);
    return reply.redirect('/');
  });
}
