# Deployment Checklist: Security Fix (2026-07-09)

This covers **one thing**: deploying the security fix now sitting in the
repo (uncommitted as of this writing). The code side is done; these are
the dashboard and deploy steps only you can do. Do them **in order** —
nothing breaks until step 5, and each step is independently reversible.

The fix, in one paragraph: every client now authenticates (the web app and
extension via email OTP login, the bookmarklet via a secret token, TTS via
the service-role key), the edge functions verify their callers instead of
trusting a client-supplied `user_id` while writing with the service-role
key, stored-XSS holes in the reading pane / popup / digest emails are
closed, and — the step Supabase has been flagging — RLS gets re-enabled
on all five tables. Hardcoded `USER_ID` values are gone from all configs.

## 1. Supabase dashboard: secrets and auth settings

**Edge Function secrets** (Dashboard → Edge Functions → Secrets):

```bash
# Generate two tokens locally:
openssl rand -hex 32   # STASH_BOOKMARKLET_TOKEN
openssl rand -hex 32   # CRON_SECRET
```

| Secret | Value |
|---|---|
| `STASH_BOOKMARKLET_TOKEN` | first token above |
| `STASH_BOOKMARKLET_USER_ID` | your auth user id (Authentication → Users) |
| `CRON_SECRET` | second token above |
| `RESEND_API_KEY` | already set if digests work today |

(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected; nothing to do.)

**Auth settings** (Dashboard → Authentication) — login is now email OTP,
single user:

- Sign In / Up → **turn OFF "Allow new users to sign up"**. This is the
  server-side lock. The clients also send `shouldCreateUser: false`, but
  the toggle is what guarantees no one else can register.
- Email Templates → "Magic Link" → body must include **`{{ .Token }}`**
  (e.g. "Your login code is {{ .Token }}"). The default template only has
  a link; the login form asks for the code, which is `{{ .Token }}`.
- Optional: shorten Email OTP expiry (default 3600s; 300–600s is plenty).
- Optional: set your account password to a long random string
  (Authentication → Users → reset password). No UI uses passwords anymore,
  so this neutralizes the unused password grant.

## 2. Deploy the edge functions

```bash
supabase functions deploy save-page --no-verify-jwt
supabase functions deploy save-kindle
supabase functions deploy send-digest --no-verify-jwt
```

`--no-verify-jwt` is required on `save-page` (bookmarklet authenticates
with `X-Stash-Token`, not a JWT) and `send-digest` (cron secret instead of
a JWT); both do their own auth in-function and return 401 otherwise.
`save-kindle` keeps gateway JWT verification on top of its in-function check.

If a cron job triggers `send-digest`, update it to send the header
`X-Cron-Secret: <CRON_SECRET>`.

## 3. Deploy the clients

- **Web app**: push `web/` to Vercel. Sign in (email → one-time code from
  your inbox) and confirm the saves list loads. The session persists in
  localStorage, so this is roughly a one-time login per browser.
- **Extension**: reload the unpacked extension; rebuild `stash.xpi` for
  Firefox (the current xpi predates the fix). The popup now shows the
  send-code / enter-code form. Sign in once; the session lives in
  `chrome.storage.local` and auto-refreshes.
- **Bookmarklet**: open `bookmarklet/install.html` (or `/bookmarklet.html`
  on the web app), paste `STASH_BOOKMARKLET_TOKEN`, drag the new button to
  the bookmarks bar, and delete the old one — it stops working at step 5.

## 4. TTS daemon

In `tts/.env`: confirm `STASH_SUPABASE_SERVICE_ROLE_KEY` is the
**service_role** key (not the publishable one) and add
`STASH_USER_ID=<your user id>` — both are now required; the daemon exits
with a FATAL message if either is missing or wrong. Restart the launchd job.

## 5. Re-enable RLS

This is the fix Supabase's `rls_disabled_in_public` advisor is flagging.
Only after steps 1–4 all work, run in the SQL Editor:

```
supabase/migrations/2026-07-09_reenable_rls.sql
```

It flips RLS on for all five tables, fixes the `save_tags` insert policy
(must own both the save and the tag), and defaults `user_id` to
`auth.uid()`.

## 6. Verify

- Web: load saves, Add Link, edit a tag, change digest settings, play audio.
- Extension: save a page, save a highlight.
- Bookmarklet: save a page from another browser.
- TTS: `python tts.py --once` writes an `audio_url` back.
- Unauthenticated write blocked:
  `curl -X POST .../functions/v1/save-page -d '{"url":"https://example.com"}'`
  → 401.
- Digest locked down: invoke `send-digest` without `X-Cron-Secret` → 401;
  with it (+ `user_id` in the body) → email arrives.
- Login locked down: request a code for an email that isn't yours →
  "Signups not allowed for otp"; no code sent, no account created.
- Cross-account isolation: create a second auth user, sign in from a clean
  browser profile → zero saves visible.
- Dashboard → Advisors: `rls_disabled_in_public` warnings clear.

## 7. Rollback

Run the `disable row level security` block at the bottom of the migration
file. No data is lost. The code changes work with RLS off (everything
still functions signed-in), so only the SQL needs reverting.

## Out of scope (known items, lower priority — not part of this fix)

- **Public audio bucket**: MP3s are fetchable by anyone holding a save's
  UUID. For full privacy: make the `audio` bucket private with a storage
  RLS policy; the web app's `getSignedAudioUrl()` already handles signed
  URLs.
- **Anon key rotation**: unnecessary once RLS is on (the key is designed
  to be public), but rotating it gives a clean slate after months of
  exposure. Update `web/config.js` + `extension/config.js` if you do.
- **Stale `stash.xpi`** in the repo root contains the old insecure flow;
  rebuild or delete it.
- **CSP header** on Vercel (script-src self + jsdelivr) as a second layer
  against future XSS.
- **Email deliverability**: login depends on the OTP email arriving. If
  codes land in spam, point Auth SMTP at your existing Resend account.
