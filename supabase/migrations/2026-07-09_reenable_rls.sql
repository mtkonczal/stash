-- Re-enable Row Level Security + policy hardening
-- Run in the Supabase SQL Editor AFTER all clients authenticate
-- (see DEPLOYMENT_CHECKLIST.md for the full order of operations).
--
-- Policies already exist on the live DB (verified 2026-05-24:
-- saves/folders/tags = 4 each, save_tags/user_preferences = 3 each),
-- so this only flips RLS back on and fixes one policy gap.

-- 1. Re-enable RLS (this is what Supabase's rls_disabled_in_public flags)
alter table public.saves enable row level security;
alter table public.folders enable row level security;
alter table public.tags enable row level security;
alter table public.save_tags enable row level security;
alter table public.user_preferences enable row level security;

-- 2. Policy gap fix: the original save_tags insert policy only checked
-- ownership of the SAVE, so a user could attach another user's tag to
-- their own save (cross-tenant reference). Require owning both sides.
drop policy if exists "Users can insert own save_tags" on public.save_tags;
create policy "Users can insert own save_tags" on public.save_tags
  for insert with check (
    exists (select 1 from saves where saves.id = save_id and saves.user_id = auth.uid())
    and
    exists (select 1 from tags  where tags.id  = tag_id  and tags.user_id  = auth.uid())
  );

-- 3. Defense in depth: default user_id to the JWT's subject so clients
-- don't strictly need to send it (and can't get it wrong).
alter table public.saves            alter column user_id set default auth.uid();
alter table public.folders          alter column user_id set default auth.uid();
alter table public.tags             alter column user_id set default auth.uid();
alter table public.user_preferences alter column user_id set default auth.uid();

-- Verification queries (expect rowsecurity = true for all five):
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public'
--     and tablename in ('saves','folders','tags','save_tags','user_preferences');
--
-- Cross-account test: create a second auth user, sign in as them in a
-- separate browser profile, confirm they see zero rows.

-- ROLLBACK (if something breaks; no data is lost, only the check toggles):
--   alter table public.saves            disable row level security;
--   alter table public.folders          disable row level security;
--   alter table public.tags             disable row level security;
--   alter table public.save_tags       disable row level security;
--   alter table public.user_preferences disable row level security;
