// Real Chromium against the actual app markup/scripts, with explicit API fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const server = http.createServer(async (req, res) => {
    let file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (file === root) file = path.join(root, 'web/index.html');
    else if (!file.includes('/tts/')) file = path.join(root, 'web', new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await fs.readFile(file);
      const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.mp3':'audio/mpeg' };
      if (path.extname(file)==='.mp3' && req.headers.range) {
        const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        const start=Number(match?.[1] || 0);
        const end=Math.min(body.length-1,match?.[2] ? Number(match[2]) : body.length-1);
        res.writeHead(206, {'Content-Type':'audio/mpeg','Accept-Ranges':'bytes',
          'Content-Range':`bytes ${start}-${end}/${body.length}`,'Content-Length':end-start+1});
        res.end(body.subarray(start,end+1));return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Content-Length':body.length,'Accept-Ranges':'bytes' });
      res.end(body);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.route('https://**/*', route => route.fulfill({ body: '', contentType: 'application/javascript' }));
    await page.addInitScript(() => {
      window.fixture = { url: null, job: null, seen: null, error: null, expiresAt:null };
      window.marked = { setOptions() {}, parse: text => '<p>' + text + '</p>' };
      window.DOMPurify = { sanitize: text => text };
      const client = {
        auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() {} },
        storage: { from: () => ({ createSignedUrl: async () => ({ data: {
          signedUrl: '/tts/auditions/more-female/af_sky.mp3',
        }, error: null }) }) },
        rpc: () => ({ abortSignal: async () => {
          window.fixture.job = { status: 'queued' };
          return { error: null };
        }}),
        from(table) {
          const q = { fields:'', select(fields) { this.fields=fields; return this; }, eq() { return this; },
            abortSignal() { return this; }, order() { return this; },
            result() {
              if (table === 'saves') return { data: { audio_url: window.fixture.url, audio_expires_at:window.fixture.expiresAt, is_archived:window.fixture.archived, content: 'An article. '.repeat(30) }, error: window.fixture.error };
              if (table === 'audio_jobs') return { data: window.fixture.job, error: window.fixture.error };
              if (table === 'audio_workers') return { data: window.fixture.seen ? { last_seen: window.fixture.seen } : null, error: window.fixture.error };
              return { data: [], error: null };
            },
            async single() { return this.result(); }, async maybeSingle() { return this.result(); },
            then(resolve, reject) { return Promise.resolve(this.result()).then(resolve,reject); },
          };
          return q;
        },
      };
      window.supabase = { createClient: () => client };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof app !== 'undefined' && app.audioWorkflow);
    await page.evaluate(async () => {
      app.user = { id: 'fixture-user' };
      app.showMainScreen();
      await app.openReadingPane({ id:'fixture-save', title:'Sky audio test', site_name:'Local test fixture',
        created_at: new Date().toISOString(), content:'This is a local fixture article. '.repeat(30) });
    });
    assert.equal(await page.locator('#audio-section').evaluate(e => e.open),false);
    assert.equal(await page.locator('#audio-request-btn').isVisible(),false);
    await page.locator('#audio-section > summary').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name:'Generate audio', exact:true }).waitFor();
    await page.getByRole('button', { name:'Generate audio', exact:true }).focus();
    await page.keyboard.press('Enter');
    await page.getByText('Waiting for your Mac', { exact:true }).last().waitFor();
    await page.evaluate(async () => {
      fixture.seen = new Date().toISOString();
      fixture.job = { status:'generating', completed_chunks:2, total_chunks:7, lease_until:new Date(Date.now()+60000).toISOString() };
      await app.audioWorkflow.refresh(app.audioWorkflow.epoch);
    });
    await page.getByText('Generating audio with Sky', { exact:true }).last().waitFor();
    assert.match(await page.locator('#audio-status-detail').innerText(), /2 of 7/);
    await page.setViewportSize({ width:390, height:844 });
    await page.emulateMedia({ reducedMotion:'reduce' });
    assert.equal(await page.locator('#audio-status-spinner').evaluate(e => getComputedStyle(e).animationName), 'none');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme','dark'));
    await page.screenshot({ path:path.join(root,'tts/auditions/sky-status-mobile.png'), fullPage:true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(async () => {
      fixture.job = { status:'failed', last_error:'The upload was interrupted. Retry to resume.' };
      await app.audioWorkflow.refresh(app.audioWorkflow.epoch);
    });
    await page.getByRole('button', { name:'Retry audio', exact:true }).waitFor();
    await page.getByRole('button', { name:'Retry audio', exact:true }).click();
    await page.getByText('Audio queued', { exact:true }).last().waitFor();
    await page.evaluate(async () => {
      fixture.url = 'storage://stash-audio/fixture-user/recording.mp3';
      fixture.expiresAt='2027-01-18T12:00:00Z';
      await app.audioWorkflow.refresh(app.audioWorkflow.epoch);
    });
    await page.locator('#audio-player').waitFor({ state:'visible' });
    assert.match(await page.locator('#audio-expiry').innerText(),/2027/);
    await page.locator('#audio-play-btn').click();
    await page.waitForFunction(() => app.isPlaying && app.audio.currentTime > 0);
    await page.locator('#audio-speed').selectOption('1.5');
    assert.equal(await page.evaluate(() => app.audio.playbackRate),1.5);
    await page.locator('#audio-play-btn').click();
    await page.evaluate(() => { app.audio.currentTime=10; });
    const duration=await page.evaluate(() => app.audio.duration);
    await page.getByRole('button',{name:'Forward 15 seconds',exact:true}).click();
    assert.ok(Math.abs(await page.evaluate(() => app.audio.currentTime)-Math.min(duration,25))<0.2);
    await page.getByRole('button',{name:'Back 15 seconds',exact:true}).click();
    assert.ok(Math.abs(await page.evaluate(() => app.audio.currentTime)-Math.max(0,Math.min(duration,25)-15))<0.2);
    await page.evaluate(() => { app.audio.currentTime=0; });
    await page.getByRole('button',{name:'Back 15 seconds',exact:true}).click();
    assert.equal(await page.evaluate(() => app.audio.currentTime),0);
    await page.evaluate(() => { app.audio.currentTime=app.audio.duration-1; });
    await page.getByRole('button',{name:'Forward 15 seconds',exact:true}).click();
    assert.ok(Math.abs(await page.evaluate(() => app.audio.currentTime)-duration)<0.2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path:path.join(root,'tts/auditions/sky-player-mobile.png'), fullPage:true });
    await page.evaluate(() => { app.audio.currentTime=0; });
    await page.locator('#audio-play-btn').click();
    await page.waitForFunction(() => app.isPlaying && !app.audio.paused);
    await page.locator('#audio-section > summary').click();
    assert.equal(await page.locator('#audio-player').isVisible(),false);
    assert.equal(await page.evaluate(() => app.isPlaying && !app.audio.paused),true);
    assert.equal(await page.locator('#audio-summary-state').innerText(),'Playing');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme','light'));
    await page.screenshot({ path:path.join(root,'tts/auditions/sky-player-collapsed-mobile.png'), fullPage:true });
    await page.locator('#audio-section > summary').click();
    await page.locator('#audio-play-btn').click();
    await page.evaluate(async () => {
      fixture.url=null;
      fixture.archived=true;
      await app.audioWorkflow.refresh(app.audioWorkflow.epoch);
    });
    await page.getByText('Archived article', {exact:true}).last().waitFor();
    assert.equal(await page.locator('#audio-request-btn').isVisible(),false);
    await page.evaluate(async () => {
      fixture.archived=false;
      fixture.job={ status:'expired' };
      await app.audioWorkflow.refresh(app.audioWorkflow.epoch);
    });
    await page.getByRole('button',{ name:'Regenerate audio',exact:true }).waitFor();
    assert.equal(await page.locator('#audio-player').isVisible(),false);
    await page.getByRole('button',{ name:'Regenerate audio',exact:true }).click();
    await page.getByText('Audio queued',{ exact:true }).last().waitFor();
    await page.evaluate(() => app.closeReadingPane());
    assert.equal(await page.evaluate(() => app.audioWorkflow.save),null);
    await page.evaluate(async () => {
      fixture.url = null;
      fixture.error = { code:'PGRST205' };
      await app.openReadingPane({ id:'another-save', title:'Setup error', created_at:new Date().toISOString(), content:'Fixture text. '.repeat(20) });
    });
    assert.equal(await page.locator('#audio-section').evaluate(e => e.open),false);
    await page.locator('#audio-section > summary').click();
    await page.getByText('Audio setup isn’t available yet', { exact:true }).last().waitFor();
    await page.evaluate(() => app.closeReadingPane());
    assert.deepEqual(failures,[]);
    console.log('Chromium: collapsed disclosure, keyboard expand, 15-second seeks and boundaries, Generate, keyboard, waiting, progress, failed/retry, private playback, speed, archive/unarchive, expired/regenerate, close, setup error, narrow viewport, dark theme, reduced motion passed');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
