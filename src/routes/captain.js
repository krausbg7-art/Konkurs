// Captain's cabinet: application form, its status, the share link and video upload.
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { rename, unlink, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { html, date, dateTime } from '../html.js';
import { csrfToken, checkCsrf } from '../session.js';
import { isRegistrationOpen, isVideoUploadOpen, t } from '../config.js';
import { randomSlug, randomToken, normalizePhone } from '../security.js';
import { probe, checkDuration, ALLOWED_EXT } from '../video.js';

const LIMITS = { name: [2, 100], city: [2, 80], story: [20, 1000] };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCompany(input) {
  const v = {
    name: String(input.name ?? '').trim(),
    city: String(input.city ?? '').trim(),
    story: String(input.story ?? '').replace(/\r\n/g, '\n').trim(),
    contact_phone: String(input.contact_phone ?? '').trim(),
    contact_email: String(input.contact_email ?? '').trim(),
  };
  const errors = {};
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    if (v[k].length < min) errors[k] = `Минимум ${min} символов`;
    else if (v[k].length > max) errors[k] = `Максимум ${max} символов`;
  }
  const phone = normalizePhone(v.contact_phone);
  if (!phone || phone.length > 15) errors.contact_phone = 'Укажите номер телефона';
  else v.contact_phone = `+${phone}`;
  if (!EMAIL_RE.test(v.contact_email) || v.contact_email.length > 200) errors.contact_email = 'Укажите e-mail';
  if (input.publish_consent !== 'yes') errors.publish_consent = 'Нужно согласие на публикацию';
  return { values: v, errors };
}

const STATUS_TEXT = {
  pending: 'Заявка на проверке.',
  approved: 'Заявка одобрена. Карточка опубликована.',
  rejected: 'Заявка отклонена.',
};
const VIDEO_STATUS = { processing: 'обрабатывается', pending: 'на проверке', approved: 'принято, начислено', rejected: 'отклонено' };

