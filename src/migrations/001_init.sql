-- Contest schema. All timestamps are timestamptz; pages show them in Europe/Moscow.

create table admins (
  id            bigserial primary key,
  login         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- One row per external account (VK ID or Sber ID). No names, no photos.
create table accounts (
  id               bigserial primary key,
  provider         text not null check (provider in ('vk', 'sber', 'dev')),
  provider_user_id text not null,
  -- HMAC of the confirmed phone from the provider; the number itself is not stored.
  phone_hash       text,
  consent_at       timestamptz not null,
  consent_version  text not null,
  consent_ip       inet,
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz not null default now(),
  unique (provider, provider_user_id)
);
create index accounts_phone_hash on accounts (phone_hash);

create table sessions (
  id          text primary key,
  account_id  bigint references accounts (id) on delete cascade,
  admin_id    bigint references admins (id) on delete cascade,
  csrf        text not null,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_expires on sessions (expires_at);

create table companies (
  id                  bigserial primary key,
  captain_account_id  bigint not null unique references accounts (id),
  slug                text not null unique,
  name                text not null,
  city                text not null,
  story               text not null,
  -- Captain contacts: visible to the organiser only.
  contact_phone       text not null,
  contact_email       text not null,
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason       text,
  moderated_at        timestamptz,
  moderated_by        bigint references admins (id),
  disqualified_at     timestamptz,
  disqualified_reason text,
  disqualified_by     bigint references admins (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table videos (
  id            bigserial primary key,
  company_id    bigint not null references companies (id) on delete cascade,
  file_name     text not null,
  mime          text,
  size_bytes    bigint not null,
  duration_sec  numeric(7, 2) not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'replaced')),
  reject_reason text,
  uploaded_at   timestamptz not null default now(),
  moderated_at  timestamptz,
  moderated_by  bigint references admins (id)
);
-- The 500-point bonus is given once: at most one approved video per company.
create unique index videos_one_approved on videos (company_id) where status = 'approved';
create unique index videos_one_pending  on videos (company_id) where status = 'pending';

-- One vote per person for the whole contest:
-- one per account, and one per confirmed phone (links VK ID and Sber ID of the same person).
-- Annulled votes keep their row, so the same person cannot vote again.
create table votes (
  id            bigserial primary key,
  company_id    bigint not null references companies (id),
  account_id    bigint not null unique references accounts (id),
  phone_hash    text not null unique,
  provider      text not null,
  -- clock_timestamp(): real time of the insert, used for tie-breaks.
  created_at    timestamptz not null default clock_timestamp(),
  ip            inet,
  user_agent    text,
  referer       text,
  utm           jsonb,
  captcha_ok    boolean not null,
  status        text not null default 'valid' check (status in ('valid', 'annulled')),
  annul_reason  text,
  annulled_at   timestamptz,
  annulled_by   bigint references admins (id)
);
create index votes_company on votes (company_id, status, created_at);
create index votes_ip on votes (ip);

create table admin_log (
  id          bigserial primary key,
  admin_id    bigint references admins (id),
  action      text not null,
  target_type text,
  target_id   bigint,
  details     jsonb,
  created_at  timestamptz not null default now()
);

create table settings (
  key   text primary key,
  value jsonb not null
);
