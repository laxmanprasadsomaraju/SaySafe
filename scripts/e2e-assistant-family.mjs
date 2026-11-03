// Browser flow test of the in-Assistant family review, against a LOCAL server wired to scripts/mock-paypal.mjs
// (no PayPal keys needed; PayPal itself is NOT exercised: the test stops at the sandbox.paypal.com redirect URL,
// then simulates approval on the mock and follows the return URL). Flows: Mary asks -> Alex approves in HIS Assistant ->
// Mary's card offers Continue to PayPal -> redirect URL -> return -> receipt card + refund request + history search;
// then decline, then expired. Every card is screenshotted to $OUT and audited with axe.
//
//   node scripts/mock-paypal.mjs 9999 &
//   DATABASE_FILE=/tmp/pol/e2e.db PORT=8787 PAYPAL_API_BASE=http://127.0.0.1:9999 PAYPAL_ALLOW_LIVE=yes PAYPAL_CLIENT_ID=mock PAYPAL_CLIENT_SECRET=mock npx tsx server/index.ts &
//   QA_DB=/tmp/pol/e2e.db OUT=/tmp/pol/cards node scripts/e2e-assistant-family.mjs [base] [part]   part: approve|decline|expired|all
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const PART = process.argv[3] ?? 'all';
const MOCK = process.env.MOCK_PAYPAL ?? 'http://127.0.0.1:9999';
const OUT = process.env.OUT ?? '/tmp/pol/cards';
const DB = process.env.QA_DB ?? '/tmp/pol/e2e.db';
const W = Number(process.env.WIDTH ?? 390);
fs.mkdirSync(OUT, { recursive: true });
const results = []; const axeOut = [];
const ok = (n, pass, info = '') => { results.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${n} ${info}`); };
const b = await chromium.launch();
const post = (p, url, body) => p.evaluate(async ([u, x]) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body]);
const get = (p, url) => p.evaluate(async (u) => (await fetch(u)).json(), url);
const ctx = async () => {
  const c = await b.newContext({ viewport: { width: W, height: 844 }, reducedMotion: 'reduce' });
  await c.addInitScript(() => localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, autoSpeak: false, rate: 0.95, readAll: false, lang: 'en' })));
  return c;
};
const axe = async (p, label) => {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  axeOut.push({ label, axe: r.violations.map((v) => `${v.id}:${v.nodes[0]?.target}`), overflow });
};
/** Screenshot one card (scrolled into view above the bottom stack), plus axe. */
const card = async (p, sel, name) => {
  const el = p.locator(sel).last();
  await el.waitFor({ timeout: 20000 });
  await el.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await p.evaluate(() => window.scrollBy(0, -90));
  await p.waitForTimeout(250);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  await el.screenshot({ path: `${OUT}/${name}-card.png` }).catch(() => {});
  await axe(p, name);
};
const send = async (p, input, t) => { await p.fill(input, t); await p.keyboard.press('Enter'); };
const sql = (q) => execFileSync('sqlite3', [DB, q]).toString().trim();

async function household() {
  const m = await (await ctx()).newPage();
  await m.goto(BASE + '/'); await m.waitForLoadState('networkidle');
  await post(m, '/api/demo/start', { name: 'Mary' });
  const inv = await post(m, '/api/family/invite', {});
  const f = await (await ctx()).newPage();
  await f.goto(BASE + '/'); await f.waitForLoadState('networkidle');
  await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
  // Never let the browser leave for the real PayPal: record the redirect and show a stub page.
  await m.route('https://www.sandbox.paypal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><title>PayPal (stub)</title><main><h1>Stopped at the PayPal redirect (test stub)</h1></main></html>' }));
  return { m, f };
}
/** Mary asks for the microwave in the Assistant and taps Allow (above her limit -> family review). */
async function maryAsks(m, tag) {
  await m.goto(BASE + '/assistant?mode=find'); await m.waitForSelector('#assistant-input');
  await send(m, '#assistant-input', 'I need a microwave');
  const list = m.getByRole('list', { name: 'Demo Shop options' }).last(); await list.waitFor({ timeout: 30000 });
  await list.getByRole('button').first().click();
  await m.getByRole('button', { name: /Prepare PayPal Sandbox payment/ }).click();
  await m.getByRole('button', { name: /^Allow/ }).last().waitFor();
  if (tag) await card(m, '[data-card="payment_prep"]', `${tag}-3-review-purchase`);
  await m.getByRole('button', { name: /^Allow/ }).last().click();
  await m.locator('[data-card="family_status"]').last().getByText('Pending').waitFor({ timeout: 15000 });
  const id = await m.locator('[data-card="family_status"] a[href^="/order/"]').last().getAttribute('href');
  return id.split('/').pop();
}

try {
  if (PART === 'approve' || PART === 'all') {
    const { m, f } = await household();
    const id = await maryAsks(m, 'A');
    await card(m, '[data-card="family_status"]', 'A-4-mary-family-pending');
    ok('Mary’s card shows Pending (family review) with the server amount', (await m.locator('[data-card="family_status"]').last().innerText()).includes('€120.00'));
    // Alex: Assistant tab (not Insights), review card with exact items and amount.
    await f.goto(BASE + '/family'); await f.waitForLoadState('networkidle');
    const tabs = await f.locator('nav[aria-label="Main"] a').evaluateAll((as) => as.filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.textContent));
    ok('Alex’s tabs: Home, Assistant, Activity, Profile', tabs.join() === 'Home,Assistant,Activity,Profile', tabs.join());
    ok('Insights still reachable from Alex’s Home', await f.getByRole('link', { name: /Open insights dashboard/ }).isVisible());
    await f.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Assistant' }).click(); await f.waitForURL('**/family/assistant');
    const review = f.locator('[data-card="family_review"]').last(); await review.waitFor({ timeout: 15000 });
    const txt = await review.innerText();
    ok('Alex’s review card: exact item, shop and amount from the server', /Simple Dial Microwave 20L/.test(txt) && /€120\.00/.test(txt) && /SaySafe Demo Shop/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 120));
    await card(f, '[data-card="family_review"]', 'A-5-alex-review-pending');
    await review.getByRole('button', { name: 'Approve' }).click();
    await review.getByText('Approved').first().waitFor({ timeout: 10000 });
    await card(f, '[data-card="family_review"]', 'A-5b-alex-approved');
    ok('server recorded the approval', sql(`SELECT status FROM approvals WHERE request_id='${id}'`) === 'approved');
    // Mary's card updates by itself (poll) and offers Continue to PayPal.
    const cont = m.locator('[data-card="family_status"]').last().getByRole('button', { name: 'Continue to PayPal' });
    await cont.waitFor({ timeout: 15000 });
    await card(m, '[data-card="family_status"]', 'A-6-mary-continue-to-paypal');
    ok('Mary’s card turns Approved and offers Continue to PayPal', true);
    // Reload: the card is re-read from the server, not from saved state.
    await m.reload(); await m.locator('[data-card="family_status"]').last().getByRole('button', { name: 'Continue to PayPal' }).waitFor({ timeout: 15000 });
    ok('state survives reload (re-fetched by id)', true);
    await m.locator('[data-card="family_status"]').last().getByRole('button', { name: 'Continue to PayPal' }).click();
    await m.waitForURL(/sandbox\.paypal\.com\/checkoutnow\?token=/, { timeout: 15000 });
    const payUrl = m.url();
    ok('Continue to PayPal redirects to the PayPal sandbox approval URL', /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=MOCK/.test(payUrl), payUrl);
    // Simulate the buyer's approval on the MOCK, then follow PayPal's return URL.
    const token = new URL(payUrl).searchParams.get('token');
    const ap = await (await fetch(`${MOCK}/mock/approve/${token}`, { method: 'POST' })).json();
    await m.goto(ap.returnUrl.replace(/^https?:\/\/[^/]+/, BASE));
    await m.getByTestId('order-state').waitFor({ timeout: 20000 });
    await m.getByText('Added to your Assistant conversation.').waitFor({ timeout: 10000 });
    const page = await m.locator('main').innerText();
    ok('receipt page: Captured + Verification pending (no verified webhook)', /Captured/.test(page) && /Verification pending/.test(page) && !/Verified — signed/.test(page));
    await m.screenshot({ path: `${OUT}/A-receipt-page.png`, fullPage: true }); await axe(m, 'A-receipt-page');
    await m.getByRole('button', { name: 'Ask the Assistant' }).click(); await m.waitForURL('**/assistant');
    const rc = m.locator('[data-card="receipt"]').last(); await rc.waitFor({ timeout: 15000 });
    const rcTxt = await rc.innerText();
    ok('Receipt card appended in the conversation (from the server)', /€120\.00/.test(rcTxt) && /Verification pending/.test(rcTxt) && /Approved at PayPal/.test(rcTxt), rcTxt.replace(/\s+/g, ' ').slice(0, 160));
    ok('only one receipt card for this purchase', (await m.locator('[data-card="receipt"]').count()) === 1);
    ok('Assistant opened from the receipt shows Back', await m.getByRole('button', { name: 'Back', exact: true }).isVisible());
    await card(m, '[data-card="receipt"]', 'A-7-receipt-card');
    await rc.getByRole('button', { name: 'Refund options' }).click();
    const rf = m.locator('[data-card="refund"]').last(); await rf.waitFor({ timeout: 10000 });
    await card(m, '[data-card="refund"]', 'A-9a-refund-can-request');
    await rf.getByRole('button', { name: 'Request a refund' }).click();
    await rf.getByText('Request sent — not refunded yet').first().waitFor({ timeout: 10000 });
    await card(m, '[data-card="refund"]', 'A-9b-refund-requested');
    ok('refund request is labelled as a request, not a refund', !/^Refunded$/m.test(await rf.innerText()));
    ok('server: refund request recorded, payment still CAPTURED', sql(`SELECT state FROM payment_requests WHERE id='${id}'`) === 'CAPTURED' && sql(`SELECT count(*) FROM refund_requests WHERE request_id='${id}'`) === '1');
    await send(m, '#assistant-input', 'show my payments');
    const hist = m.locator('[data-card="payment_history"]').last(); await hist.waitFor({ timeout: 15000 });
    await hist.getByRole('searchbox').fill('microwave'); await hist.getByRole('button', { name: 'Search' }).click();
    await m.locator('[data-card="payment_history"]').last().getByText(/result.* for “microwave”/).waitFor({ timeout: 10000 });
    await card(m, '[data-card="payment_history"]', 'A-8-history-search');
    ok('history card searches /api/activity', /Simple Dial Microwave/.test(await m.locator('[data-card="payment_history"]').last().innerText()));
    await m.reload(); await m.locator('[data-card="refund"]').last().getByText('Request sent — not refunded yet').first().waitFor({ timeout: 15000 });
    ok('receipt + refund cards survive reload', (await m.locator('[data-card="receipt"]').count()) === 1);
    // Alex sees the decided card after a reload too.
    await f.reload(); await f.locator('[data-card="family_review"]').last().getByText('Approved').first().waitFor({ timeout: 15000 });
    ok('Alex’s card survives reload', true);
    await m.context().close(); await f.context().close();
  }
  if (PART === 'decline' || PART === 'all') {
    const { m, f } = await household();
    const id = await maryAsks(m, null);
    await f.goto(BASE + '/family/assistant');
    const review = f.locator('[data-card="family_review"]').last(); await review.waitFor({ timeout: 15000 });
    await review.getByRole('button', { name: 'Decline' }).click();
    await review.getByText('Declined').first().waitFor({ timeout: 10000 });
    await card(f, '[data-card="family_review"]', 'D-5-alex-declined');
    await m.locator('[data-card="family_status"]').last().getByText('Declined').waitFor({ timeout: 15000 });
    await card(m, '[data-card="family_status"]', 'D-4-mary-declined');
    ok('decline: Mary’s card shows Declined, no PayPal button', (await m.locator('[data-card="family_status"]').last().getByRole('button', { name: 'Continue to PayPal' }).count()) === 0);
    const co = await post(m, `/api/payments/${id}/checkout`, {});
    ok('decline: server refuses checkout', co.status === 409, String(co.status));
    await m.context().close(); await f.context().close();
  }
  if (PART === 'expired' || PART === 'all') {
    const { m, f } = await household();
    const id = await maryAsks(m, null);
    await f.goto(BASE + '/family/assistant'); await f.locator('[data-card="family_review"]').last().waitFor({ timeout: 15000 });
    sql(`UPDATE approvals SET expires_at=${Date.now() - 1000} WHERE request_id='${id}'`);
    await m.locator('[data-card="family_status"]').last().getByText('Expired', { exact: true }).waitFor({ timeout: 15000 });
    await card(m, '[data-card="family_status"]', 'E-4-mary-expired');
    await f.reload(); await f.locator('[data-card="family_review"]').last().getByText('Expired', { exact: true }).first().waitFor({ timeout: 15000 });
    await card(f, '[data-card="family_review"]', 'E-5-alex-expired');
    ok('expired: Alex has no Approve button', (await f.locator('[data-card="family_review"]').last().getByRole('button', { name: 'Approve' }).count()) === 0);
    const d = await post(f, `/api/family/requests/${id}/decision`, { decision: 'approve', approvalId: sql(`SELECT id FROM approvals WHERE request_id='${id}'`) });
    ok('expired: server refuses a late approval', d.status === 410, String(d.status));
    await m.context().close(); await f.context().close();
  }
} catch (e) { ok('script error', false, String(e).slice(0, 400)); }
finally {
  await b.close();
  console.log('\nAXE / OVERFLOW');
  for (const a of axeOut) console.log(`${a.axe.length || a.overflow ? 'ISSUE' : 'OK   '} ${a.label} axe=${a.axe.length}${a.axe.length ? ' ' + a.axe.join('; ') : ''} overflow=${a.overflow}`);
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed; axe violations ${axeOut.reduce((n, a) => n + a.axe.length, 0)}`);
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, axe: axeOut }, null, 2));
}
