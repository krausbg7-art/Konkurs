import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, Client, AT, company } from './helpers.js';
import { ranking } from '../src/scoring.js';

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });

async function registerCompany(uid, data = {}) {
  const cap = new Client(env.app);
  await cap.login(uid, null);
  const csrf = await cap.csrf('/my');
  const r = await cap.post('/my/company', { _csrf: csrf, ...company(data) });
  assert.equal(r.statusCode, 302);
  const row = (await env.pool.query(
    'select c.* from companies c join accounts a on a.id = c.captain_account_id where a.provider_user_id = $1', [uid])).rows[0];
  return { cap, company: row };
}

test('full contest flow', async (t) => {
  const { app, pool, setTime, cfg } = env;
  setTime(AT.registration);

  // --- captain registers; card is not public until approved
  const { cap, company: co } = await registerCompany('cap-1');
  assert.equal(co.status, 'pending');
  assert.equal((await new Client(app).get(`/c/${co.slug}`)).statusCode, 404);

  // --- organiser approves
  const admin = new Client(app);
  let acsrf = await admin.adminLogin(pool);
  assert.equal((await admin.post(`/admin/companies/${co.id}/approve`, { _csrf: acsrf })).statusCode, 302);
  const card = await new Client(app).get(`/c/${co.slug}`);
  assert.equal(card.statusCode, 200);
  assert.match(card.body, /Ромашка/);

  await t.test('captain contacts are never shown publicly', async () => {
    for (const url of [`/c/${co.slug}`, '/companies']) {
      const body = (await new Client(app).get(url)).body;
      assert.doesNotMatch(body, /cap@example\.ru/);
      assert.doesNotMatch(body, /900/);
    }
    assert.match((await admin.get(`/admin/companies/${co.id}`)).body, /cap@example\.ru/);
  });

  await t.test('vote button is disabled before voting starts and votes are refused', async () => {
    const voter = new Client(app);
    await voter.login('early', '+79990000001', `/c/${co.slug}`);
    const page = await voter.get(`/c/${co.slug}`);
    assert.match(page.body, /disabled aria-disabled="true">Проголосовать/);
    const csrf = await voter.csrf('/my');
    const r = await voter.post(`/c/${co.slug}/vote`, { _csrf: csrf });
    assert.match(r.body, /Голосование закрыто/);
    assert.equal((await pool.query('select count(*)::int n from votes')).rows[0].n, 0);
  });

  await t.test('video: fake and too-long files are rejected, a short one goes to moderation', async () => {
    assert.match((await cap.uploadVideo('fake.mp4')).body, /не распознан как видео/);
    assert.match((await cap.uploadVideo('long.mp4')).body, /можно не больше 60/);
    const ok = await cap.uploadVideo('short.mp4');
    assert.equal(ok.headers.location, '/my?ok=video');
    assert.match((await cap.uploadVideo('short.mp4')).body, /ещё на проверке/);
    await app.transcoder.idle();
    const vids = (await pool.query('select * from videos')).rows;
    assert.equal(vids.length, 1);
    assert.equal(vids[0].status, 'pending');
    // Pending video is not public, but the captain can watch it.
    assert.equal((await new Client(app).get(`/media/video/${vids[0].id}`)).statusCode, 404);
    assert.equal((await cap.get(`/media/video/${vids[0].id}`)).statusCode, 200);
  });

  await t.test('approved video gives the bonus once', async () => {
    const vid = (await pool.query('select id from videos')).rows[0];
    acsrf = await admin.csrf('/admin/videos');
    await admin.post(`/admin/videos/${vid.id}/approve`, { _csrf: acsrf });
    const rows = await ranking(pool, cfg.contest);
    assert.equal(rows[0].score, 500);
    // Uploading another video is no longer possible.
    const r = await cap.uploadVideo('short.mp4');
    assert.equal((await pool.query('select count(*)::int n from videos')).rows[0].n, 1);
    assert.notEqual(r.headers.location, '/my?ok=video');
  });

  // --- voting
  setTime(AT.voting);
  const v1 = new Client(app);
  await v1.login('voter-1', '+7 (999) 123-45-67', `/c/${co.slug}`);

  await t.test('a vote is accepted once and logged with time and source', async () => {
    await v1.get(`/c/${co.slug}?utm_source=telegram&utm_campaign=team`, { referer: 'https://t.me/somechat' });
    const csrf = await v1.csrf(`/c/${co.slug}`);
    const r = await v1.post(`/c/${co.slug}/vote`, { _csrf: csrf });
    assert.match(r.body, /голос принят/);
    const vote = (await pool.query('select * from votes')).rows[0];
    assert.equal(vote.status, 'valid');
    assert.deepEqual(vote.utm, { utm_source: 'telegram', utm_campaign: 'team' });
    assert.equal(vote.referer, 'https://t.me/somechat');
    assert.ok(vote.created_at instanceof Date);
    assert.ok(vote.ip);

    const again = await v1.post(`/c/${co.slug}/vote`, { _csrf: csrf });
    assert.match(again.body, /уже голосовали/);
    assert.match((await v1.get(`/c/${co.slug}`)).body, /Вы уже проголосовали/);
  });

  await t.test('same phone through another provider account cannot vote again', async () => {
    const v1b = new Client(app);
    await v1b.login('voter-1-other-account', '89991234567', `/c/${co.slug}`); // same number, other format
    assert.match((await v1b.get(`/c/${co.slug}`)).body, /Вы уже проголосовали/);
    const csrf = await v1b.csrf('/my');
    const r = await v1b.post(`/c/${co.slug}/vote`, { _csrf: csrf });
    assert.match(r.body, /уже голосовали/);
    assert.equal((await pool.query('select count(*)::int n from votes')).rows[0].n, 1);
  });

  await t.test('account without a confirmed phone cannot vote', async () => {
    const v = new Client(app);
    await v.login('no-phone', null, `/c/${co.slug}`);
    const csrf = await v.csrf(`/c/${co.slug}`);
    const r = await v.post(`/c/${co.slug}/vote`, { _csrf: csrf });
    assert.match(r.body, /Нужен подтверждённый телефон/);
  });

  await t.test('one vote in total: cannot vote for a second company', async () => {
    // Registration is closed during voting, so create the second company directly.
    const acc = (await pool.query(`insert into accounts (provider, provider_user_id, consent_at, consent_version)
      values ('dev', 'cap-2b', now(), 't') returning id`)).rows[0];
    const c2 = (await pool.query(`insert into companies (captain_account_id, slug, name, city, story, contact_phone, contact_email, status)
      values ($1, 'second', 'Лютик', 'Омск', 'История второй компании для теста', '+79000000000', 'b@b.ru', 'approved') returning id`, [acc.id])).rows[0];
    const csrf = await v1.csrf('/c/second');
    const r = await v1.post('/c/second/vote', { _csrf: csrf });
    assert.match(r.body, /уже голосовали/);
    assert.ok(c2.id);
  });

  await t.test('vote without CSRF token is refused', async () => {
    const v = new Client(app);
    await v.login('csrf-less', '+79990000077', `/c/${co.slug}`);
    const r = await v.post(`/c/${co.slug}/vote`, {});
    assert.equal(r.statusCode, 403);
  });

  await t.test('annulled votes stop counting; restore brings them back', async () => {
    const before = (await ranking(pool, cfg.contest)).find((r) => r.id === co.id);
    assert.equal(before.score, 510);
    const vote = (await pool.query('select id from votes')).rows[0];
    acsrf = await admin.csrf('/admin/votes');
    await admin.post('/admin/votes/annul', { _csrf: acsrf, ids: String(vote.id), reason: 'Проверка', action: 'annul' });
    assert.equal((await ranking(pool, cfg.contest)).find((r) => r.id === co.id).score, 500);
    await admin.post('/admin/votes/annul', { _csrf: acsrf, ids: String(vote.id), action: 'restore' });
    assert.equal((await ranking(pool, cfg.contest)).find((r) => r.id === co.id).score, 510);
    const log = (await pool.query("select action from admin_log where action like 'votes.%' order by id")).rows.map((r) => r.action);
    assert.deepEqual(log, ['votes.annul', 'votes.restore']);
  });

  await t.test('votes are refused after the last second of voting', async () => {
    setTime(AT.afterVoting);
    const v = new Client(app);
    await v.login('late', '+79990000099', `/c/${co.slug}`);
    const csrf = await v.csrf('/my');
    const r = await v.post(`/c/${co.slug}/vote`, { _csrf: csrf });
    assert.match(r.body, /Голосование закрыто/);
    setTime(AT.voting);
  });

  await t.test('disqualified company leaves the rating and cannot get votes', async () => {
    acsrf = await admin.csrf(`/admin/companies/${co.id}`);
    await admin.post(`/admin/companies/${co.id}/disqualify`, { _csrf: acsrf, reason: 'Накрутка' });
    assert.equal((await ranking(pool, cfg.contest)).find((r) => r.id === co.id), undefined);
    const v = new Client(app);
    await v.login('after-dq', '+79990000055', `/c/${co.slug}`);
    const csrf = await v.csrf('/my');
    const r = await v.post(`/c/${co.slug}/vote`, { _csrf: csrf });
    assert.equal(r.statusCode, 404);
    await admin.post(`/admin/companies/${co.id}/reinstate`, { _csrf: acsrf });
  });

  await t.test('results page is hidden until the organiser publishes it', async () => {
    assert.match((await new Client(app).get('/results')).body, /будут опубликованы/);
    acsrf = await admin.csrf('/admin/results');
    await admin.post('/admin/results/publish', { _csrf: acsrf, value: 'yes' });
    const body = (await new Client(app).get('/results')).body;
    assert.match(body, /Итоги конкурса/);
    assert.match(body, /Ромашка/);
  });

  await t.test('admin pages require login', async () => {
    const anon = new Client(app);
    for (const url of ['/admin', '/admin/votes', '/admin/votes.csv', '/admin/companies/1']) {
      const r = await anon.get(url);
      assert.equal(r.statusCode, 302, url);
      assert.equal(r.headers.location, '/admin/login');
    }
  });
});

