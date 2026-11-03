// Voice + Discover QA. Stubs speechSynthesis and checks: Stop cancels, no overlap, navigation cancels,
// no automatic full-page reading, read-everything is stoppable; screenshots + axe.
// Usage: BASE=http://127.0.0.1:8788 OUT=/tmp/shots node scripts/qa-voice.mjs
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8788';
const OUT = process.env.OUT ?? '/tmp/shots'; fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const stub = () => {
  const log = []; let active = null; let overlap = 0; let maxConcurrent = 0;
  window.__tts = { log, get overlap() { return overlap; }, get max() { return maxConcurrent; } };
  class U { constructor(t) { this.text = t; this.onend = null; this.onerror = null; this.rate = 1; this.lang = ''; } }
  const synth = {
    paused: false, speaking: false,
    speak(u) { if (active) overlap++; log.push({ t: 'speak', text: u.text, at: performance.now() }); active = u; maxConcurrent = Math.max(maxConcurrent, 1 + (overlap ? 1 : 0));
      const me = u; setTimeout(() => { if (active === me) { active = null; me.onend && me.onend({}); } }, 400); },
    cancel() { log.push({ t: 'cancel', at: performance.now() }); const a = active; active = null; if (a && a.onerror) a.onerror({ error: 'interrupted' }); },
    pause() { log.push({ t: 'pause' }); }, resume() { log.push({ t: 'resume' }); }, getVoices: () => [],
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = U;
};

const b = await chromium.launch();
for (const [w, h] of [[390, 844], [1440, 900]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
  await ctx.addInitScript(stub);
  // The sandbox browser has no direct internet: fetch Channel3 CDN images from Node (which honours the proxy).
  await ctx.route('https://cdn.trychannel3.com/**', async (route) => {
    try { const r = await fetch(route.request().url()); await route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'image/png' }, body: Buffer.from(await r.arrayBuffer()) }); }
    catch { await route.abort(); }
  });
  const p = await ctx.newPage();
  await p.request.post(`${BASE}/api/demo/start`, { data: {} });
  await p.goto(`${BASE}/discover`);
  await p.fill('#dq', 'Find me a microwave under €150');
  await p.getByRole('button', { name: 'Search' }).click();
  await p.waitForSelector('section[aria-label="Recommended listings"], [role=alert]', { timeout: 40000 });
  await p.waitForTimeout(2500);
  const log1 = await p.evaluate(() => window.__tts.log.filter((x) => x.t === 'speak').map((x) => x.text));
  const caption = await p.locator('[role=status]').first().innerText().catch(() => '');
  if (w === 390) {
    check('auto-speech is only the short summary (no listing-by-listing reading)', log1.length > 0 && log1.length <= 5 && !log1.some((t) => /^Listing \d/.test(t)), JSON.stringify(log1));
    check('spoken summary starts with one recommendation', /^My best match is/.test(log1[0] ?? ''), log1[0]);
  }
  await p.evaluate(async () => { for (const i of document.images) i.loading = 'eager'; await new Promise((r) => setTimeout(r, 2000)); });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const broken = await p.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length);
  const axe = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  check(`axe ${w}px: 0 serious/critical`, serious.length === 0, axe.violations.map((v) => `${v.id}:${v.impact}(${v.nodes.length})`).join(', ') || 'no violations');
  check(`no horizontal overflow ${w}px`, overflow <= 0, `overflow=${overflow}, broken images=${broken}`);
  await p.screenshot({ path: `${OUT}/voice-discover-${w}.png`, fullPage: true });

  if (w === 390) {
    // Start a long read (explicit), screenshot speaking state, then Stop.
    await p.getByRole('button', { name: /Read all \d+ listings aloud/ }).click();
    await p.waitForTimeout(150);
    await p.screenshot({ path: `${OUT}/voice-speaking-390.png` });
    const before = await p.evaluate(() => window.__tts.log.length);
    await p.getByRole('button', { name: 'Stop speaking' }).click();
    await p.waitForTimeout(1500);
    const after = await p.evaluate((n) => window.__tts.log.slice(n), before);
    // A sentence may legitimately start between reading the log and the click; what matters is nothing after the cancel.
    const ci = after.findIndex((x) => x.t === 'cancel');
    check('Stop cancels and nothing else is spoken afterwards', ci >= 0 && !after.slice(ci).some((x) => x.t === 'speak'), JSON.stringify(after.map((x) => x.t)));
    check('Stop button disabled once stopped', await p.getByRole('button', { name: 'Stop', exact: true }).isDisabled());

    // Pause / resume.
    await p.getByRole('button', { name: /Read all \d+ listings aloud/ }).click();
    await p.waitForTimeout(100);
    await p.getByRole('button', { name: 'Pause speaking' }).click();
    const chipPaused = await p.locator('[aria-label="Voice controls"]').innerText();
    const nPause = await p.evaluate(() => window.__tts.log.length);
    await p.waitForTimeout(900);
    const nAfterPause = await p.evaluate(() => window.__tts.log.length);
    check('Pause stops sound and stays paused', /Paused/.test(chipPaused) && nPause === nAfterPause);
    await p.getByRole('button', { name: 'Resume speaking' }).click();
    await p.waitForTimeout(100);
    check('Resume continues from the current sentence', await p.evaluate(() => window.__tts.log.at(-1).t === 'speak'));

    // Escape stops.
    await p.keyboard.press('Escape');
    await p.waitForTimeout(600);
    check('Escape stops speech', /Ready|Muted/.test(await p.locator('[aria-label="Voice controls"]').innerText()));

    // Navigation cancels.
    await p.getByRole('button', { name: /Read all \d+ listings aloud/ }).click();
    await p.waitForTimeout(100);
    const nNav = await p.evaluate(() => window.__tts.log.length);
    await p.getByRole('link', { name: 'Home' }).first().click();
    await p.waitForURL(/\/home/);
    await p.waitForTimeout(1500);
    const navLog = await p.evaluate((n) => window.__tts.log.slice(n), nNav);
    const ni = navLog.findIndex((x) => x.t === 'cancel');
    check('Navigation cancels speech', ni >= 0 && !navLog.slice(ni).some((x) => x.t === 'speak'), JSON.stringify(navLog.map((x) => x.t)));

    // Mute blocks auto speech; mic button barge-in is covered by unit tests (no mic in headless).
    await p.goto(`${BASE}/discover`);
    await p.getByRole('button', { name: 'Mute voice' }).click();
    const nMute = await p.evaluate(() => window.__tts.log.length);
    await p.fill('#dq', 'kettle under €40');
    await p.getByRole('button', { name: 'Search' }).click();
    await p.waitForSelector('section[aria-label="Recommended listings"], [role=alert]', { timeout: 40000 });
    await p.waitForTimeout(1000);
    check('Muted: no automatic speech', !(await p.evaluate((n) => window.__tts.log.slice(n).some((x) => x.t === 'speak'), nMute)));
    await p.getByRole('button', { name: 'Unmute voice' }).click();

    // Read everything mode: reads each listing, still stoppable instantly.
    await p.getByRole('button', { name: 'Voice settings' }).click();
    await p.getByLabel(/Read entire results/).check();
    await p.getByRole('button', { name: 'Voice settings' }).click();
    const nRA = await p.evaluate(() => window.__tts.log.length);
    await p.fill('#dq', 'Find me a microwave under €150');
    await p.getByRole('button', { name: 'Search' }).click();
    await p.waitForSelector('section[aria-label="Recommended listings"]', { timeout: 40000 });
    await p.waitForFunction((n) => window.__tts.log.slice(n).some((x) => x.t === 'speak' && /^Listing 1 of/.test(x.text)), nRA, { timeout: 15000 }).catch(() => {});
    await p.screenshot({ path: `${OUT}/voice-readall-390.png` });
    const bar = await p.locator('[aria-label="Voice controls"]').innerText();
    check('Read everything shows a visible state', /Reading all/.test(bar), bar.replace(/\n/g, ' | '));
    const nStop = await p.evaluate(() => window.__tts.log.length);
    await p.getByRole('button', { name: 'Stop speaking' }).click();
    await p.waitForTimeout(1500);
    check('Read everything is stoppable', !(await p.evaluate((n) => window.__tts.log.slice(n).some((x) => x.t === 'speak'), nStop)));

    const overlap = await p.evaluate(() => window.__tts.overlap);
    check('Never two utterances at once (speak always after cancel/end)', overlap === 0, `overlap=${overlap}`);

    // Compare + follow-up.
    await p.fill('#dq', 'which has better specifications?');
    await p.getByRole('button', { name: 'Search' }).click();
    await p.waitForTimeout(500);
    check('Follow-up "better specifications" opens comparison of real fields', await p.locator('table caption', { hasText: 'Side by side' }).count() === 1);
    await p.screenshot({ path: `${OUT}/voice-compare-390.png`, fullPage: true });
    await p.fill('#dq', 'stop talking');
    await p.getByRole('button', { name: 'Search' }).click();
    await p.waitForTimeout(300);
    check('"stop talking" stops', /Ready|Muted/.test(await p.locator('[aria-label="Voice controls"]').innerText()));

    // Preferences page axe.
    await p.goto(`${BASE}/preferences`);
    await p.getByLabel('Favourite colours').fill('white');
    await p.getByRole('button', { name: 'Save my preferences' }).click();
    await p.waitForSelector('text=Saved');
    const axeP = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    check('axe /preferences: 0 serious/critical', !axeP.violations.some((v) => ['serious', 'critical'].includes(v.impact)), axeP.violations.map((v) => `${v.id}:${v.impact}`).join(', ') || 'no violations');
    await p.screenshot({ path: `${OUT}/voice-preferences-390.png`, fullPage: true });
  }
  await ctx.close();
}
await b.close();
fs.writeFileSync(`${OUT}/voice-qa.json`, JSON.stringify(results, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
