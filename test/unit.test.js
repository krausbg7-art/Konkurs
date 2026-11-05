import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, phoneHash, safeNext, hashPassword, verifyPassword } from '../src/security.js';
import { validateCompany } from '../src/routes/captain.js';
import { phase } from '../src/config.js';
import { html, raw, exactTime } from '../src/html.js';
import { checkDuration } from '../src/video.js';

test('phone normalisation: VK and Sber formats of one number give one hash', () => {
  const forms = ['+7 (999) 123-45-67', '79991234567', '89991234567', '9991234567'];
  assert.ok(forms.every((f) => normalizePhone(f) === '79991234567'));
  const hashes = new Set(forms.map((f) => phoneHash(f, 'secret')));
  assert.equal(hashes.size, 1);
  assert.notEqual(phoneHash('79991234567', 'secret'), phoneHash('79991234567', 'other'));
  assert.equal(normalizePhone('123'), null);
});

test('only local redirects after login', () => {
  assert.equal(safeNext('/c/abc'), '/c/abc');
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext('https://evil.com'), '/');
  assert.equal(safeNext('/\\evil.com'), '/');
});

test('passwords', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.ok(!(await verifyPassword('wrong', h)));
});

test('company form validation', () => {
  const ok = validateCompany({ name: 'Ромашка', city: 'Казань', story: 'x'.repeat(30), contact_phone: '8 900 111 22 33', contact_email: 'a@b.ru', publish_consent: 'yes' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.contact_phone, '+79001112233');
  const bad = validateCompany({ name: 'R', story: 'x'.repeat(2000) });
  assert.ok(bad.errors.name && bad.errors.city && bad.errors.story && bad.errors.contact_phone && bad.errors.contact_email && bad.errors.publish_consent);
});

test('contest phases follow Moscow time boundaries', () => {
  const c = {
    registrationStart: '2026-11-11T00:00:00+03:00', registrationEnd: '2026-11-25T23:59:59+03:00',
    votingStart: '2026-11-26T00:00:00+03:00', votingEnd: '2026-12-05T23:59:59+03:00', resultsDate: '2026-12-09T12:00:00+03:00',
  };
  assert.equal(phase(c, new Date('2026-11-10T20:59:59Z')), 'soon');
  assert.equal(phase(c, new Date('2026-11-10T21:00:00Z')), 'register');
  assert.equal(phase(c, new Date('2026-11-25T21:00:00Z')), 'vote');
  assert.equal(phase(c, new Date('2026-12-05T20:59:59Z')), 'vote');
  assert.equal(phase(c, new Date('2026-12-05T21:00:00Z')), 'count');
});

test('html escapes by default', () => {
  assert.equal(html`<p>${'<script>"x"</script>'}</p>`.toString(), '<p>&lt;script&gt;&quot;x&quot;&lt;/script&gt;</p>');
  assert.equal(html`<p>${raw('<b>ok</b>')}</p>`.toString(), '<p><b>ok</b></p>');
  assert.equal(exactTime('2026-11-26T09:00:00.123Z'), '26.11.2026, 12:00:00.123');
});

test('video duration limit', () => {
  const lim = { maxSeconds: 60, toleranceSeconds: 0.5 };
  assert.equal(checkDuration(60.4, lim), null);
  assert.match(checkDuration(61, lim), /не больше 60/);
});