test('registration window and rejection with reason', async () => {
  const { app, pool, setTime } = env;
  setTime(AT.beforeRegistration);
  const cap = new Client(app);
  await cap.login('cap-early', null);
  assert.match((await cap.get('/my')).body, /Регистрация откроется/);

  setTime(AT.registration);
  const csrf = await cap.csrf('/my');
  const bad = await cap.post('/my/company', { _csrf: csrf, ...company({ contact_email: 'nope', story: 'short' }) });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /Укажите e-mail/);
  assert.match(bad.body, /Минимум 20 символов/);

  await cap.post('/my/company', { _csrf: csrf, ...company({ name: 'Ранние' }) });
  const co = (await pool.query("select * from companies where name = 'Ранние'")).rows[0];

  const admin = new Client(app);
  const acsrf = await admin.adminLogin(pool);
  await admin.post(`/admin/companies/${co.id}/reject`, { _csrf: acsrf, reason: 'Нет описания деятельности' });
  const page = (await cap.get('/my')).body;
  assert.match(page, /Нет описания деятельности/);
  assert.match(page, /Отправить заново/);

  // Captain fixes and resubmits → back to pending.
  const csrf2 = await cap.csrf('/my');
  await cap.post('/my/company', { _csrf: csrf2, ...company({ name: 'Ранние', story: 'Теперь с подробным описанием деятельности компании.' }) });
  const after = (await pool.query('select status, reject_reason from companies where id = $1', [co.id])).rows[0];
  assert.deepEqual(after, { status: 'pending', reject_reason: null });

  // After registration closes the form is gone.
  setTime(AT.pause);
  const late = new Client(app);
  await late.login('cap-late', null);
  assert.match((await late.get('/my')).body, /Регистрация закрыта/);
});

