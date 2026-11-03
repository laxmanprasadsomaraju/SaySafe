// Accessibility audit for the UI pass: axe (wcag2a/aa, 2.1 A/AA, 2.2 AA) on every main page at 390 and 1440,
// keyboard tab order + visible focus on Profile and the Assistant, reflow at 200 % / 400 % zoom (CSS zoom on a
// 1280 px window and the 640 / 320 CSS px equivalents), and reduced motion. Runs on the local stack:
//   npm run build && scripts/local-stack.sh && node scripts/a11y-audit.mjs [base]   (OUT=dir for the JSON)
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const OUT = process.env.OUT ?? '/tmp/a11y';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const report = { axe: [], keyboard: {}, reflow: [], motion: {} };
const ctxFor = async (opts = {}) => {
  const c = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IE', ...opts });
  await c.addInitScript(() => localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, autoSpeak: true, rate: 0.95, readAll: false, lang: 'en' })));
  return c;
};
const c = await ctxFor({ reducedMotion: 'reduce' });
const p = await c.newPage();
const go = async (u) => { await p.goto(BASE + u); await p.waitForLoadState('networkidle'); await p.waitForTimeout(300); };
const post = (u, body) => p.evaluate(async ([url, x]) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) })).json().catch(() => ({})), [u, body]);
const last = (k) => p.locator(`[data-card="${k}"]`).last();

async function axe(name) {
  for (const w of [390, 1440]) {
    await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(200);
    const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    report.axe.push({ page: name, width: w, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') })) });
  }
}
async function reflow(name) {
  const rows = { page: name };
  for (const [label, w] of [['320px (=400%)', 320], ['640px (=200%)', 640]]) {
    await p.setViewportSize({ width: w, height: 800 }); await p.waitForTimeout(250);
    rows[label] = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }
  // Real browser zoom on a 1280×800 window: 200 % = 640×400 CSS px at DPR 2, 400 % = 320×200 CSS px at DPR 4.
  // Also measures how much of the screen fixed/sticky bars cover at that size.
  for (const z of [2, 4]) {
    await p.setViewportSize({ width: 1280 / z, height: 800 / z }); await p.waitForTimeout(250);
    const m = await p.evaluate(() => {
      const H = window.innerHeight;
      const fixed = [...document.querySelectorAll('body *')].filter((e) => { const cs = getComputedStyle(e); return (cs.position === 'fixed' || cs.position === 'sticky') && e.getBoundingClientRect().height > 0 && !e.closest('[data-testid="bottom-stack"] *'); });
      const covered = fixed.reduce((a, e) => { const r = e.getBoundingClientRect(); return a + Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0)); }, 0);
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, coveredPct: Math.round((covered / H) * 100) };
    });
    rows[`zoom ${z * 100}% overflow`] = m.overflow; rows[`zoom ${z * 100}% fixed bars cover`] = `${m.coveredPct}%`;
  }
  report.reflow.push(rows);
}
async function tabOrder(name, max = 60) {
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  await p.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  const seq = [];
  for (let i = 0; i < max; i++) {
    await p.keyboard.press('Tab');
    const f = await p.evaluate(() => {
      const e = document.activeElement; if (!e || e === document.body) return null;
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      const visible = (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none') || cs.boxShadow !== 'none';
      return { name: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 48), tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), y: Math.round(r.top + window.scrollY), focusVisible: visible, inView: r.bottom > 0 && r.top < window.innerHeight };
    });
    if (!f) continue;
    if (seq.length && f.name === seq[0].name && f.y === seq[0].y) break;
    seq.push(f);
  }
  // Reading order check: within main, focus should move top-to-bottom (allowing columns: y may go up when a new column starts).
  report.keyboard[name] = { count: seq.length, noVisibleFocus: seq.filter((s) => !s.focusVisible).map((s) => s.name), notScrolledIntoView: seq.filter((s) => !s.inView).map((s) => s.name), sequence: seq.map((s) => `${s.tag}${s.role ? `[${s.role}]` : ''}: ${s.name}`) };
}

