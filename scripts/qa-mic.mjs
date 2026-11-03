// Fake-microphone QA: Chromium with --use-fake-device-for-media-stream and a WAV file as the mic.
// Proves silence produces no transcription, no AI call and no speech; checks cancel, interrupt, navigation.
// Usage: BASE=http://127.0.0.1:8788 SILENCE=/path/silence.wav SPEECH=/path/speech.wav node scripts/qa-mic.mjs
import { chromium } from 'playwright';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8788';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const ttsStub = () => {
  const log = []; let active = null;
  window.__tts = log;
  class U { constructor(t) { this.text = t; } }
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    speak(u) { log.push({ t: 'speak', text: u.text }); active = u; const me = u; setTimeout(() => { if (active === me) { active = null; me.onend && me.onend({}); } }, 500); },
    cancel() { log.push({ t: 'cancel' }); const a = active; active = null; a && a.onerror && a.onerror({ error: 'interrupted' }); },
    pause() {}, resume() {}, getVoices: () => [], paused: false,
  } });
  window.SpeechSynthesisUtterance = U;
};

async function session(wav, fn) {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'], reducedMotion: 'reduce' });
  await ctx.addInitScript(ttsStub);
  const calls = { transcribe: [], assistant: 0, discover: 0 };
  const p = await ctx.newPage();
  p.on('response', async (r) => {
    const u = r.url();
    if (u.endsWith('/api/voice/transcribe')) calls.transcribe.push(await r.json().catch(() => ({})));
    if (u.endsWith('/api/assistant')) calls.assistant++;
    if (u.endsWith('/api/discover')) calls.discover++;
  });
  await p.request.post(`${BASE}/api/demo/start`, { data: {} });
  try { await fn(p, calls); } finally { await b.close(); }
}
const speaks = (p) => p.evaluate(() => window.__tts.filter((x) => x.t === 'speak').length);
const bar = (p) => p.locator('[aria-label="Voice controls"]').innerText();

// 1. Silence: tap, say nothing, wait for the timeout.
await session(process.env.SILENCE, async (p, calls) => {
  await p.goto(`${BASE}/home`);
  await p.getByRole('button', { name: 'Start listening' }).click();
  await p.waitForTimeout(800);
  check('fake mic is live (Listening… shown)', /Listening/.test(await bar(p)));
  await p.waitForTimeout(6800);
  const txt = await bar(p);
  check('silence timeout shows "I didn\'t hear anything. Tap to try again."', /I didn't hear anything\. Tap to try again\./.test(txt), txt.replace(/\n/g, ' | '));
  check('silence: no transcription request', calls.transcribe.length === 0, JSON.stringify(calls.transcribe));
  check('silence: no AI call', calls.assistant === 0);
  check('silence: nothing spoken', (await speaks(p)) === 0);

  // 2. Tap to start, tap again to cancel (no speech).
  await p.getByRole('button', { name: 'Start listening' }).click();
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: 'Stop listening' }).click();
  await p.waitForTimeout(2500);
  check('tap-to-cancel: no upload, no AI, no speech', calls.transcribe.length === 0 && calls.assistant === 0 && (await speaks(p)) === 0);

  // 3. Rapid taps.
  const mic = p.locator('button[aria-label="Start listening"], button[aria-label="Stop listening"]').first();
  for (let i = 0; i < 6; i++) { await mic.click(); await p.waitForTimeout(60); }
  await p.waitForTimeout(7500);
  check('rapid taps: no upload, no AI, no speech', calls.transcribe.length === 0 && calls.assistant === 0 && (await speaks(p)) === 0);

  // 4. Navigate while listening.
  await p.getByRole('button', { name: 'Start listening' }).click();
  await p.waitForTimeout(700);
  await p.locator('a[href="/discover"], button:has-text("Compare real shops")').first().click();
  await p.waitForURL(/discover/);
  await p.waitForTimeout(7000);
  const navBar = await bar(p);
  check('navigating while listening: mic released, nothing sent', calls.transcribe.length === 0 && /Ready/.test(navBar), navBar.replace(/\n/g, ' | ') + ' url=' + p.url() + ' t=' + calls.transcribe.length);

  // 5. Interrupt speech by tapping the mic.
  await p.fill('#dq', 'microwave under €150');
  await p.getByRole('button', { name: 'Search' }).click();
  await p.waitForSelector('section[aria-label="Recommended listings"]', { timeout: 40000 });
  await p.getByRole('button', { name: /Read all \d+ listings aloud/ }).click();
  await p.waitForTimeout(200);
  const before = await p.evaluate(() => window.__tts.length);
  await p.getByRole('button', { name: 'Interrupt and speak' }).click();
  await p.waitForTimeout(1500);
  const after = await p.evaluate((n) => window.__tts.slice(n), before);
  check('tapping the mic while speaking cancels speech and listens', after[0]?.t === 'cancel' && !after.some((x) => x.t === 'speak') && /Listening/.test(await bar(p)), JSON.stringify(after.map((x) => x.t)));
  await p.getByRole('button', { name: 'Stop', exact: true }).click();
  await p.waitForTimeout(300);
  check('Stop also stops listening', /Ready|Cancelled/.test(await bar(p)));

  // 6. A search interrupted by "No, show me the cheaper ones": stops speech, re-queries with a lower cap.
  const best = Number((await p.locator('section[aria-label="Recommended listings"] article').first().locator('.font-display.text-3xl').innerText()).replace(/[^\d.]/g, ''));
  await p.getByRole('button', { name: /Read all \d+ listings aloud/ }).click();
  await p.waitForTimeout(200);
  const d0 = calls.discover;
  await p.fill('#dq', 'No, show me the cheaper ones');
  await p.getByRole('button', { name: 'Search' }).click();
  await p.waitForTimeout(800);
  const cancelled = await p.evaluate(() => window.__tts.some((x) => x.t === 'cancel'));
  await p.waitForFunction((n) => true, d0);
  await p.waitForTimeout(6000);
  const prices = await p.locator('section[aria-label="Recommended listings"] article .font-display.text-3xl').allInnerTexts();
  const nums = prices.map((t) => Number(t.replace(/[^\d.]/g, '')));
  check('"No, show me the cheaper ones" stops speech and re-queries Channel3 below the best price', cancelled && calls.discover > d0 && nums.length > 0 && nums.every((n) => n < best), `best was €${best}; now ${JSON.stringify(nums)}`);
});

// 7. Real (synthetic) speech still works end to end: one transcription, one AI call.
if (process.env.SPEECH) await session(process.env.SPEECH, async (p, calls) => {
  await p.goto(`${BASE}/home`);
  await p.getByRole('button', { name: 'Start listening' }).click();
  await p.waitForURL(/shop|discover/, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(1500);
  check('spoken request is transcribed once and acted on', calls.transcribe.length === 1 && calls.transcribe[0].text && calls.assistant === 1, JSON.stringify(calls.transcribe) + ' assistant=' + calls.assistant + ' url=' + p.url());
});
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
