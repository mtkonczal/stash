# Stash audio: local Kokoro / Sky

New full articles are queued in Supabase. A local macOS worker generates the
entire article with Kokoro's `af_sky` voice and uploads an MP3 to private
Supabase storage. No paid speech API, Git commit, or push is involved in
generation. Existing recordings remain playable. The old `tts.py` is retained
for reference, but its LaunchAgent is disabled after installing the replacement.

See [KOKORO.md](KOKORO.md) for model download and voice audition instructions.

## Install

Apply `supabase/migrations/202610180001_audio_jobs.sql` once in the Supabase SQL
editor, or with an authenticated, linked CLI:

```sh
supabase db query --linked --file supabase/migrations/202610180001_audio_jobs.sql
supabase db query --linked --file supabase/migrations/202610180002_audio_storage_budget.sql
```

Provide `STASH_SUPABASE_URL`, `STASH_SUPABASE_SERVICE_ROLE_KEY`, and
`STASH_USER_ID` via local environment or `tts/.env`. Never commit credentials.
The user's UUID is available under Supabase Authentication → Users. It is
validated against the project at startup. Keys never go into the browser.

With the models/runtime downloaded and uv plus ffmpeg installed, run:

```sh
tts/.venv-kokoro/bin/python tts/install_worker.py --user-id YOUR_USER_UUID --start
```

The installer uses the downloaded uv package cache in `/private/tmp/stash-uv-cache`
offline. If this cache was cleared, pre-populate it from the pinned lock:

```sh
UV_CACHE_DIR=/private/tmp/stash-uv-cache uv pip install --python tts/.venv-kokoro/bin/python -r tts/requirements-kokoro.lock
```

The installer validates the installed worker's credentials and queue access
before starting it. It disables the legacy LaunchAgent only after the new agent
is accepted. Source updates require rerunning the installer; production does
not execute files inside the Documents checkout.

## Runtime and logs

Installed files: `~/Library/Application Support/StashAudio/`.

- `.venv/`: isolated Python runtime; `models/`: model and voices.
- `.env`: credentials, file mode 0600; runtime directory mode 0700.
- `state/cache/`: completed WAV sections for interrupted jobs.
- `worker.err.log`: timestamped progress/errors; no credentials or article text.
- Per-section failure details: `state/cache/<job>/<content-hash>/render-error.log`.

LaunchAgent: `~/Library/LaunchAgents/com.mikekonczal.stash.sky.plist`.
It runs when logged in; it cannot generate while the Mac is asleep. The UI
shows Waiting for your Mac after heartbeat expiry. Generation resumes on wake;
completed uploads play independently of the Mac.

```sh
launchctl list com.mikekonczal.stash.sky
tail -f "$HOME/Library/Application Support/StashAudio/worker.err.log"
"$HOME/Library/Application Support/StashAudio/.venv/bin/python" "$HOME/Library/Application Support/StashAudio/worker.py" --check
```

## Queue and recovery

- Only new eligible articles queue automatically, including articles whose full
  content arrives in a later update. Old articles need Generate audio; no bulk
  backlog is submitted. Existing MP3s are not regenerated.
- Jobs snapshot the article text at request time. Later text edits do not
  silently change an existing recording. Only Sky is supported by this queue.
- Claims are atomic and have a ten-minute lease, renewed during generation and
  upload. One local worker runs at a time. Stale workers cannot finish jobs.
- Each render section is limited to three minutes. A stalled subprocess is
  killed. HTTP calls, uploads, and encoding also have deadlines.
- A job retries twice with backoff, then shows Failed with Retry audio. Retry
  reuses verified completed sections. Completed local checkpoints are deleted
  only after the database confirms the MP3 and completion atomically.
- `--once` processes at most one job and exits nonzero on failure; `--check`
  verifies setup without processing jobs. Neither is needed for normal use.
- Source content is not truncated. Encoding is 64 kbps mono MP3, about
  0.48 MB/minute of audio.

New files use `storage://stash-audio/<user-uuid>/<job-uuid>.mp3` in `audio_url`.
The web client exchanges this reference for a one-hour signed playback link.
The legacy public `audio` bucket is unchanged. The browser refreshes status
while an article is open, cancels stale requests, and never autoplays.

No automatic remote deletion or storage-plan upgrades. The worker checks
storage size before each upload and refuses to exceed a 950 MB safety budget
or the free service's 50 MB per-file upload limit. Existing files are not
deleted to make room. Free generation does not remove storage/transfer quotas.

## Tests

```sh
tts/.venv-kokoro/bin/python -m unittest discover -s tts/tests -v
node --test tests/audio-workflow.test.cjs
# Install @electric-sql/pglite and playwright in a separate test environment:
PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js node tests/audio-queue.test.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/audio-browser.cjs
```

Database tests use an isolated embedded PostgreSQL instance with mock auth and
storage schemas. Browser tests use the actual app HTML/JS/CSS with explicit API
fixtures and a real local MP3. They do not sign into the user's account.

To render a UTF-8 text file locally without any Supabase access:

```sh
tts/.venv-kokoro/bin/python tts/worker.py --local-file /absolute/path/article.txt --output /absolute/path/article.mp3
```

## Rollback

Keep the additive database tables and recordings. Stop automatic requests:

```sql
alter table public.saves disable trigger queue_new_stash_audio;
```

Stop the worker with `launchctl bootout gui/$(id -u)/com.mikekonczal.stash.sky`.
Do not restore the old web client while `storage://` recordings are in use;
it cannot resolve private Sky references. Fix or roll forward the audio client.
The old Edge worker should stay disabled unless its configuration is repaired
and coexistence with the queue is addressed.
