// One owner for audio status, requests, polling, and recovery in the reading pane.
class StashAudioWorkflow {
  constructor(app) {
    this.app = app;
    this.epoch = 0;
    this.timer = null;
    this.controller = null;
    this.save = null;
    this.pending = false;
    this.action = 'request';
    this.loadedUrl = null;
    document.getElementById('audio-request-btn').addEventListener('click', () => {
      if (this.action === 'refresh') this.refresh(this.epoch);
      else this.request();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.save) this.refresh(this.epoch);
    });
    window.addEventListener('online', () => {
      if (this.save) this.refresh(this.epoch);
    });
  }

  close() {
    this.epoch += 1;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
    this.save = null;
    this.pending = false;
    this.loadedUrl = null;
  }

  open(save) {
    this.close();
    this.save = save;
    document.getElementById('audio-player').classList.add('hidden');
    document.getElementById('audio-expiry').classList.add('hidden');
    if (!save.audio_url && (save.highlight || !save.content || save.content.trim().length < 100)) {
      document.getElementById('audio-status').classList.add('hidden');
      return;
    }
    this.render('Checking audio…');
    this.refresh(this.epoch);
  }

  render(message, { detail = '', button = '', generating = false, action = 'request' } = {}) {
    const panel = document.getElementById('audio-status');
    panel.classList.remove('hidden');
    document.getElementById('audio-status-title').textContent = message;
    document.getElementById('audio-status-detail').textContent = detail;
    document.getElementById('audio-status-spinner').classList.toggle('hidden', !generating);
    const control = document.getElementById('audio-request-btn');
    control.classList.toggle('hidden', !button);
    control.textContent = button;
    control.disabled = this.pending;
    this.action = action;
  }

  async refresh(epoch) {
    if (!this.save || epoch !== this.epoch || this.pending || this.controller) return;
    clearTimeout(this.timer);
    if (navigator.onLine === false) {
      this.render('You’re offline', { detail: 'Reconnect to check audio. Saved requests remain queued.',
        button: 'Check again', action: 'refresh' });
      return;
    }
    const save = this.save;
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), 15000);
    let terminal = false;
    try {
      // Fetch audio_url afresh even for cached saves. Never infer status from
      // a missing URL, and never fetch the article's large content to poll.
      const result = await this.app.supabase.from('saves').select('audio_url,audio_expires_at,is_archived')
        .eq('id', save.id).abortSignal(controller.signal).single();
      if (epoch !== this.epoch) return;
      if (result.error) throw result.error;
      const archived = result.data?.is_archived;
      const url = archived ? null : result.data?.audio_url;
      if (url) {
        terminal = true;
        save.audio_url = url;
        this.app.patchLocalSave(save.id, { audio_url: url });
        if (this.loadedUrl !== url) {
          this.loadedUrl = url;
          const loaded = await this.app.initAudio(url);
          if (epoch !== this.epoch) return;
          if (loaded === false) {
            this.loadedUrl = null;
            this.render('Audio could not load', { detail: 'Your recording is saved. Check your connection and try again.',
              button: 'Load audio', action: 'refresh' });
            return;
          }
        }
        document.getElementById('audio-status').classList.add('hidden');
        document.getElementById('audio-player').classList.remove('hidden');
        const expiry = document.getElementById('audio-expiry');
        const expiresAt = result.data.audio_expires_at;
        expiry.classList.toggle('hidden', !expiresAt);
        expiry.textContent = expiresAt ? `Expires ${new Date(expiresAt).toLocaleDateString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
        })}. You can regenerate it afterward.` : '';
        return;
      }
      if (save.audio_url || this.loadedUrl) {
        save.audio_url = null;
        this.loadedUrl = null;
        this.app.patchLocalSave(save.id, { audio_url: null });
        this.app.stopAudio();
      }
      document.getElementById('audio-player').classList.add('hidden');
      document.getElementById('audio-expiry').classList.add('hidden');
      if (archived) {
        terminal = true;
        this.render('Archived article', { detail: 'Audio is removed when archived. Unarchive this article to generate it again.' });
        return;
      }
      const [jobs, workers] = await Promise.all([
        this.app.supabase.from('audio_jobs')
          .select('status,attempts,completed_chunks,total_chunks,last_error,lease_until,available_at')
          .eq('save_id', save.id).abortSignal(controller.signal).maybeSingle(),
        this.app.supabase.from('audio_workers').select('last_seen')
          .eq('user_id', this.app.user.id).abortSignal(controller.signal).maybeSingle(),
      ]);
      if (epoch !== this.epoch) return;
      if (jobs.error || workers.error) throw jobs.error || workers.error;
      const job = jobs.data;
      const awake = workers.data && Date.now() - Date.parse(workers.data.last_seen) < 120000;
      if (!job) {
        terminal = true;
        this.render('Audio hasn’t been requested', { detail: 'Generate a full recording with Sky.', button: 'Generate audio' });
      } else if (job.status === 'cancelled') {
        terminal = true;
        this.render('Audio removed', { detail: 'Generate a fresh recording with Sky.', button: 'Regenerate audio' });
      } else if (job.status === 'expired') {
        terminal = true;
        this.render('Audio expired after 3 months', {
          detail: 'The article is still saved. Generate a fresh recording with Sky.', button: 'Regenerate audio',
        });
      } else if (job.status === 'failed') {
        terminal = true;
        this.render('Audio generation failed', { detail: job.last_error || 'Retry to resume from saved sections.', button: 'Retry audio' });
      } else if (job.status === 'ready') {
        terminal = true;
        this.render('The recording is unavailable', { detail: 'Its audio link is missing. Check again or inspect the worker log.',
          button: 'Check again', action: 'refresh' });
      } else if (!awake || (job.status === 'generating' && Date.parse(job.lease_until) <= Date.now())) {
        this.render('Waiting for your Mac', { detail: 'Audio will resume when the worker reconnects. You can close this page.' });
      } else if (job.status === 'generating') {
        const progress = job.total_chunks > 0 ? `${job.completed_chunks} of ${job.total_chunks} sections complete. ` : '';
        this.render('Generating audio with Sky', { detail: progress + 'You can close this page.', generating: true });
      } else {
        this.render(job.attempts > 0 ? 'Audio queued for another attempt' : 'Audio queued', {
          detail: job.attempts > 0 ? 'The worker will retry automatically using saved sections.' : 'Your Mac will pick this up shortly. You can close this page.',
        });
      }
    } catch (error) {
      if (epoch !== this.epoch || this.pending) return;
      const setup = ['PGRST205', '42P01', 'PGRST202'].includes(error.code);
      this.render(setup ? 'Audio setup isn’t available yet' : 'Couldn’t check audio', {
        detail: setup ? 'The audio queue needs to be installed before generation can start.' : 'Check your connection or sign in again, then retry.',
        button: 'Check again', action: 'refresh',
      });
      terminal = true;
    } finally {
      clearTimeout(deadline);
      if (this.controller === controller) this.controller = null;
      if (epoch === this.epoch && this.save && !terminal && !document.hidden && !this.pending) {
        this.timer = setTimeout(() => this.refresh(epoch), 8000);
      }
    }
  }

  async request() {
    if (!this.save || this.pending) return;
    const save = this.save;
    const epoch = ++this.epoch;
    this.pending = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), 15000);
    this.render('Requesting audio…', { button: 'Requesting audio…' });
    let failed = false;
    try {
      const { error } = await this.app.supabase.rpc('request_stash_audio', { p_save_id: save.id })
        .abortSignal(controller.signal);
      if (error) throw error;
    } catch (_) {
      failed = true;
    } finally {
      clearTimeout(deadline);
      if (epoch === this.epoch) {
        this.pending = false;
        if (this.controller === controller) this.controller = null;
        if (failed) {
          this.render('Audio request wasn’t confirmed', { detail: 'Check its status before retrying. Repeated requests won’t create duplicate jobs.',
            button: 'Check status', action: 'refresh' });
        } else await this.refresh(epoch);
      }
    }
  }
}

if (typeof module !== 'undefined') module.exports = { StashAudioWorkflow };
else window.StashAudioWorkflow = StashAudioWorkflow;