test('tie-break: the company that reached its total earlier ranks higher', async () => {
  const { pool, cfg } = env;
  await pool.query('delete from votes; delete from videos; delete from companies; delete from sessions; delete from accounts;');
  const mk = async (slug) => {
    const a = (await pool.query(`insert into accounts (provider, provider_user_id, consent_at, consent_version)
      values ('dev', $1, now(), 't') returning id`, [`c-${slug}`])).rows[0];
    return (await pool.query(`insert into companies (captain_account_id, slug, name, city, story, contact_phone, contact_email, status)
      values ($1, $2, $2, 'X', 'story story story story', '+70000000000', 'a@a.ru', 'approved') returning id`, [a.id, slug])).rows[0].id;
  };
  const A = await mk('aaa'), B = await mk('bbb'), C = await mk('ccc');
  let n = 0;
  const vote = async (company, at) => {
    n += 1;
    const a = (await pool.query(`insert into accounts (provider, provider_user_id, phone_hash, consent_at, consent_version)
      values ('dev', $1, $1, now(), 't') returning id`, [`v${n}`])).rows[0];
    await pool.query(`insert into votes (company_id, account_id, phone_hash, provider, captcha_ok, created_at)
      values ($1, $2, $3, 'dev', true, $4)`, [company, a.id, `v${n}`, at]);
  };
  // B and C both end with 2 votes; C got its 2nd vote earlier → C ranks above B.
  await vote(B, '2026-11-26T10:00:00+03:00');
  await vote(B, '2026-11-28T10:00:00+03:00');
  await vote(C, '2026-11-26T11:00:00+03:00');
  await vote(C, '2026-11-27T10:00:00+03:00');
  await vote(A, '2026-11-26T09:00:00+03:00');
  let rows = await ranking(pool, cfg.contest);
  assert.deepEqual(rows.map((r) => r.slug), ['ccc', 'bbb', 'aaa']);
  assert.deepEqual(rows.map((r) => r.place), [1, 2, 3]);
  assert.ok(rows.every((r) => !r.unresolvedTie));

  // Exact same moment, down to the microsecond → flagged, not decided by lottery.
  const lastVote = `(select id from votes where company_id = $1 order by created_at desc limit 1)`;
  for (const id of [B, C]) {
    await pool.query(`update votes set created_at = '2026-11-28T10:00:00.123456+03:00' where id = ${lastVote}`, [id]);
  }
  rows = await ranking(pool, cfg.contest);
  const b = rows.find((r) => r.slug === 'bbb'), c = rows.find((r) => r.slug === 'ccc');
  assert.equal(b.place, c.place);
  assert.ok(b.unresolvedTie && c.unresolvedTie);

  // 1 microsecond later is enough to separate them.
  await pool.query(`update votes set created_at = '2026-11-28T10:00:00.123457+03:00' where id = ${lastVote}`, [B]);
  rows = await ranking(pool, cfg.contest);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.slug), ['ccc', 'bbb']);
});

