// Visual + accessibility QA of every app screen: axe WCAG 2.2 A/AA, horizontal overflow and
// small touch targets, in default / high-contrast / large-text modes at 320px and 390px.
// Updated for the app shell (Home/Assistant/Activity/Profile tabs). See scripts/qa-ux.mjs for the full shell QA.
// node scripts/qa-screens.mjs [base]   (RECEIPT_COOKIE + RECEIPT_ID for a real captured order)
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const OUT = process.env.OUT ?? '/tmp/qa';
const b = await chromium.launch();
const post = (p, url, body) => p.evaluate(async ([u, x]) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body]);
let problems = 0;
async function audit(p, label) {
  const ax = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const lay = await p.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth > W + 1;
    const small = [...document.querySelectorAll('button, a[href], input, select, textarea, summary')].filter((e) => {
      const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false;
      if (e.tagName === 'A' && getComputedStyle(e).display === 'inline') return false; // inline text links are exempt
      return r.height < 44 || r.width < 44;
    }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 30));
    return { overflow, small };
  });
  const bad = ax.violations.length + (lay.overflow ? 1 : 0);
  problems += bad;
  console.log(`${bad ? 'ISSUE' : 'OK   '} ${label} axe=${ax.violations.length}${ax.violations.length ? ' [' + ax.violations.map((v) => v.id + ':' + v.nodes[0]?.target).join('; ') + ']' : ''} overflow=${lay.overflow} small-targets=${lay.small.length}${lay.small.length ? ' [' + lay.small.slice(0, 5).join(' | ') + ']' : ''}`);
}
for (const width of [320, 390]) for (const mode of ['default', 'contrast', 'large']) {
  const ctx = await b.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  await ctx.addInitScript((m) => { if (m === 'contrast') localStorage.setItem('ss-contrast', 'on'); if (m === 'large') localStorage.setItem('ss-large', 'on'); localStorage.setItem('ss-voice', 'off'); }, mode);
  const p = await ctx.newPage(); const tag = `${width}px ${mode}`;
  await p.goto(BASE + '/'); await p.waitForLoadState('networkidle'); await audit(p, `${tag} landing`);
  await post(p, '/api/demo/start', { name: 'Mary' });
  for (const path of ['/home', '/assistant', '/activity', '/profile', '/help']) { await p.goto(BASE + path); await p.waitForLoadState('networkidle'); await audit(p, `${tag} ${path}`); }
  await p.goto(BASE + '/check'); await p.getByRole('button', { name: /invoice/i }).first().click();
  await p.getByText(/Suspicious|Needs checking/).first().waitFor({ timeout: 45000 }); await audit(p, `${tag} check result`);
  if (mode === 'default') await p.screenshot({ path: `${OUT}/${width}-check.png`, fullPage: true });
  await p.goto(BASE + '/shop'); await p.fill('#q', 'I need a kettle'); await p.getByRole('button', { name: 'Find' }).click();
  await p.getByRole('button', { name: /^Choose / }).first().waitFor({ timeout: 45000 }); await audit(p, `${tag} shop results`);
  if (mode === 'large') await p.screenshot({ path: `${OUT}/${width}-shop-large.png`, fullPage: true });
  await p.getByRole('button', { name: /^Choose / }).first().click(); await p.waitForTimeout(1500); await audit(p, `${tag} shop confirm`);
  const inv = await post(p, '/api/family/invite', {});
  const fctx = await b.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  await fctx.addInitScript((m) => { if (m === 'contrast') localStorage.setItem('ss-contrast', 'on'); if (m === 'large') localStorage.setItem('ss-large', 'on'); }, mode);
  const f = await fctx.newPage(); await f.goto(BASE + '/'); await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
  const big = await post(p, '/api/payments', { items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: `qa-${width}-${mode}-${Date.now()}` });
  await p.goto(`${BASE}/order/${big.body.request.id}`); await p.waitForLoadState('networkidle'); await audit(p, `${tag} order waiting`);
  await f.goto(BASE + '/family'); await f.waitForLoadState('networkidle'); await audit(f, `${tag} family request`);
  if (mode === 'contrast') await f.screenshot({ path: `${OUT}/${width}-family-contrast.png`, fullPage: true });
  await f.getByRole('button', { name: /Decline/ }).first().click(); await f.waitForTimeout(1200);
  await p.reload(); await p.waitForLoadState('networkidle'); await audit(p, `${tag} order declined`);
  await p.goto(`${BASE}/checkout/cancel?token=QA`); await p.waitForLoadState('networkidle'); await audit(p, `${tag} checkout cancel`);
  if (process.env.RECEIPT_COOKIE && process.env.RECEIPT_ID) {
    const rc = await b.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    await rc.addInitScript((m) => { if (m === 'contrast') localStorage.setItem('ss-contrast', 'on'); if (m === 'large') localStorage.setItem('ss-large', 'on'); localStorage.setItem('ss-voice', 'off'); }, mode);
    await rc.addCookies([{ name: 'ss_elder', value: process.env.RECEIPT_COOKIE, url: BASE }]);
    const r = await rc.newPage(); await r.goto(`${BASE}/order/${process.env.RECEIPT_ID}`); await r.waitForLoadState('networkidle'); await audit(r, `${tag} receipt (real capture)`);
    if (mode === 'large') await r.screenshot({ path: `${OUT}/${width}-receipt-large.png`, fullPage: true });
    await rc.close();
  }
  await ctx.close(); await fctx.close();
}
await b.close();
console.log('TOTAL ISSUES', problems);
