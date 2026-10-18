const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StashAudioWorkflow } = require('../web/audio-workflow.js');

function setup({ url = null, job = null, lastSeen = null, error = null, initAudio = async () => true } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, { textContent: '', disabled: false, addEventListener() {}, classList: {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, force) => force ? classes.add(c) : classes.delete(c),
      }});
    }
    return elements.get(id);
  }
  global.document = { getElementById: element, hidden: true, addEventListener() {} };
  global.window = { addEventListener() {} };
  Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true });
  let requests = 0;
  const app = { user: { id: 'user' }, patchLocalSave() {}, initAudio, supabase: {
    from(table) {
      const result = table === 'saves' ? { data: { audio_url: url }, error } :
        table === 'audio_jobs' ? { data: job, error } : { data: lastSeen ? { last_seen: lastSeen } : null, error };
      const query = { select() { return this; }, eq() { return this; }, abortSignal() { return this; },
        single: async () => result, maybeSingle: async () => result };
      return query;
    },
    rpc() { requests++; return { abortSignal: async () => ({ error: null }) }; },
  }};
  const flow = new StashAudioWorkflow(app);
  flow.save = { id: 'save', content: 'x'.repeat(150) };
  return { flow, element, app, count: () => requests };
}

test('missing URL and no job offers Generate, never a generating spinner', async () => {
  const { flow, element } = setup();
  await flow.refresh(flow.epoch);
  assert.equal(element('audio-status-title').textContent, 'Audio hasn’t been requested');
  assert.equal(element('audio-request-btn').textContent, 'Generate audio');
  assert.ok(element('audio-status-spinner').classList.contains('hidden'));
  flow.close();
});
test('queued job with no heartbeat truthfully waits for the Mac', async () => {
  const { flow, element } = setup({ job: { status: 'queued' } });
  await flow.refresh(flow.epoch);
  assert.equal(element('audio-status-title').textContent, 'Waiting for your Mac');
  flow.close();
});
test('live generation reports actual section counts', async () => {
  const { flow, element } = setup({ lastSeen: new Date().toISOString(), job: {
    status: 'generating', completed_chunks: 4, total_chunks: 8, lease_until: new Date(Date.now()+60000).toISOString(),
  }});
  await flow.refresh(flow.epoch);
  assert.match(element('audio-status-detail').textContent, /4 of 8/);
  assert.ok(!element('audio-status-spinner').classList.contains('hidden'));
  flow.close();
});
test('failed jobs expose a retry action', async () => {
  const { flow, element } = setup({ job: { status: 'failed', last_error: 'Upload failed' } });
  await flow.refresh(flow.epoch);
  assert.equal(element('audio-request-btn').textContent, 'Retry audio');
  assert.equal(element('audio-status-detail').textContent, 'Upload failed');
  flow.close();
});
test('recording completed elsewhere loads without reopening the article', async () => {
  let loaded = null;
  const { flow, element } = setup({ url: 'storage://stash-audio/user/job.mp3', initAudio: async u => { loaded=u; return true; } });
  await flow.refresh(flow.epoch);
  assert.equal(loaded, 'storage://stash-audio/user/job.mp3');
  assert.ok(element('audio-status').classList.contains('hidden'));
  assert.ok(!element('audio-player').classList.contains('hidden'));
  flow.close();
});
test('missing migration produces a recoverable setup message', async () => {
  const { flow, element } = setup({ error: { code: 'PGRST205' } });
  await flow.refresh(flow.epoch);
  assert.match(element('audio-status-title').textContent, /setup/);
  assert.equal(flow.action, 'refresh');
  flow.close();
});
test('double clicks create one idempotent request', async () => {
  const { flow, count } = setup();
  await Promise.all([flow.request(), flow.request()]);
  assert.equal(count(), 1);
  flow.close();
});
test('a closed pane cannot be updated by a delayed playback link', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const { flow, element } = setup({ url: 'storage://stash-audio/user/job.mp3', initAudio: () => pending });
  const refresh = flow.refresh(flow.epoch);
  await new Promise(r => setImmediate(r));
  flow.close();
  resolve(true);
  await refresh;
  assert.ok(element('audio-player').classList.contains('hidden'));
});
