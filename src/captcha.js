// Yandex SmartCaptcha. In development CAPTCHA_PROVIDER=none skips the check
// (config refuses to start production without real keys).
import { request, form } from './auth/http.js';
import { html } from './html.js';

export function buildCaptcha(cfg) {
  const c = cfg.captcha;
  if (c.provider === 'none') {
    return {
      enabled: false,
      headTag: '',
      widget: () => html`<p class="k-note">Капча отключена (режим разработки).</p>`,
      verify: async () => true,
    };
  }
  return {
    enabled: true,
    headTag: '<script src="https://smartcaptcha.yandexcloud.net/captcha.js" defer></script>',
    widget: () => html`<div class="smart-captcha" data-sitekey="${c.siteKey}" data-hl="ru"></div>`,
    async verify(token, ip) {
      if (!token) return false;
      try {
        const r = await request('https://smartcaptcha.yandexcloud.net/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ secret: c.serverKey, token, ip }),
          timeoutMs: 5000,
        });
        return r.status === 200 && r.json?.status === 'ok';
      } catch {
        return false;
      }
    },
  };
}

export const captchaTokenField = 'smart-token';
