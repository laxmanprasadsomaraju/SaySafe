// Insights v2 browser check (mock mode, local server): Mary /insights + Alex /family/insights, axe, 390/320 overflow, links.
// node scripts/insights-v2-qa.mjs http://127.0.0.1:8900 /tmp/insights-v2
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8900';
const OUT = process.argv[3] ?? '/tmp/insights-v2';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
let fails = 0;
const check = (n, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); };
const post = (p, url, body) => p.evaluate(async ([u, x]) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body]);
const axe = async (p, label) => { const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze(); check(`axe ${label}`, r.violations.length === 0, r.violations.map((v) => `${v.id}:${v.nodes.length}:${v.nodes[0]?.target}`).join('; ')); };
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

const mctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await mctx.addInitScript(() => localStorage.setItem('ss-voice', 'off'));
const m = await mctx.newPage();
await m.goto(BASE + '/');
check('Try as Mary', (await post(m, '/api/demo/start', { name: 'Mary' })).status === 200);
// Something to look at (Demo Shop search via the Assistant, rules mode) and a real scam check.
const a1 = await post(m, '/api/assistant', { text: 'Show me kettles in the Demo Shop' });
check('assistant demo search', a1.status === 200, `${a1.body?.products?.length ?? 0} products`);
const sc = await post(m, '/api/scan', { text: 'URGENT: your bank account is locked. Verify your card number and PIN now at http://bank-secure-verify.xyz today.' });
check('real scam check', sc.status === 200, sc.body?.verdict);

for (const w of [1440, 390, 320]) {
  await m.setViewportSize({ width: w, height: 900 });
  await m.goto(BASE + '/insights');
  await m.getByRole('heading', { name: 'Purchases, by outcome' }).waitFor({ timeout: 20000 });
  await m.waitForTimeout(400);
  const t = await m.textContent('main');
  if (w === 1440) {
    check('glance tiles', /Paid \(PayPal Sandbox\)/.test(t) && /Products looked at/.test(t) && /Flagged as possibly risky/.test(t) && /Trusted contacts/.test(t));
    check('sections present', ['Shopping: looked at and bought', 'Trusted contacts', 'Cancelled', 'Safety', 'Purchases, by outcome'].every((h) => t.includes(h)));
    check('sample labelled', /Sample data/.test(t) && /Real Sandbox/.test(t) && /never added together/.test(t));
    check('no forbidden claims', !/saved from hackers|time saved|prevented fraud|fraud prevented|money saved/i.test(t));
    const sum = await m.evaluate(async () => (await fetch('/api/insights/summary')).json());
    check('funnel counted the search', sum.shopping.productsLooked > 0 && sum.shopping.searches > 0, JSON.stringify(sum.shopping).slice(0, 160));
    check('flag counted', sum.scamChecks.real.suspicious + sum.scamChecks.real.needsChecking > 0);
    check('page shows funnel number', t.includes(`${sum.shopping.productsLooked}`));
  }
  check(`${w}px no horizontal overflow`, !(await overflow(m)));
  if (w !== 320) { await m.screenshot({ path: `${OUT}/mary-insights-${w}.png`, fullPage: true }); await axe(m, `/insights ${w}`); }
}
// Links to Insights
await m.setViewportSize({ width: 1440, height: 900 });
await m.goto(BASE + '/home'); await m.getByTestId('home-insights').waitFor({ timeout: 20000 });
check('Home → View insights link', (await m.locator('[data-testid="home-insights"] a[href="/insights"]').count()) === 1);
check('desktop nav Insights link', (await m.locator('header a[href="/insights"], nav a[href="/insights"]').count()) >= 1);
await m.locator('[data-testid="home-insights"] a[href="/insights"]').click();
await m.getByRole('heading', { name: 'Your insights' }).waitFor({ timeout: 15000 });
check('Home link opens /insights', new URL(m.url()).pathname === '/insights');

// Alex
const r = await post(m, '/api/demo/alex', {});
check('Try as Alex', r.status === 200);
const fstate = await mctx.storageState();
const fctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', storageState: { ...fstate, cookies: fstate.cookies.filter((c) => c.name !== 'ss_elder') } });
const f = await fctx.newPage();
for (const w of [1440, 390, 320]) {
  await f.setViewportSize({ width: w, height: 900 });
  await f.goto(BASE + '/family/insights'); await f.getByText('Payment ledger').waitFor({ timeout: 20000 }); await f.waitForTimeout(400);
  const t = await f.textContent('main');
  if (w === 1440) check('Alex view has none of Mary\'s private data', !/Sarah|Pat Doyle|Riverside Pharmacy|StreamBox|TuneWave|Different products you looked at|Trusted contacts|bank-secure-verify/i.test(t));
  check(`Alex ${w}px no overflow`, !(await overflow(f)));
  if (w !== 320) { await f.screenshot({ path: `${OUT}/alex-family-insights-${w}.png`, fullPage: true }); await axe(f, `/family/insights ${w}`); }
}
const fs2 = await f.evaluate(async () => (await fetch('/api/insights/summary?as=family')).json());
check('family summary: shopping/contacts/cancelled null', fs2.shopping === null && fs2.contacts === null && fs2.cancelled === null);
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
