// All settings come from environment variables. Secrets never live in the repo.
// Contest dates are Moscow time (UTC+3) and are the single source for the server
// and for the landing page (served via /api/contest).

const env = process.env;

const str = (name, def = '') => (env[name] ?? def).trim();
const num = (name, def) => {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};
const bool = (name, def = false) => {
  const v = env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export function loadConfig(overrides = {}) {
  const production = str('NODE_ENV') === 'production';

  const cfg = {
    production,
    port: num('PORT', 3000),
    host: str('HOST', '0.0.0.0'),
    publicUrl: str('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
    trustProxy: bool('TRUST_PROXY', production),
    databaseUrl: str('DATABASE_URL', 'postgres://konkurs:konkurs@localhost:5432/konkurs'),
    videoDir: str('VIDEO_DIR', './data/videos'),

    contest: {
      title: str('CONTEST_TITLE', 'Битва компаний за салют'),
      registrationStart: str('REGISTRATION_START', '2026-11-11T00:00:00+03:00'),
      registrationEnd: str('REGISTRATION_END', '2026-11-25T23:59:59+03:00'),
      videoUploadEnd: str('VIDEO_UPLOAD_END', '') || str('REGISTRATION_END', '2026-11-25T23:59:59+03:00'),
      votingStart: str('VOTING_START', '2026-11-26T00:00:00+03:00'),
      votingEnd: str('VOTING_END', '2026-12-05T23:59:59+03:00'),
      resultsDate: str('RESULTS_DATE', '2026-12-09T12:00:00+03:00'),
      prizesBy: str('PRIZES_BY', '2026-12-25T23:59:59+03:00'),
      votePoints: num('VOTE_POINTS', 10),
      videoBonus: num('VIDEO_BONUS', 500),
      winners: num('WINNERS', 3),
    },

    video: {
      maxSeconds: num('VIDEO_MAX_SECONDS', 60),
      // Phone recordings of "exactly 60 s" are often 60.0x s in the container.
      toleranceSeconds: num('VIDEO_TOLERANCE_SECONDS', 0.5),
      maxMegabytes: num('VIDEO_MAX_MB', 200),
      ffprobe: str('FFPROBE_PATH', 'ffprobe'),
    },

    // Links to documents approved by the lawyer. Empty = link is hidden.
    docs: {
      rules: str('RULES_URL'),
      privacy: str('PRIVACY_URL'),
      consent: str('CONSENT_URL'),
      consentVersion: str('CONSENT_VERSION', 'draft'),
    },

    phoneHashSecret: str('PHONE_HASH_SECRET') || (production ? '' : 'dev-only-phone-hash-secret'),

    captcha: {
      provider: str('CAPTCHA_PROVIDER', production ? 'smartcaptcha' : 'none'),
      siteKey: str('SMARTCAPTCHA_SITE_KEY'),
      serverKey: str('SMARTCAPTCHA_SERVER_KEY'),
    },

    // Endpoint defaults below must be checked against the VK ID / Sber ID docs
    // in their developer cabinets; every one can be overridden from the env.
    vk: {
      clientId: str('VK_CLIENT_ID'),
      clientSecret: str('VK_CLIENT_SECRET'),
      scope: str('VK_SCOPE', 'phone'),
      authorizeUrl: str('VK_AUTHORIZE_URL', 'https://id.vk.com/authorize'),
      tokenUrl: str('VK_TOKEN_URL', 'https://id.vk.com/oauth2/auth'),
      userInfoUrl: str('VK_USERINFO_URL', 'https://id.vk.com/oauth2/user_info'),
    },
    sber: {
      clientId: str('SBER_CLIENT_ID'),
      clientSecret: str('SBER_CLIENT_SECRET'),
      scope: str('SBER_SCOPE', 'openid mobile'),
      authorizeUrl: str('SBER_AUTHORIZE_URL', 'https://id.sber.ru/CSAFront/oidc/authorize.do'),
      tokenUrl: str('SBER_TOKEN_URL', 'https://oauth.sber.ru/ru/prod/tokens/v2/oidc'),
      userInfoUrl: str('SBER_USERINFO_URL', 'https://oauth.sber.ru/ru/prod/sberbankid/v2.1/userinfo'),
      certP12Path: str('SBER_CERT_P12_PATH'),
      certPassword: str('SBER_CERT_PASSWORD'),
      caPath: str('SBER_CA_PATH'),
    },

    // Fake login for local development and tests. Never available in production.
    devLogin: !production && bool('DEV_LOGIN', false),

    sessionDays: num('SESSION_DAYS', 30),
    ...overrides,
  };

  validate(cfg);
  return cfg;
}

function validate(cfg) {
  for (const key of ['registrationStart', 'registrationEnd', 'videoUploadEnd', 'votingStart', 'votingEnd', 'resultsDate', 'prizesBy']) {
    if (Number.isNaN(new Date(cfg.contest[key]).getTime())) throw new Error(`Bad date in contest.${key}`);
  }
  if (cfg.production) {
    if (!cfg.phoneHashSecret || cfg.phoneHashSecret.length < 32) {
      throw new Error('PHONE_HASH_SECRET must be set (32+ characters) in production');
    }
    if (cfg.captcha.provider !== 'smartcaptcha' || !cfg.captcha.serverKey || !cfg.captcha.siteKey) {
      throw new Error('SmartCaptcha keys are required in production');
    }
    if (cfg.devLogin) throw new Error('DEV_LOGIN is not allowed in production');
  }
}

export const t = (s) => new Date(s);

export function phase(contest, now) {
  if (now < t(contest.registrationStart)) return 'soon';
  if (now <= t(contest.registrationEnd)) return 'register';
  if (now < t(contest.votingStart)) return 'pause';
  if (now <= t(contest.votingEnd)) return 'vote';
  if (now < t(contest.resultsDate)) return 'count';
  return 'done';
}

export const isRegistrationOpen = (c, now) => now >= t(c.registrationStart) && now <= t(c.registrationEnd);
export const isVideoUploadOpen = (c, now) => now >= t(c.registrationStart) && now <= t(c.videoUploadEnd);
export const isVotingOpen = (c, now) => now >= t(c.votingStart) && now <= t(c.votingEnd);