test('iPhone video (HEVC, HDR, 60 fps, rotated, with GPS) is converted for every browser', async () => {
  const { app, pool, setTime, cfg } = env;
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const { existsSync, readdirSync } = await import('node:fs');
  setTime(AT.registration);

  const { cap } = await registerCompany('cap-iphone', { name: 'Айфон' });
  const r = await cap.uploadVideo('iphone.mov');
  assert.equal(r.headers.location, '/my?ok=video');

  const before = (await pool.query("select v.* from videos v join companies c on c.id = v.company_id where c.name = 'Айфон'")).rows[0];
  assert.equal(before.status, 'processing');
  assert.match((await cap.get('/my')).body, /обрабатывается/);

  await app.transcoder.idle();
  const v = (await pool.query('select * from videos where id = $1', [before.id])).rows[0];
  assert.equal(v.status, 'pending', v.processing_error);
  assert.equal(v.mime, 'video/mp4');
  assert.match(v.file_name, /\.mp4$/);
  assert.ok(Math.abs(v.duration_sec - 3) < 0.2);
  // original .mov is removed, the temp folder is clean
  assert.ok(!existsSync(path.join(cfg.videoDir, before.file_name)));
  assert.deepEqual(readdirSync(path.join(cfg.videoDir, 'tmp')), []);

  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name,pix_fmt,width,height,avg_frame_rate,color_transfer:stream_side_data=rotation:format_tags',
    '-of', 'json', path.join(cfg.videoDir, v.file_name)]).toString());
  const video = out.streams.find((s) => s.codec_name === 'h264');
  assert.ok(video, 'H.264 stream');
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal(video.color_transfer, 'bt709');
  assert.ok(video.height > video.width, 'portrait after applying rotation');
  assert.equal(eval(video.avg_frame_rate), 30);
  assert.ok(!video.side_data_list, 'no rotation flag left');
  assert.ok(out.streams.some((s) => s.codec_name === 'aac'), 'audio kept');
  assert.equal(out.format.tags?.location, undefined, 'GPS location removed');

  // moov atom at the start: playback starts before the whole file is downloaded
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path.join(cfg.videoDir, v.file_name));
  const moov = bytes.indexOf('moov'), mdat = bytes.indexOf('mdat');
  assert.ok(moov > 0 && mdat > 0 && moov < mdat, `moov ${moov} before mdat ${mdat}`);
  assert.equal((await cap.get(`/media/video/${v.id}`)).headers['content-type'], 'video/mp4');
});

test('failed conversion is reported and a new upload is allowed', async () => {
  const { app, pool, setTime, cfg } = env;
  setTime(AT.registration);
  const { cap, company: co } = await registerCompany('cap-broken', { name: 'Сломанный' });
  const ffmpeg = cfg.video.ffmpeg;
  cfg.video.ffmpeg = '/nonexistent/ffmpeg';
  try {
    await cap.uploadVideo('short.mp4');
    await app.transcoder.idle();
  } finally {
    cfg.video.ffmpeg = ffmpeg;
  }
  const v = (await pool.query('select * from videos where company_id = $1', [co.id])).rows[0];
  assert.equal(v.status, 'failed');
  assert.ok(v.processing_error);
  const page = (await cap.get('/my')).body;
  assert.match(page, /Не получилось обработать/);
  assert.match(page, /name="video"/); // upload form is back
  const r = await cap.uploadVideo('short.mp4');
  assert.equal(r.headers.location, '/my?ok=video');
  await app.transcoder.idle();
  assert.equal((await pool.query("select count(*)::int n from videos where company_id = $1 and status = 'pending'", [co.id])).rows[0].n, 1);
});
