-- Two tables: runtime switches, and the shopper's encrypted Día details.
--
-- `config` holds flags the operator flips without a redeploy. It starts with
-- the checkout sandbox's mock, which used to be SANDBOX_MOCK / SANDBOX_MOCK_FAIL
-- in the environment: changing an env var on Vercel means a redeploy, and a
-- demo needs the mock on and off in seconds. The table is now the only source
-- (apps/web/lib/config.ts); a missing row reads as off. Seeded off, which is
-- what production did without SANDBOX_MOCK. Flip it with `npm run config`.
--
-- `profile` keeps what the checkout sandbox needs to buy in the shopper's own
-- Día account: email, password, DNI, postcode. `secret` is an AES-256-GCM
-- envelope made by the web server (apps/web/lib/profile-crypto.ts) with
-- PROFILE_ENC_KEY, which never reaches this database; the envelope is bound to
-- `network|address`, so a row copied onto another wallet does not decrypt.
-- Nothing here is readable without the key, and the key is not here.
--
-- Same guard as 0001 and 0007: RLS on, no policies. The server connects as the
-- table owner; the anon and authenticated roles read and write nothing.

create table config (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

insert into config (key, value) values
  ('sandbox_mock',      'false'::jsonb),
  ('sandbox_mock_fail', 'false'::jsonb);

create table profile (
  network    network_id     not null,
  address    wallet_address not null,
  secret     jsonb          not null,
  created_at timestamptz    not null default now(),
  updated_at timestamptz    not null default now(),
  primary key (network, address)
);

create trigger config_touch  before update on config
  for each row execute function touch_updated_at();
create trigger profile_touch before update on profile
  for each row execute function touch_updated_at();

alter table config  enable row level security;
alter table profile enable row level security;
