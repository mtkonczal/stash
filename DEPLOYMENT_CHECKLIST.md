# Security Fix Deployment Checklist

Code-side fixes were implemented on 2026-07-09 (see git diff). This file
covers the steps that must happen in the Supabase dashboard / your machine,
**in this order**. Nothing breaks until step 6, and each step is
independently reversible.

## What changed in the code (summary)

- **web/**: real auth required (session-gated `init()`, `onAuthStateChange`);
  login is **email OTP** (6-digit one-time code, `shouldCreateUser: false`,
  no signup path); `save-page` calls send the user JWT; `USER_ID` removed
  from config; stored-XSS fixes (DOMPurify on article content, attribute/URL
  escaping); `save.html` uses the shared session instead of a hardcoded
  user + anon REST.
- **extension/**: sign-in required (popup gates on session); login is the
  same email OTP flow (`/auth/v1/otp` → `/auth/v1/verify`, `create_user:
  false`, signup button removed); session persisted with refresh-token
  handling; `user_id` comes from the session; `USER_ID` removed from
  config; popup URL injection fixed.
- **supabase/functions/**: `save-page` and `save-kindle` now verify the
  caller's JWT and derive `user_id` server-side (they use the service-role
  key, which bypasses RLS, so trusting a body `user_id` meant anyone could
  write as anyone). `save-page` also accepts an `X-Stash-Token` secret for
  the bookmarklet. `send-digest` requires an `X-Cron-Secret` header and
  HTML-escapes untrusted content in emails.
- **bookmarklet/**: secret-token auth; no `user_id` sent.
- **tts/tts.py**: refuses to start without the service-role key and an
  explicit `STASH_USER_ID`; no more silent fallback to the publishable key.
- **supabase/**: migration to re-enable RLS + fix the `save_tags` insert
  policy (must own both the save and the tag); `schema.sql` updated to match.

## Deployment steps

### 1. Secrets (Supabase dashboard → Edge Functions → Secrets)

```bash
# Generate the bookmarklet token locally:
openssl rand -hex 32
```

Set these function secrets:

- `STASH_BOOKMARKLET_TOKEN` = the token you just generated
- `STASH_BOOKMARKLET_USER_ID` = your auth user id (Authentication → Users)
- `CRON_SECRET` = another `openssl rand -hex 32` output
- `RESEND_API_KEY` = (already set if digests work today)

(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected by Supabase; nothing to do.)

### 1b. Auth settings for single-user email-OTP login (dashboard → Authentication)

- **Sign In / Up → turn OFF "Allow new users to sign up".** This is the
  server-side lock; the clients also pass `shouldCreateUser: false`, but
  the dashboard toggle is what actually guarantees no one else can register.
- **Email Templates → "Magic Link": make sure the body includes
  `{{ .Token }}`** (e.g. "Your login code is {{ .Token }}"). The default
  template only contains a link; the new login form asks for the 6-digit
  code, which is `{{ .Token }}`.
- Optional: shorten the OTP expiry (Sign In / Up → Email OTP expiry;
  default 3600s — 300–600s is plenty for a personal app).
- Optional hardening: the password grant still exists for your account
  even though no UI uses it. Set your account password to a long random
  string (Authentication → Users → your user → reset password) so email
  OTP is the only practical way in.

### 2. Deploy the edge functions

```bash
 
```

`--no-verify-jwt` on `save-page` is required because the bookmarklet
authenticates with `X-Stash-Token`, not a JWT; the function does its own
auth (401 without a valid JWT **or** token). Same for `send-digest`
(cron secret instead of JWT). `save-kindle` keeps gateway JWT verification
on top of its in-function check.

If a cron job triggers `send-digest`, update it to send the header
`X-Cron-Secret: <CRON_SECRET>`.

### 3. Deploy the web app

Push `web/` to Vercel as usual. Sign in with your email → 6-digit code
from your inbox, and confirm the saves list loads. Session persists in
localStorage, so this is roughly a one-time login per browser.

### 4. Reload the extension and sign in

Reload the unpacked extension (and rebuild `stash.xpi` for Firefox — the
current xpi predates these fixes). Open the popup; it now shows the email
OTP form (send code → enter code). Sign in once; the session is stored in
`chrome.storage.local` and auto-refreshes.

### 5. Regenerate the bookmarklet + restart TTS

- Open `bookmarklet/install.html` (or `/bookmarklet.html` on the web app),
  paste the `STASH_BOOKMARKLET_TOKEN`, drag the new bookmarklet to the bar,
  delete the old one (it contains the old flow and stops working at step 6).
- `tts/.env`: confirm `STASH_SUPABASE_SERVICE_ROLE_KEY` is the **service_role**
  key and add `STASH_USER_ID=<your user id>` (now required). Restart the
  launchd job; the daemon exits with a FATAL message if misconfigured.

### 6. Re-enable RLS (the actual fix Supabase is flagging)

Run `supabase/migrations/2026-07-09_reenable_rls.sql` in the SQL Editor.
Do this only after 1–5 all work.

### 7. Verify

- Web: load saves, create a save via Add Link, edit a tag, change digest
  settings, play audio.
- Extension: save a page, save a highlight.
- Bookmarklet: save a page from another browser.
- TTS: `python tts.py --once` writes an `audio_url` back.
- Digest: invoke `send-digest` manually **without** the `X-Cron-Secret`
  header → expect 401; with it and a `user_id` in the body → email arrives.
- save-page without auth: `curl -X POST .../functions/v1/save-page -d '{"url":"https://example.com"}'`
  → expect 401.
- Lockout: request a login code for an email that isn't yours → expect
  "Signups not allowed for otp" (i.e., no code is sent, no account created).
- Cross-account: create a second auth user, sign in from a clean browser
  profile → they must see zero saves.
- Supabase dashboard → Advisors: `rls_disabled_in_public` warnings clear.

### 8. Rollback (if needed)

Run the `disable row level security` block at the bottom of the migration
file. No data is lost. The code changes are backward-compatible with RLS
off (everything still works signed-in), so only the SQL needs reverting.

## Known remaining items (lower priority)

- **Audio files are in a public storage bucket** — anyone with a save's
  UUID can fetch its MP3. UUIDs aren't guessable, but for full privacy:
  make the `audio` bucket private, add a storage RLS policy
  (`auth.uid() = owner` or path-prefix per user), and let the web app's
  existing `getSignedAudioUrl()` path handle playback (it already falls
  back to signed URLs for non-public URLs).
- **Anon key rotation is unnecessary** (it's designed to be public once
  RLS is on), but if you want a clean slate after months of exposure with
  RLS off, you can rotate the publishable key in the dashboard and update
  `web/config.js` + `extension/config.js`.
- **Email deliverability**: login now depends on receiving the OTP email.
  Supabase's built-in sender is fine for single-user, but if codes land in
  spam, point Auth SMTP at your existing Resend account.
- **`stash.xpi`** in the repo root is a stale build with the old insecure
  flow; rebuild or delete it.
- **CSP for the web app**: a `Content-Security-Policy` header on Vercel
  (script-src limited to self + jsdelivr) would add a second layer against
  any future XSS.