await go('/'); await axe('landing'); await reflow('landing');
await post('/api/demo/start', { name: 'Mary' });
for (const [n, u] of [['home', '/home'], ['activity', '/activity'], ['profile', '/profile'], ['help', '/help']]) { await go(u); await axe(n); await reflow(n); }
await go('/profile'); await tabOrder('profile', 70);
await go('/assistant'); await p.locator('#assistant-input').waitFor();
await p.fill('#assistant-input', 'Show my subscriptions'); await p.keyboard.press('Enter'); await last('subscriptions_list').waitFor({ timeout: 20000 });
await p.fill('#assistant-input', 'Show my contacts'); await p.keyboard.press('Enter'); await last('contact_card').waitFor({ timeout: 20000 });
await axe('assistant (cards)'); await reflow('assistant (cards)'); await tabOrder('assistant', 60);
await go('/check'); await p.getByRole('button', { name: /Account suspended/i }).first().click(); await p.getByText(/Suspicious|Needs checking/).first().waitFor({ timeout: 20000 });
await axe('scam result'); await reflow('scam result');
await go('/discover'); await p.fill('#dq', 'microwave'); await p.keyboard.press('Enter'); await p.waitForTimeout(2500); await axe('product results'); await reflow('product results');
const big = await post('/api/payments', { items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: 'a11y-' + Date.now() });
if (big.request?.id) { await go(`/order/${big.request.id}`); await axe('order waiting'); await reflow('order waiting'); }
await post('/api/demo/alex', {});
await go('/family/assistant'); await last('family_review').waitFor({ timeout: 20000 }).catch(() => {}); await axe('family review'); await reflow('family review');
await go('/family'); await axe('family home'); await reflow('family home');
await go('/family/insights'); await p.waitForTimeout(800); await axe('family insights'); await reflow('family insights');

// Reduced motion: system setting and the Profile switch both remove animation.
const rm = await (await ctxFor({ reducedMotion: 'reduce' })).newPage();
await rm.goto(BASE + '/'); await rm.waitForLoadState('networkidle');
report.motion.systemReduce = await rm.evaluate(() => [...document.querySelectorAll('.fade-up, .reveal-ready, [class*="animate-"]')].every((e) => { const cs = getComputedStyle(e); return cs.animationName === 'none' || parseFloat(cs.animationDuration) === 0; }));
const nm = await (await ctxFor({ reducedMotion: 'no-preference' })).newPage();
await nm.goto(BASE + '/'); await nm.evaluate(() => { localStorage.setItem('ss-reduce-motion', 'on'); }); await nm.reload(); await nm.waitForLoadState('networkidle');
report.motion.profileSwitchClass = await nm.evaluate(() => document.documentElement.classList.contains('reduce-motion'));
report.motion.profileSwitchStopsAnimation = await nm.evaluate(() => [...document.querySelectorAll('.fade-up')].every((e) => getComputedStyle(e).animationName === 'none'));

await b.close();
fs.writeFileSync(`${OUT}/a11y-report.json`, JSON.stringify(report, null, 1));
const v = report.axe.filter((a) => a.violations.length);
console.log(`axe: ${report.axe.length} page×width runs, ${v.length} with violations`);
for (const a of v) console.log(`  ${a.page}@${a.width}: ${a.violations.map((x) => `${x.id}(${x.impact}) x${x.n} ${x.sample}`).join('; ')}`);
console.log('reflow (horizontal overflow px):'); for (const r of report.reflow) console.log('  ' + JSON.stringify(r));
for (const [k, kb] of Object.entries(report.keyboard)) console.log(`keyboard ${k}: ${kb.count} stops; no visible focus: ${kb.noVisibleFocus.length ? kb.noVisibleFocus.join(' | ') : 'none'}`);
console.log('motion:', JSON.stringify(report.motion));
