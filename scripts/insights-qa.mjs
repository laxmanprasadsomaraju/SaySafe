// Insights QA against a running local server (see docs/AG-STUDIO.md).
//   PHASE=native          INSIGHTS_DASHBOARD=native server: native dashboard (390/1440 screenshots + axe), studio route
//                          must redirect, and the existing family / order / receipt / home pages still work.
//   PHASE=studio-blocked  INSIGHTS_DASHBOARD=agstudio server, build WITHOUT a licence ("licence expired"): must fall back.
//   PHASE=studio          INSIGHTS_DASHBOARD=agstudio server, build with VITE_AG_STUDIO_LOCAL_EVAL=1: AG Studio screenshots.
// node scripts/insights-qa.mjs [base]
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const OUT = process.env.OUT ?? '/tmp/insights-qa';
const PHASE = process.env.PHASE ?? 'native';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const post = (p, url, body) => p.evaluate(async ([u, x]) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body]);
const errorsOf = (p) => { const errs = []; p.on('pageerror', (e) => errs.push(String(e))); return errs; };

// ---- household: Mary (elder) + Alex (family), real requests via the API, then labelled example rows ----
const ectx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await ectx.addInitScript(() => localStorage.setItem('ss-voice', 'off'));
const mary = await ectx.newPage();
await mary.goto(BASE + '/'); await post(mary, '/api/demo/start', { name: 'Mary' });
const inv = await post(mary, '/api/family/invite', {});
const fctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const alex = await fctx.newPage(); await alex.goto(BASE + '/');
check('Alex pairs', (await post(alex, '/api/family/pair', { code: inv.body.code, name: 'Alex' })).status === 200);
const k = () => `qa-ins-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const reqs = [];
for (const productId of ['microwave', 'microwave', 'microwave']) reqs.push((await post(mary, '/api/payments', { items: [{ productId, quantity: 1 }], idempotencyKey: k() })).body.request);
check('3 real requests wait for family approval', reqs.every((r) => r?.state === 'FAMILY_APPROVAL_PENDING'), reqs.map((r) => r?.state).join(','));
await post(alex, `/api/family/requests/${reqs[0].id}/decision`, { decision: 'approve', approvalId: reqs[0].approval.id });
await post(alex, `/api/family/requests/${reqs[1].id}/decision`, { decision: 'decline', approvalId: reqs[1].approval.id, reason: 'Let us talk first' });
const scan = await post(mary, '/api/scan', { text: 'URGENT: your PayPal account is limited. Verify now at http://paypa1-secure-login.example.com or it will be closed today.' });
check('real scam check runs', scan.status === 200, scan.body.verdict);
check('real scam check shared', (await post(mary, `/api/scan/${scan.body.scanId}/share`, {})).status === 200);
if (process.env.DATABASE_FILE) {
  console.log(execSync('npx tsx scripts/seed-insights-demo.ts', { env: { ...process.env }, encoding: 'utf8' }).trim());
}

async function axe(p, label) {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  check(`axe ${label}`, r.violations.length === 0, r.violations.map((v) => `${v.id}:${v.nodes.length}:${v.nodes[0]?.target}`).join('; '));
  return r.violations;
}
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

if (PHASE === 'native' || PHASE === 'studio-blocked') {
  for (const width of [390, 1440]) {
    const ctx = await b.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', storageState: await fctx.storageState() });
    const p = await ctx.newPage(); const errs = errorsOf(p);
    await p.goto(BASE + '/family/insights'); await p.getByText('Payment ledger').waitFor({ timeout: 20000 }); await p.waitForTimeout(500);
    const body = await p.textContent('main');
    check(`${width}px native shows real states, approvals, scans and labels`, /Waiting for family/.test(body) && /Family: approved/.test(body) && /Family: declined/.test(body) && /PayPal sandbox/.test(body) && /Example data/.test(body) && /looks like a scam|suspicious|Suspicious|Example:/i.test(body));
    check(`${width}px native has a sortable table with aria-sort`, (await p.locator('th[aria-sort]').count()) >= 5);
    check(`${width}px pending links to the existing approval page`, (await p.locator('a[href="/family#pending-h"]').count()) > 0);
    check(`${width}px no AG Studio on native`, (await p.locator('[class*="ag-studio"], [class*="ag-root"]').count()) === 0 && !/AG Studio view/.test(body));
    check(`${width}px native no horizontal overflow`, !(await overflow(p)));
    await p.getByRole('button', { name: /Date/ }).click();
    check(`${width}px sort toggles aria-sort`, (await p.locator('th[aria-sort="ascending"]').count()) === 1);
    await p.fill('#ledger-q', 'microwave');
    check(`${width}px search filters rows`, (await p.locator('tbody tr').count()) >= 1 && !(/Reading lamp/.test(await p.textContent('tbody'))));
    await p.fill('#ledger-q', '');
    if (width === 1440) {
      await p.getByRole('button', { name: 'Which purchases are waiting for my approval?' }).click();
      await p.getByText(/waiting for your decision/).first().waitFor({ timeout: 20000 });
      check('native ask box answers from own data', /purchase is waiting for your decision|purchases are waiting/.test(await p.textContent('main')));
    }
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300); await p.screenshot({ path: `${OUT}/insights-native-${width}.png`, fullPage: true });
    await axe(p, `${width}px native`);
    await p.goto(BASE + '/family/insights/studio'); await p.waitForURL(/\/family\/insights$/, { timeout: 15000 });
    check(`${width}px ${PHASE}: /family/insights/studio falls back to native`, p.url().endsWith('/family/insights'), p.url());
    check(`${width}px no page errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // Existing screens still work with AG Studio off.
  const fam = await fctx.newPage(); const famErrs = errorsOf(fam);
  await fam.goto(BASE + '/family'); await fam.getByText(/Waiting for you/).waitFor({ timeout: 15000 });
  check('family approval page renders pending request with Approve/Decline', (await fam.getByRole('button', { name: /Approve/ }).count()) >= 1 && (await fam.getByRole('button', { name: /Decline/ }).count()) >= 1);
  check('family page links to insights', (await fam.locator('a[href="/family/insights"]').count()) === 1);
  check('family page shows no AG-specific link', (await fam.locator('a[href="/family/insights/studio"]').count()) === 0);
  check('family page no errors', famErrs.length === 0, famErrs.join(' | '));
  const hist = await post(mary, '/api/payments', undefined).catch(() => null);
  void hist;
  const list = await mary.evaluate(async () => (await fetch('/api/payments')).json());
  check('elder payment history API works', Array.isArray(list) && list.length >= 3, `${list.length} rows`);
  for (const r of reqs) {
    const errs = errorsOf(mary);
    await mary.goto(`${BASE}/order/${r.id}`); await mary.waitForLoadState('networkidle');
    const t = await mary.textContent('main');
    check(`order page ${r.id.slice(-6)} renders`, /Waiting for family|Family approved|Cancelled|declined|PayPal/i.test(t) && errs.length === 0);
  }
  const seeded = list.find((x) => x.state === 'CAPTURED');
  if (seeded) {
    await mary.goto(`${BASE}/order/${seeded.id}`); await mary.waitForLoadState('networkidle');
    check('receipt page renders for a captured (example) payment', /Paid|receipt|successful/i.test(await mary.textContent('main')));
    await mary.screenshot({ path: `${OUT}/receipt-flag-off.png`, fullPage: true });
  }
  await mary.goto(BASE + '/home'); await mary.waitForLoadState('networkidle');
  check("Mary's home renders", /Mary/.test(await mary.textContent('main')));
}

