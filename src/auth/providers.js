// Login providers share one interface:
//   enabled                       — keys are configured
//   authorizeUrl({ state, challenge, nonce, redirectUri }) → URL to send the browser to
//   complete({ query, verifier, nonce, redirectUri })      → { providerUserId, phone }
// Adding a provider = adding one object here.
//
// Endpoint URLs and response field names follow the public VK ID / Sber ID docs as we
// know them; they could not be re-checked from the build environment, so every URL is
// overridable from env (see .env.example) and must be verified in the developer cabinets.

import crypto from 'node:crypto';
import { request, form, makeAgent } from './http.js';

class ProviderError extends Error {}

function vkProvider(c) {
  return {
    id: 'vk',
    title: 'VK ID',
    enabled: Boolean(c.clientId),
    authorizeUrl({ state, challenge, redirectUri }) {
      const u = new URL(c.authorizeUrl);
      u.search = form({
        response_type: 'code',
        client_id: c.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: c.scope,
      });
      return u.toString();
    },
    async complete({ query, verifier, redirectUri, state }) {
      if (!query.code) throw new ProviderError('VK ID не вернул код авторизации');
      const tok = await request(c.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: 'authorization_code',
          code: query.code,
          code_verifier: verifier,
          client_id: c.clientId,
          device_id: query.device_id,
          redirect_uri: redirectUri,
          state,
        }),
      });
      const accessToken = tok.json?.access_token;
      if (!accessToken) throw new ProviderError(`VK ID token error: ${tok.status} ${tok.json?.error || ''}`);

      const info = await request(c.userInfoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: c.clientId, access_token: accessToken }),
      });
      const user = info.json?.user;
      const id = user?.user_id ?? tok.json?.user_id;
      if (!id) throw new ProviderError(`VK ID user_info error: ${info.status}`);
      return { providerUserId: String(id), phone: user?.phone || null };
    },
  };
}

function sberProvider(c) {
  let agent;
  const getAgent = () => (agent ??= makeAgent({ p12Path: c.certP12Path, password: c.certPassword, caPath: c.caPath }));
  const rquid = () => crypto.randomUUID().replace(/-/g, '');

  return {
    id: 'sber',
    title: 'Сбер ID',
    enabled: Boolean(c.clientId && c.clientSecret && c.certP12Path),
    authorizeUrl({ state, challenge, nonce, redirectUri }) {
      const u = new URL(c.authorizeUrl);
      u.search = form({
        response_type: 'code',
        client_id: c.clientId,
        redirect_uri: redirectUri,
        scope: c.scope,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return u.toString();
    },
    async complete({ query, verifier, redirectUri }) {
      if (!query.code) throw new ProviderError('Сбер ID не вернул код авторизации');
      const tok = await request(c.tokenUrl, {
        method: 'POST',
        agent: getAgent(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          rquid: rquid(),
        },
        body: form({
          grant_type: 'authorization_code',
          code: query.code,
          client_id: c.clientId,
          client_secret: c.clientSecret,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      });
      const accessToken = tok.json?.access_token;
      if (!accessToken) throw new ProviderError(`Sber ID token error: ${tok.status} ${tok.json?.error || ''}`);

      const info = await request(c.userInfoUrl, {
        method: 'GET',
        agent: getAgent(),
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          'x-introspect-rquid': rquid(),
          'x-ibm-client-id': c.clientId,
        },
      });
      const sub = info.json?.sub;
      if (!sub) throw new ProviderError(`Sber ID userinfo error: ${info.status}`);
      return { providerUserId: String(sub), phone: info.json.phone_number || null };
    },
  };
}

// Local development and tests only: a form where you type a fake id and phone.
function devProvider() {
  return {
    id: 'dev',
    title: 'Тестовый вход',
    enabled: true,
    authorizeUrl({ state }) {
      return `/auth/dev/form?state=${encodeURIComponent(state)}`;
    },
    async complete({ query }) {
      if (!query.uid) throw new ProviderError('uid required');
      return { providerUserId: String(query.uid), phone: query.phone || null };
    },
  };
}

export function buildProviders(cfg) {
  const list = [vkProvider(cfg.vk), sberProvider(cfg.sber)];
  if (cfg.devLogin) list.push(devProvider());
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

export { ProviderError };
