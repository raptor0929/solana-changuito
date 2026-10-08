-- Redis is gone. What it held moves here, at the same lifetimes.
--
-- Three things lived in Upstash: the agent's in-flight turn (1h), the checkout
-- record between quote and settle (24h), and the chat and faucet quotas. All
-- three are small, keyed by a string and expire on their own, so two tables
-- cover them: `kv` for documents and `quota` for counters. Expiry is a column
-- rather than a TTL, and `expires_at > now()` is part of every read, so a row
-- past its time is invisible before anything deletes it. lib/kv.ts sweeps the
-- dead rows opportunistically on writes; nothing depends on the sweep.
--
-- `quota.n` is bumped in one upsert that also restarts the window when the old
-- one has lapsed, which is the atomicity the Redis INCR + EXPIRE pair gave.

create table kv (
  key        text        primary key,
  value      jsonb       not null,
  expires_at timestamptz not null
);

create index kv_expires_at on kv (expires_at);

create table quota (
  key        text        primary key,
  n          integer     not null,
  expires_at timestamptz not null
);

create index quota_expires_at on quota (expires_at);