if (PHASE === 'studio') {
  for (const width of [390, 1440]) {
    const ctx = await b.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', storageState: await fctx.storageState() });
    const p = await ctx.newPage(); const errs = errorsOf(p);
    const logs = []; p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(m.text().slice(0, 200)); });
    await p.goto(BASE + '/family/insights/studio');
    await p.getByText('Ask the read-only insights agent').waitFor({ timeout: 30000 });
    await p.waitForTimeout(8000);
    check(`${width}px AG Studio route stays on /studio`, p.url().endsWith('/family/insights/studio'), p.url());
    const t = await p.textContent('body');
    check(`${width}px custom widgets render`, /Protection Activity/.test(t) && /Awaiting My Decision/.test(t) && /Payment Evidence/.test(t));
    if (width === 1440) {
      await p.getByRole('button', { name: 'Show transactions that were declined' }).click();
      const ans = p.locator('section[aria-labelledby="ask-studio-h"] p.bg-teal-soft');
      await ans.waitFor({ timeout: 20000 });
      check('AG agent (custom runner) answers from own data', /purchase was declined/.test(await ans.textContent()), await ans.textContent());
    }
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300); await p.screenshot({ path: `${OUT}/insights-studio-${width}.png`, fullPage: true });
    console.log(`${width}px console:`, [...new Set(logs)].slice(0, 12).join('\n   '));
    check(`${width}px studio no page errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
}

await b.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
