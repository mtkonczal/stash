// Listening state only. Local recovery works even when account sync is unavailable.
class StashAudioMemory {
  constructor(app) {
    this.app = app;
    this.context = null;
    this.fallback = new Map();
    this.syncing = null;
    this.lastStamp = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.checkpoint(true); this.flush(true); }
    });
    window.addEventListener('pagehide', () => { this.checkpoint(true); this.flush(true); });
    window.addEventListener('online', () => this.flush());
  }

  key(user) { return `stash-listening-v1:${user}`; }
  read(user) {
    try {
      const data = JSON.parse(localStorage.getItem(this.key(user)) || 'null');
      if (data && data.positions && typeof data.positions === 'object') return data;
    } catch (_) { /* Private browsing / unavailable storage: use this session. */ }
    return this.fallback.get(user) || { speed:null, positions:{} };
  }
  write(user, data) {
    this.fallback.set(user, data);
    try { localStorage.setItem(this.key(user), JSON.stringify(data)); } catch (_) { /* Keep session state. */ }
  }
  stamp() {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }
  validSpeed(speed) { return [0.75,1,1.25,1.5,2].includes(Number(speed)); }
  newer(a, b) { return a && (!b || Date.parse(a.changedAt) >= Date.parse(b.changedAt)) ? a : b; }

  async restore(saveId, ref) {
    const user = this.app.user?.id;
    if (!user) return { speed:1, position:null };
    let controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 3000);
    try {
      const [prefs, progress] = await Promise.all([
        this.app.supabase.from('audio_preferences').select('speed,changed_at').eq('user_id',user)
          .abortSignal(controller.signal).maybeSingle(),
        this.app.supabase.from('audio_positions').select('audio_url,position_seconds,duration_seconds,completed,changed_at')
          .eq('save_id',saveId).eq('user_id',user).abortSignal(controller.signal).maybeSingle(),
      ]);
      const data = this.read(user); // Re-read: a user action may have occurred during the fetch.
      if (!prefs.error && prefs.data && this.validSpeed(prefs.data.speed)) {
        data.speed = this.newer(data.speed, { value:prefs.data.speed, changedAt:prefs.data.changed_at, pending:false });
      }
      if (!progress.error && progress.data) {
        const p = progress.data;
        const remote = { ref:p.audio_url, position:p.position_seconds, duration:p.duration_seconds,
          completed:p.completed, changedAt:p.changed_at, pending:false };
        const local = data.positions[saveId];
        // A newer checkpoint from an obsolete recording must not hide the
        // current recording's resume point from another device.
        if (remote.ref === ref && local?.ref !== ref) data.positions[saveId] = remote;
        else if (local?.ref !== ref || remote.ref === ref) data.positions[saveId] = this.newer(local,remote);
      }
      this.write(user,data);
    } catch (_) { /* Local resume is independent of the database and connectivity. */ }
    finally { clearTimeout(deadline); }
    const data = this.read(user);
    this.flush();
    return { speed:this.validSpeed(data.speed?.value) ? Number(data.speed.value) : 1,
      position:data.positions[saveId]?.ref === ref ? data.positions[saveId] : null };
  }

  attach(audio, saveId, ref, restored) {
    const user = this.app.user?.id;
    const ctx = this.context = { audio, saveId, ref, user, ready:false, active:false,
      restoring:false, localAt:0, syncedAt:0 };
    audio.playbackRate = restored.speed;
    document.getElementById('audio-speed').value = String(restored.speed);
    const current = () => this.context === ctx;
    audio.addEventListener('loadedmetadata', () => {
      if (!current() || !Number.isFinite(audio.duration)) return;
      const p = restored.position;
      const target = p && !p.completed && Number.isFinite(p.position) ? Math.max(0,Math.min(p.position,audio.duration)) : 0;
      ctx.restoring = target > 0;
      if (target > 0) audio.currentTime = target;
      ctx.ready = true;
      document.getElementById('audio-current').textContent = this.app.formatTime(target);
      document.getElementById('audio-progress').style.width = `${audio.duration ? target/audio.duration*100 : 0}%`;
    });
    audio.addEventListener('play', () => { if (current()) ctx.active = true; });
    audio.addEventListener('timeupdate', () => { if (current()) this.checkpoint(); });
    audio.addEventListener('seeked', () => {
      if (!current()) return;
      if (ctx.restoring) { ctx.restoring = false; return; }
      ctx.active = true;
      this.checkpoint(true);
    });
    audio.addEventListener('pause', () => { if (current()) this.checkpoint(true); });
    audio.addEventListener('ended', () => { if (current()) { this.checkpoint(true,true); ctx.active = false; } });
  }

  setSpeed(value) {
    const user = this.app.user?.id;
    const speed = Number(value);
    if (!user || !this.validSpeed(speed)) return;
    if (this.app.audio) this.app.audio.playbackRate = speed;
    const data = this.read(user);
    data.speed = { value:speed, changedAt:this.stamp(), pending:true };
    this.write(user,data);
    this.flush();
  }

  checkpoint(force=false, completed=false) {
    const c = this.context;
    if (!c?.user || !c.ready || !c.active || c.restoring) return;
    const { audio } = c;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(audio.currentTime)) return;
    const now = Date.now();
    if (!force && now-c.localAt < 1000) return;
    const data = this.read(c.user);
    data.positions[c.saveId] = { ref:c.ref, position:completed ? audio.duration : Math.min(audio.duration,Math.max(0,audio.currentTime)),
      duration:audio.duration, completed, changedAt:this.stamp(), pending:true };
    this.write(c.user,data);
    c.localAt = now;
    if (force || now-c.syncedAt >= 10000) { c.syncedAt = now; this.flush(); }
  }
  detach() { this.checkpoint(true); this.context = null; }

  async send(name, args, keepalive) {
    const session = keepalive && this.app.readStoredSession?.();
    if (session?.access_token && typeof CONFIG !== 'undefined') {
      const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method:'POST', keepalive:true, headers:{ 'Content-Type':'application/json',
          apikey:CONFIG.SUPABASE_ANON_KEY, Authorization:`Bearer ${session.access_token}` }, body:JSON.stringify(args),
      });
      if (!res.ok) throw new Error('Listening sync unavailable');
      return;
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const { error } = await this.app.supabase.rpc(name,args).abortSignal(controller.signal);
      if (error) throw new Error('Listening sync unavailable');
    } finally { clearTimeout(deadline); }
  }

  async flush(keepalive=false) {
    const user = this.app.user?.id;
    // A keepalive flush may duplicate an in-flight update; timestamps make it safe.
    if (!user || (this.syncing && !keepalive)) return;
    const run = async () => {
      const data = this.read(user);
      const entries = [];
      if (data.speed?.pending) entries.push(['speed',data.speed]);
      for (const [id,p] of Object.entries(data.positions)) if (p.pending) entries.push([id,p]);
      for (const [id,p] of entries) {
        if (this.app.user?.id !== user) return;
        const speed = id === 'speed';
        const args = speed ? { p_speed:p.value, p_changed_at:p.changedAt } : {
          p_save_id:id, p_audio_url:p.ref, p_position:p.position, p_duration:p.duration,
          p_completed:p.completed, p_changed_at:p.changedAt,
        };
        try {
          await this.send(speed ? 'remember_stash_audio_speed' : 'remember_stash_audio_position',args,keepalive);
          const latest = this.read(user);
          const saved = speed ? latest.speed : latest.positions[id];
          if (saved?.changedAt === p.changedAt) { saved.pending = false; this.write(user,latest); }
        } catch (_) { return false; } // Keep pending state for reconnect/reopen, without blocking playback.
      }
      return true;
    };
    const promise = run();
    if (!keepalive) this.syncing = promise;
    let success;
    try { success = await promise; } finally { if (this.syncing === promise) this.syncing = null; }
    if (success && !keepalive && this.app.user?.id === user) {
      const latest = this.read(user);
      if (latest.speed?.pending || Object.values(latest.positions).some(p => p.pending)) this.flush();
    }
  }
}
if (typeof module !== 'undefined') module.exports = { StashAudioMemory };
else window.StashAudioMemory = StashAudioMemory;
