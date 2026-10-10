-- The guard 0001 put on every table, for the three that came later.
--
-- 0006 created `kv` and `quota` without it, and `schema_migrations` is created
-- by scripts/db.mjs rather than by a migration, so all three were readable and
-- writable through Supabase's Data API with the anon key. That is not
-- hypothetical exposure: `kv` holds in-flight conversations (what somebody is
-- buying, usually their postal code) and checkout records, and anyone able to
-- write `quota` can reset the chat and faucet limits.
--
-- Same shape as 0001: RLS on, no policies. The server connects as the table
-- owner, which bypasses RLS, so nothing the app does changes; the anon and
-- authenticated roles now read and write nothing.
--
-- `if exists` on the ledger only because a database migrated by some other
-- route may not have it; db.mjs always creates it before applying this file.

alter table kv    enable row level security;
alter table quota enable row level security;

do $$
begin
  if to_regclass('public.schema_migrations') is not null then
    execute 'alter table schema_migrations enable row level security';
  end if;
end $$;
