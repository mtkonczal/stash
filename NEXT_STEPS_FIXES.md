# Next Steps: Security Fixes

> **Status 2026-07-09:** Implemented in code. See `DEPLOYMENT_CHECKLIST.md`
> for the remaining dashboard/deploy steps and verification. This doc is
> kept for historical context. Note one correction: the edge functions did
> NOT rely on a user JWT as assumed below — they trusted a client-supplied
> `user_id` while writing with the service-role key, which was itself a
> critical hole (fixed: user_id is now derived server-side from a verified
> JWT, or a secret token for the bookmarklet).

## Context

Supabase flagged `rls_disabled_in_public` on all 5 public tables (`saves`, `folders`, `tags`, `save_tags`, `user_preferences`). On 2026-05-24 we rolled back RLS to restore working state, so the warning is still open. This doc captures the proper fix for when there's time.

## Why RLS broke the app

The repo defines correct RLS policies in `supabase/schema.sql` (lines 97-147, 203-210). They are tied to `auth.uid() = user_id`. But every client (web app, extension, bookmarklet, tts script) talks to Supabase with the **anon key and no authenticated session** — see `web/app.js:30-31` ("Skip auth - go straight to main screen") and `extension/background.js:54` (uses `CONFIG.USER_ID` directly).

With no session, `auth.uid()` returns NULL, every policy returns false, every query fails. That's why enabling RLS broke things.

## Current security posture (after rollback)

The Supabase anon key is embedded in:
- `extension/config.js` (shipped to anyone who installs the Chrome extension)
- `web/app.js` via `web/config.js` (served from the public web app)
- `bookmarklet/install.html`

Anyone who extracts the anon key + project URL can read, write, and delete every row in the database. The "security" today is obscurity — that the URL and key aren't widely known. This is the issue Supabase is flagging.

## The fix: real authentication

A user already exists in Supabase auth (created during initial setup per `SETUP.md` step 3). The signed-in session — not the hardcoded `USER_ID` — is what RLS uses.

### 1. Web app (`web/app.js`)

The `signIn()` function already exists at line 276. The wiring just needs to be flipped:

- Remove "Skip auth" path at `init()` (lines 30-32). Instead, check `supabase.auth.getSession()` on load. If no session, show the auth screen (`#auth-screen` is already in the HTML). If session exists, call `showMainScreen()` + `loadData()`.
- Set `this.user = session.user` instead of `{ id: CONFIG.USER_ID }` (line 5). The hardcoded `CONFIG.USER_ID` can be removed entirely.
- Add `supabase.auth.onAuthStateChange()` to handle sign-in/out transitions.
- Supabase JS client persists the session in localStorage by default, so users only log in once per browser.

### 2. Chrome extension

`extension/supabase.js` already has `signIn`/`signOut`/`getUser` methods (referenced in `background.js:158-173`), and `popup.js` likely has a sign-in UI — check it. To-do:

- On extension install/first use, prompt for email + password via the popup.
- Persist the session token in `chrome.storage.local`.
- In `background.js` save handlers, ensure a valid session exists before calling `supabase.insert(...)`. If the token expired, refresh or re-prompt.
- Replace every `user_id: CONFIG.USER_ID` with the user ID from the session (or just stop sending `user_id` — RLS policies on insert use `auth.uid()` via the `with check` clause, so the DB can fill it via a default or trigger).
- Remove `CONFIG.USER_ID` from `extension/config.js`.

### 3. Bookmarklet (`bookmarklet/`)

Same pattern as the extension. The bookmarklet currently builds the request with the hardcoded user ID — it needs a session token instead. Easiest path: have the bookmarklet POST to a Supabase Edge Function that uses the service-role key (see #4), so the bookmarklet itself never needs auth state. That's a cleaner architecture for a JS snippet running on arbitrary pages.

### 4. TTS script (`tts/tts.py`) and Edge Functions

These are **server-side** — they should use the `service_role` key, not the anon key. The service role bypasses RLS, which is correct for trusted background jobs.

- `tts/tts.py`: switch `STASH_SUPABASE_*` env vars to point to the service-role key. **Never** commit this key. Keep it in `.env` or a local secrets file, gitignored.
- Edge Functions (`save-page`, `save-kindle`, `send-digest`): these already run in a trusted environment. Set `SUPABASE_SERVICE_ROLE_KEY` as a function secret (Supabase dashboard → Edge Functions → Secrets) and use it to create the client. The functions currently rely on the request's auth header being a user JWT — that pattern works fine post-RLS as long as the JWT is forwarded.

⚠️ **Critical:** the service-role key must never appear in any browser-shipped code. Putting it in `extension/config.js` or `web/config.js` would be worse than the current situation.

### 5. Re-enable RLS

After all four clients are authenticating, run:

```sql
alter table public.saves enable row level security;
alter table public.folders enable row level security;
alter table public.tags enable row level security;
alter table public.save_tags enable row level security;
alter table public.user_preferences enable row level security;
```

Policies are already in place (verified 2026-05-24: `saves`/`folders`/`tags` = 4 each, `save_tags`/`user_preferences` = 3 each). No re-creation needed.

### 6. Verify

After re-enabling:

- Web app: load saves list, create a save, edit a tag, change digest settings.
- Extension: save a page, save a highlight.
- Bookmarklet: save a page from a different browser.
- TTS: run a manual job and confirm it writes `audio_url` back to a save.
- Cross-account test: create a second Supabase user, sign in as them in a different browser, confirm they see zero saves from the first account.

## Order of operations recommendation

1. Web app first — easiest to test, fastest feedback loop.
2. Extension second — most user-facing, biggest leak risk if anon key is exposed.
3. Edge Functions + TTS — switch to service-role.
4. Bookmarklet last — lowest usage, can be temporarily disabled if it complicates the rollout.
5. Re-enable RLS only after all four clients work.

## Rollback plan

If re-enabling RLS breaks something, re-run the `disable` block from `2026-05-24`'s rollback (above this doc's creation). No data is lost; only the policy check is toggled.
