// Visual regression: pixel-diffs key pages at 390 px and 1440 px against committed baselines in tests/visual/.
// Uses Playwright's own screenshot comparator (the one behind expect(page).toHaveScreenshot(): pixelmatch,
// threshold 0.2) on a deterministic local stack: built app, MOCK PayPal, recorded Channel3, no AI key, fresh DB.
//
//   npm run build && scripts/local-stack.sh          # start the deterministic stack on :8787
//   node scripts/visual-regression.mjs               # compare (exit 1 on any difference)
//   node scripts/visual-regression.mjs --update      # accept the current look as the new baselines
//   ONLY=profile,home node scripts/visual-regression.mjs
//   scripts/local-stack.sh stop
//
// Determinism: fixed browser clock (10:00 Europe/Dublin, 3 Nov 2026), en-IE locale, reduced motion, voice muted,
// and dates/times rendered from server timestamps are normalised to a fixed string before capture (layout is what
// is under test, not the clock). Failures write <name>.actual.png and <name>.diff.png next to the baseline.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { getComparator } = require('playwright-core/lib/utils');
const compare = getComparator('image/png');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../tests/visual');
const UPDATE = process.argv.includes('--update');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const WIDTHS = [390, 1440];
const MAX_H = 6000; // long pages (Help) are compared on their first 6000 px
const OPTS = { threshold: 0.2, maxDiffPixelRatio: 0.002 }; // anti-aliasing noise only
fs.mkdirSync(DIR, { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', locale: 'en-IE', timezoneId: 'Europe/Dublin', deviceScaleFactor: 1 });
await ctx.addInitScript(() => localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, mutedByUser: true, autoSpeak: true, rate: 0.95, readAll: false, lang: 'en' })));
const p = await ctx.newPage();
await p.clock.setFixedTime(new Date('2026-11-03T10:00:00Z'));
const post = (u, body) => p.evaluate(async ([url, x]) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return r.json().catch(() => ({})); }, [u, body]);
const go = async (u) => { await p.goto(BASE + u); await p.waitForLoadState('networkidle'); await p.waitForTimeout(300); };

async function normalise() {
  // Lazy images below the fold would otherwise load (or not) depending on timing: load them all first.
  await p.evaluate(async () => {
    const imgs = [...document.images];
    imgs.forEach((i) => { if (i.loading === 'lazy') { i.loading = 'eager'; const src = i.src; i.src = ''; i.src = src; } });
    await Promise.all(imgs.map((i) => Promise.race([i.decode().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])));
  });
  await p.evaluate(() => {
    const M = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
    const rules = [
      [new RegExp(`\\b\\d{1,2} ${M}( \\d{4})?(,? \\d{1,2}:\\d{2})?`, 'g'), '1 Jan, 09:00'],
      [new RegExp(`\\b${M} \\d{1,2}(, \\d{4})?`, 'g'), 'Jan 1'],
      [/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '09:00'],
      [/\b\d{4}-\d{2}-\d{2}\b/g, '2026-01-01'],
      [/\bin \d+ days?\b/g, 'in 9 days'], [/\b\d+ days? ago\b/g, '9 days ago'],
      [/\b(today|yesterday|tomorrow)\b/gi, 'today'],
      [/\b(pay|req|ord|sub|ct|rec)_[A-Za-z0-9_-]{4,}\b/g, '$1_xxxxxxxx'],
      [/\b[A-Z0-9]{17}\b/g, 'XXXXXXXXXXXXXXXXX'],
    ];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) { let t = n.nodeValue; for (const [re, s] of rules) t = t.replace(re, s); if (t !== n.nodeValue) n.nodeValue = t; }
    document.querySelectorAll('input[type="date"]').forEach((i) => { i.value = ''; });
  });
}

const results = [];
async function check(name) {
  if (ONLY && !ONLY.has(name)) return;
  for (const w of WIDTHS) {
    await p.setViewportSize({ width: w, height: w < 768 ? 844 : 900 });
    await p.waitForTimeout(300);
    await normalise();
    const st = await p.addStyleTag({ content: 'header.sticky{position:static!important}[data-testid="bottom-stack"]{position:static!important}div[style*="--stack-h"]{padding-bottom:0!important}*{caret-color:transparent!important}' });
    const h = await p.evaluate(() => document.documentElement.scrollHeight);
    const shot = await p.screenshot({ fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width: w, height: Math.min(h, MAX_H) } });
    await st.evaluate((e) => e.remove());
    const file = path.join(DIR, `${name}-${w}.png`);
    if (UPDATE || !fs.existsSync(file)) { fs.writeFileSync(file, shot); results.push({ name: `${name}-${w}`, status: UPDATE ? 'updated' : 'new baseline' }); continue; }
    const r = compare(shot, fs.readFileSync(file), OPTS);
    for (const ext of ['actual', 'diff']) fs.rmSync(file.replace(/\.png$/, `.${ext}.png`), { force: true });
    if (r) {
      fs.writeFileSync(file.replace(/\.png$/, '.actual.png'), shot);
      if (r.diff) fs.writeFileSync(file.replace(/\.png$/, '.diff.png'), r.diff);
      results.push({ name: `${name}-${w}`, status: 'DIFF', info: r.errorMessage });
    } else results.push({ name: `${name}-${w}`, status: 'ok' });
  }
}
const last = (k) => p.locator(`[data-card="${k}"]`).last();
async function say(text, kind) { await p.fill('#assistant-input', text); await p.keyboard.press('Enter'); await last(kind).waitFor({ timeout: 20000 }); await p.waitForTimeout(500); }

try {
  await go('/'); await check('landing');
  await post('/api/demo/start', { name: 'Mary' });
  await go('/home'); await check('home');
  await go('/activity'); await check('activity');
  await go('/profile'); await check('profile');
  await go('/help'); await check('help');
  await go('/assistant'); await p.locator('#assistant-input').waitFor({ timeout: 20000 });
  await say('Show my subscriptions', 'subscriptions_list');
  await say('Show my contacts', 'contact_card');
  await check('assistant');
  await go('/check'); await p.getByRole('button', { name: /Account suspended/i }).first().click();
  await p.getByText(/Suspicious|Needs checking/).first().waitFor({ timeout: 20000 }); await check('scam-result');
  await go('/discover'); await p.fill('#dq', 'microwave'); await p.keyboard.press('Enter');
  await p.getByRole('heading', { level: 3 }).first().waitFor({ timeout: 20000 }).catch(() => {}); await p.waitForTimeout(800); await check('product-results');
  const big = await post('/api/payments', { items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: `vr-${Date.now()}` });
  if (big.request?.id) { await go(`/order/${big.request.id}`); await check('order-waiting'); }
  await post('/api/demo/alex', {});
  await go('/family/assistant'); await last('family_review').waitFor({ timeout: 20000 }).catch(() => {}); await check('family-review');
  await go('/family/insights'); await p.waitForTimeout(800); await check('family-insights');
} finally { await b.close(); }

for (const r of results) console.log(`${r.status.padEnd(12)} ${r.name}${r.info ? ` — ${r.info}` : ''}`);
const failed = results.filter((r) => r.status === 'DIFF');
console.log(failed.length ? `\n${failed.length} visual difference(s). See tests/visual/*.diff.png; run with --update if the change is intended.` : `\nAll ${results.length} screenshots match.`);
process.exit(failed.length ? 1 : 0);