export default async function captainRoutes(app, { ctx }) {
  const { cfg, pool } = ctx;
  const c = cfg.contest;

  const loadCompany = async (accountId) =>
    (await pool.query('select * from companies where captain_account_id = $1', [accountId])).rows[0] || null;

  const loadVideos = async (companyId) =>
    (await pool.query('select * from videos where company_id = $1 order by uploaded_at desc', [companyId])).rows;

  function companyForm(req, values = {}, errors = {}, action = 'create') {
    const err = (k) => (errors[k] ? html`<span class="field-error">${errors[k]}</span>` : '');
    return html`<form method="post" action="/my/company" class="form">
      <input type="hidden" name="_csrf" value="${csrfToken(req)}">
      <label>Название компании ${err('name')}<input name="name" maxlength="100" required value="${values.name || ''}"></label>
      <label>Город ${err('city')}<input name="city" maxlength="80" required value="${values.city || ''}"></label>
      <label>Коротко о компании ${err('story')}
        <textarea name="story" rows="6" maxlength="1000" required>${values.story || ''}</textarea>
        <span class="hint">До 1000 знаков. Этот текст будет виден всем на карточке компании.</span></label>
      <fieldset class="form__private">
        <legend>Контакты капитана — видны только организатору</legend>
        <label>Телефон ${err('contact_phone')}<input name="contact_phone" type="tel" required value="${values.contact_phone || ''}"></label>
        <label>E-mail ${err('contact_email')}<input name="contact_email" type="email" required value="${values.contact_email || ''}"></label>
      </fieldset>
      <label class="check">${err('publish_consent')}
        <input type="checkbox" name="publish_consent" value="yes" required>
        <span>Я вправе действовать от имени компании и согласен на публикацию названия, города, рассказа и видео на сайте конкурса.</span>
      </label>
      <button class="btn btn--primary">${action === 'create' ? 'Отправить заявку' : 'Отправить заново'}</button>
    </form>`;
  }

  function videoSection(req, company, videos) {
    const now = ctx.now();
    const current = videos.find((v) => v.status === 'approved') || videos.find((v) => ['pending', 'processing'].includes(v.status));
    // videos are sorted newest first
    const lastProblem = !current && videos.find((v) => ['rejected', 'failed'].includes(v.status));
    const canUpload = !current && isVideoUploadOpen(c, now);

    return html`<section class="k-section">
      <h2 class="k-h2">Видео</h2>
      <p>Видео до ${cfg.video.maxSeconds} секунд на тему «почему мы должны выиграть». После проверки компании начисляется
        <b>${c.videoBonus} баллов</b> (один раз).</p>
      <p class="k-note">Нельзя: запуск пиротехники в помещении, с балкона или из окна; дети рядом с пиротехникой;
        опасные действия; чужая реклама; музыка без прав.</p>
      ${current?.status === 'processing'
        ? html`<p class="notice">Видео загружено и обрабатывается: переводим его в формат, который открывается в любом браузере.
            Потом оно уйдёт на проверку. Обновите страницу чуть позже.</p>`
        : current ? html`<p class="notice">Видео ${VIDEO_STATUS[current.status]}${current.status === 'approved' ? ` +${c.videoBonus} баллов` : ''}.</p>
        <video class="company__video" controls preload="metadata" playsinline src="/media/video/${current.id}"></video>` : ''}
      ${lastProblem?.status === 'rejected' ? html`<p class="notice notice--error">Видео отклонено: ${lastProblem.reject_reason}. Можно загрузить другое.</p>` : ''}
      ${lastProblem?.status === 'failed' ? html`<p class="notice notice--error">Не получилось обработать видео. Попробуйте загрузить его ещё раз или сохранить в другом формате.</p>` : ''}
      ${canUpload
        ? html`<form method="post" action="/my/video?_csrf=${encodeURIComponent(csrfToken(req))}" enctype="multipart/form-data" class="form">
            <label>Файл (${ALLOWED_EXT.join(', ')}, до ${cfg.video.maxMegabytes} МБ)
              <input type="file" name="video" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v" required></label>
            <button class="btn btn--primary">Загрузить</button>
          </form>`
        : !current ? html`<p class="k-note">Загрузка видео ${now < t(c.registrationStart) ? `откроется ${date(c.registrationStart)}` : 'закрыта'}.</p>` : ''}
    </section>`;
  }

  async function cabinet(req, reply, { values, errors, message } = {}) {
    const accountId = req.session.account_id;
    if (!accountId) {
      const login = Object.values(ctx.providers).filter((p) => p.enabled);
      return ctx.page(req, reply, {
        title: 'Кабинет капитана',
        body: html`<section class="k-section narrow"><h1 class="k-h2">Кабинет капитана</h1>
          <p>Войдите, чтобы зарегистрировать компанию или посмотреть статус заявки.</p>
          <div class="k-actions">${login.map((p) => html`<a class="btn btn--primary k-btn-${p.id}" href="/login/${p.id}?next=/my">Войти через ${p.title}</a>`)}</div>
          ${login.length === 0 ? html`<p class="k-note">Вход пока не подключён.</p>` : ''}
        </section>`,
      });
    }

    const now = ctx.now();
    const company = await loadCompany(accountId);
    const regOpen = isRegistrationOpen(c, now);

    if (!company) {
      const body = regOpen
        ? html`<section class="k-section narrow"><h1 class="k-h2">Анкета компании</h1>
            <p>Регистрация открыта до ${dateTime(c.registrationEnd)}. После проверки у компании появится карточка и ссылка для голосования.</p>
            ${companyForm(req, values, errors)}</section>`
        : html`<section class="k-section narrow"><h1 class="k-h2">Кабинет капитана</h1>
            <p>${now < t(c.registrationStart) ? `Регистрация откроется ${date(c.registrationStart)}.` : 'Регистрация закрыта.'}</p></section>`;
      return ctx.page(req, reply, { title: 'Кабинет капитана', body });
    }

    const videos = await loadVideos(company.id);
    const shareUrl = `${cfg.publicUrl}/c/${company.slug}`;
    const body = html`<section class="k-section narrow">
      <h1 class="k-h2">${company.name}</h1>
      ${message ? html`<p class="notice">${message}</p>` : ''}
      ${company.disqualified_at
        ? html`<p class="notice notice--error">Компания дисквалифицирована: ${company.disqualified_reason}</p>`
        : html`<p class="notice${company.status === 'rejected' ? ' notice--error' : ''}">${STATUS_TEXT[company.status]}
            ${company.status === 'rejected' && company.reject_reason ? html` Причина: ${company.reject_reason}` : ''}</p>`}
      ${company.status === 'approved' && !company.disqualified_at
        ? html`<p>Ссылка для голосования — делитесь ею с командой, клиентами и друзьями:</p>
          <p><a class="mono share" href="/c/${company.slug}">${shareUrl}</a></p>
          <p class="k-note">Голосование: ${date(c.votingStart)} – ${date(c.votingEnd)}. До старта кнопка голоса неактивна.</p>`
        : ''}
      ${company.status === 'rejected' && regOpen
        ? html`<h2 class="k-h2">Исправить и отправить заново</h2>${companyForm(req, values || company, errors, 'update')}`
        : ''}
    </section>
    ${company.disqualified_at ? '' : videoSection(req, company, videos)}`;
    return ctx.page(req, reply, { title: 'Кабинет капитана', body });
  }

  app.get('/my', (req, reply) => cabinet(req, reply, { message: req.query.ok === 'video' ? 'Видео загружено.' : null }));

  app.post('/my/company', async (req, reply) => {
    if (!checkCsrf(req, req.body?._csrf)) return reply.code(403).send('Bad CSRF token');
    const accountId = req.session.account_id;
    if (!accountId) return reply.redirect('/my');
    if (!isRegistrationOpen(c, ctx.now())) return cabinet(req, reply);

    const { values, errors } = validateCompany(req.body || {});
    if (Object.keys(errors).length) {
      reply.code(400);
      return cabinet(req, reply, { values, errors });
    }

    const existing = await loadCompany(accountId);
    if (!existing) {
      // Retry on the very unlikely slug collision.
      for (let i = 0; i < 3; i++) {
        try {
          await pool.query(
            `insert into companies (captain_account_id, slug, name, city, story, contact_phone, contact_email)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [accountId, randomSlug(), values.name, values.city, values.story, values.contact_phone, values.contact_email],
          );
          break;
        } catch (err) {
          if (err.code === '23505' && err.constraint === 'companies_slug_key') continue;
          if (err.code === '23505') break; // already registered (double submit)
          throw err;
        }
      }
    } else if (existing.status === 'rejected' && !existing.disqualified_at) {
      await pool.query(
        `update companies set name = $2, city = $3, story = $4, contact_phone = $5, contact_email = $6,
                status = 'pending', reject_reason = null, updated_at = now()
          where id = $1 and status = 'rejected'`,
        [existing.id, values.name, values.city, values.story, values.contact_phone, values.contact_email],
      );
    }
    return reply.redirect('/my');
  });

  app.post('/my/video', async (req, reply) => {
    if (!checkCsrf(req, req.query?._csrf)) return reply.code(403).send('Bad CSRF token');
    const accountId = req.session.account_id;
    if (!accountId) return reply.redirect('/my');
    const company = await loadCompany(accountId);
    if (!company || company.disqualified_at || !isVideoUploadOpen(c, ctx.now())) return reply.redirect('/my');

    const fail = async (text, tmp) => {
      if (tmp) await unlink(tmp).catch(() => {});
      reply.code(400);
      return cabinet(req, reply, { message: text });
    };

    const file = await req.file();
    if (!file) return fail('Выберите файл.');
    const ext = path.extname(file.filename || '').slice(1).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      file.file.resume();
      return fail(`Подходят файлы ${ALLOWED_EXT.join(', ')}.`);
    }

    const tmp = path.join(cfg.videoDir, 'tmp', `${randomToken(12)}.${ext}`);
    await pipeline(file.file, createWriteStream(tmp));
    if (file.file.truncated) return fail(`Файл больше ${cfg.video.maxMegabytes} МБ.`, tmp);

    const info = await probe(cfg.video.ffprobe, tmp);
    if (!info.ok) return fail(info.reason, tmp);
    const tooLong = checkDuration(info.duration, cfg.video);
    if (tooLong) return fail(tooLong, tmp);

    const finalName = `${company.id}-${randomToken(12)}.${ext}`;
    const finalPath = path.join(cfg.videoDir, finalName);
    const { size } = await stat(tmp);
    await rename(tmp, finalPath);
    let inserted = 0;
    try {
      const r = await pool.query(
        `insert into videos (company_id, file_name, mime, size_bytes, duration_sec, status)
         select $1, $2, $3, $4, $5, 'processing'
          where not exists (select 1 from videos where company_id = $1 and status = 'approved')
         returning id`,
        [company.id, finalName, file.mimetype, size, info.duration.toFixed(2)],
      );
      inserted = r.rowCount;
      if (inserted) ctx.transcoder.enqueue(r.rows[0].id);
    } catch (err) {
      if (err.code !== '23505') { await unlink(finalPath).catch(() => {}); throw err; }
    }
    if (!inserted) return fail('Предыдущее видео ещё на проверке или уже принято.', finalPath);
    return reply.redirect('/my?ok=video');
  });
}
