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

- Audio is a native details/summary disclosure, initially collapsed on every
  article open. Its summary exposes job status or Ready/Playing. Expanding never
  starts playback; collapsing never interrupts it. Ineligible saves hide it.
- Back/Forward buttons seek 15 seconds and clamp at zero and recording duration.
- Listening speed is remembered per account; position is remembered per article
  and canonical recording URL. `web/audio-memory.js` owns local checkpoints and
  owner-only sync through the playback-memory migration. New recordings reset
  position; finished recordings reopen at zero; nothing autoplays on restore.
- Local checkpoints save roughly every second while active, plus pause, seek,
  close and page hide. Account writes are throttled to ten seconds while playing,
  with immediate writes on pause/seek/close and keepalive on page exit. Offline
  writes stay pending for reconnect/reopen. Failure never blocks playback.
- Listening-event timestamps prevent delayed older writes from
  replacing a newer choice or intentional rewind. Client event times are used
  for ordering and capped at server time; devices should use automatic clocks.
- Preferences and positions are owner-readable only. Only authenticated RPCs
  write them, checking current save ownership, archive state and recording URL.
  Deleting an article cascades its account resume point. Local caches are keyed
  by account and are ignored for a regenerated recording.

- New full articles queue automatically after the migration. Existing articles
  are not backfilled automatically. Highlights and text under 100 characters
  are ineligible. Active existing audio is never replaced automatically.
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
  links. Legacy public recordings use the same archive/delete cleanup policy.
- Active existing recordings have no expiry. Future audio expires three calendar
  months after generation; the Mac worker checks roughly every minute while awake.
  Articles remain saved. Expired audio offers Regenerate audio, using current
  article text and a fresh object UUID and three-month window. No local backups.
- Future ready recordings show their expiry date. An expired cached playback
  URL is cleared before presenting regeneration.
- Storage API deletion uses a durable outbox and exact private object names.
  Failed deletions retry; regenerations cannot reuse an expired object path.
  Storage limits still apply to all retained recordings.

- Archive clears audio and cancels queued/in-flight synthesis, including legacy
  recordings. The article remains. Archived audio status explains that the user
  must unarchive before generating again; unarchiving never queues automatically.
- Delete durably queues the MP3 before removing the article and job. Cleanup
  catches late uploads and old unreferenced files. Confirmed cancelled/deleted
  job caches are discarded; active and retryable caches are preserved.

## Business-source traceability

| Decision | Source | UI consequence |
|---|---|---|
| Free local Sky synthesis | User's explicit choice in this chat | No paid provider or billing UI |
| Active articles/audio preserved | Approved replacement plan | No bulk regeneration |
| Archive removes audio; delete removes both, including legacy | User’s explicit instruction on October 19, 2026 | Unarchive before regeneration |
| Existing recordings stay; future audio expires after three calendar months | User’s explicit retention choice | Expiry date and Regenerate audio |
| Owner access only | Existing `supabase/schema.sql` RLS model | Authenticated Generate/Retry and private new audio |
| New-article automatic queue | Approved workflow | Saving a new article requires no second action |
| Local machine can sleep | Approved workflow | Explicit Waiting for your Mac state |

## Existing application scope

The legacy tag/folder dialogs, saving/importing flows, and navigation are not
redesigned in this change. Existing native-dialog and accessibility gaps there
are not evidence of compliance; the new audio flow uses inline recovery.
