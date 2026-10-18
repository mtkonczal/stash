# Stash audio behavior contract

Scope: the Sky audio migration, preserving the existing reading application.
Authority: the user's approved workflow in this chat, implemented by
the audio migrations under `supabase/migrations/` and `tts/worker.py`.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| CRUD | `web/audio-workflow.js` | Queue RPCs and this contract | Generate / Retry / Regenerate | `tests/audio-workflow.test.cjs`, `tests/audio-queue.test.mjs` |
| Select/Listbox | Existing `#audio-speed` native select | Existing playback controls | Native speed selection | Browser keyboard/popup check |
| Form | Existing button actions in the reading pane | `web/index.html` | No new form | Browser keyboard check |
| Scrollbar | `web/styles.css` | Existing application layout | Reading pane scroll | Browser narrow viewport check |
| Toast | Audio status inline live region | `web/audio-workflow.js` | Status / error / recovery | `tests/audio-workflow.test.cjs` |

## State and recovery

- New full articles queue automatically after the migration. Existing articles
  are not backfilled automatically. Highlights and text under 100 characters
  are ineligible. Existing audio is never replaced by this migration.
- Generate/Retry/Regenerate is authenticated, ownership checked, and idempotent. Users
  cannot directly edit job status or claim work through browser credentials.
- State: queued → generating → ready; failures back off twice, then failed.
  Explicit Retry resets the retry budget and reuses completed local sections.
- Worker claims use a renewable lease. An expired worker cannot finish or fail
  another worker's job. A stale heartbeat shows Waiting for your Mac.
- Opening an article fetches a fresh audio URL, including for cached articles.
  Poll every eight seconds while the pane is visible; stop when ready/failed,
  closed, or signed out. Recheck on visibility and network restoration.
- Every request has a timeout. An uncertain request offers Check status; it
  does not claim generation failed. Duplicate requests are safe on the server.
- Async replies cannot update a closed pane or another article. Playback link
  failures offer Load audio without submitting a new synthesis job.
- New MP3s are private in `stash-audio`, readable only by their owner via signed
  links. The legacy public `audio` bucket and URLs remain unchanged.
- Existing recordings have no expiry. Future audio expires three calendar
  months after generation; the Mac worker checks roughly hourly while awake.
  Articles remain saved. Expired audio offers Regenerate audio, using current
  article text and a fresh object UUID and three-month window. No local backups.
- Future ready recordings show their expiry date. An expired cached playback
  URL is cleared before presenting regeneration.
- Storage API deletion uses a durable outbox and exact private object names.
  Failed deletions retry; regenerations cannot reuse an expired object path.
  Storage limits still apply to all retained recordings.

## Business-source traceability

| Decision | Source | UI consequence |
|---|---|---|
| Free local Sky synthesis | User's explicit choice in this chat | No paid provider or billing UI |
| Existing articles/audio preserved | Approved replacement plan | No bulk regeneration or deletion |
| Existing recordings stay; future audio expires after three calendar months | User’s explicit retention choice | Expiry date and Regenerate audio |
| Owner access only | Existing `supabase/schema.sql` RLS model | Authenticated Generate/Retry and private new audio |
| New-article automatic queue | Approved workflow | Saving a new article requires no second action |
| Local machine can sleep | Approved workflow | Explicit Waiting for your Mac state |

## Existing application scope

The legacy tag/folder dialogs, saving/importing flows, and navigation are not
redesigned in this change. Existing native-dialog and accessibility gaps there
are not evidence of compliance; the new audio flow uses inline recovery.
