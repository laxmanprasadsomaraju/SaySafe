// "Try as Mary" end-to-end audit: the 18 workflows of the demo brief, in a real browser (Chromium, 390 px unless noted).
// LOCAL run uses scripts/mock-paypal.mjs (MOCK PayPal — labelled in every result that touches PayPal). The buyer approval
// is simulated on the mock (POST /mock/approve/:token); against the hosted site it needs a real sandbox buyer login.
//
//   node scripts/mock-paypal.mjs 9999 &
//   NODE_ENV=production SAYSAFE_ALLOW_EPHEMERAL_DB=true DATABASE_FILE=/tmp/dd/e2e.db PORT=8787 PAYPAL_API_BASE=http://127.0.0.1:9999 \
//     PAYPAL_ALLOW_LIVE=yes PAYPAL_CLIENT_ID=mock PAYPAL_CLIENT_SECRET=mock PAYPAL_DEMO_PLAN_ID=P-MOCKPLAN npx tsx server/index.ts &
//   QA_DB=/tmp/dd/e2e.db OUT=work/demo-data node scripts/e2e-demo.mjs [base]
// Results: PASS | FAIL | NOT IMPLEMENTED | BLOCKED BY PAYPAL. Writes $OUT/e2e-demo-results.json and $OUT/transcripts.json.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK_PAYPAL ?? 'http://127.0.0.1:9999';
const OUT = process.env.OUT ?? '/tmp/dd/shots';
const DB = process.env.QA_DB ?? '';
const HOSTED = !/127\.0\.0\.1|localhost/.test(BASE);
fs.mkdirSync(OUT, { recursive: true });
const results = []; const transcripts = []; const axeOut = [];
const rec = (n, name, status, info = '') => { results.push({ n, name, status, info }); console.log(`${String(n).padStart(2)} ${status.padEnd(18)} ${name}${info ? ` — ${info}` : ''}`); };
const sql = (q) => (DB ? execFileSync('sqlite3', [DB, q]).toString().trim() : '');
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = async (width = 390) => {
  const c = await b.newContext({ viewport: { width, height: width >= 1000 ? 900 : 844 }, reducedMotion: 'reduce', permissions: ['microphone'] });
  await c.addInitScript(() => localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, autoSpeak: false, rate: 0.95, readAll: false, lang: 'en' })));
  return c;
};
const stub = (p) => p.route('https://www.sandbox.paypal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><title>PayPal (stub)</title><main><h1>Stopped at the PayPal redirect (test stub)</h1></main></html>' }));
const last = (p, kind) => p.locator(`[data-card="${kind}"]`).last();
const lastReply = (p) => p.locator('[role="log"] > div[data-role="assistant"]').last();
async function say(p, text, kind, timeout = 25000) {
  await p.fill('#assistant-input', text); await p.keyboard.press('Enter');
  if (kind) await last(p, kind).waitFor({ timeout });
  else await p.waitForTimeout(1500);
  await p.waitForTimeout(400);
  const reply = (await lastReply(p).locator('p').first().innerText().catch(() => '')).replace(/^SaySafe:\s*/, '');
  const card = kind ? (await last(p, kind).innerText()).replace(/\s+/g, ' ').slice(0, 700) : null;
  transcripts.push({ you: text, saysafe: reply, card: kind, cardText: card });
  return { reply, card };
}
async function shot(p, name, kind) {
  if (kind) {
    // Hide the fixed header/bottom bars while capturing one card, so they don't cover it in the stitched image.
    await p.addStyleTag({ content: 'header.sticky,[data-testid="bottom-stack"]{visibility:hidden!important}' }).catch(() => {});
    const el = last(p, kind); await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(250); await el.screenshot({ path: `${OUT}/${name}.png` });
    await p.evaluate(() => document.querySelectorAll('style').forEach((s) => { if (s.textContent?.includes('bottom-stack')) s.remove(); }));
  }
  else await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}
async function axe(p, name) {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  axeOut.push({ name, violations: r.violations.map((v) => ({ id: v.id, n: v.nodes.length, sample: v.nodes[0]?.target })) });
  return r.violations.length;
}
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const safe = async (n, name, fn) => { try { await fn(); } catch (e) { rec(n, name, 'FAIL', String(e?.message ?? e).split('\n')[0].slice(0, 200)); } };

const c = await ctx(); const m = await c.newPage(); await stub(m);
// ---------- Fresh Try as Mary ----------
await m.goto(BASE + '/'); await m.getByRole('button', { name: /^Try as Mary/ }).first().click();
await m.waitForURL('**/assistant'); await last(m, 'demo_welcome').waitFor({ timeout: 30000 });
await shot(m, '01-assistant-welcome', 'demo_welcome');
const welcomePrompts = await last(m, 'demo_welcome').getByRole('button').allInnerTexts();

await safe(1, 'Scam Guardian analysis (training example, tap-to-try)', async () => {
  await last(m, 'demo_welcome').getByRole('button', { name: 'Check this suspicious message' }).click();
  await last(m, 'training_examples').waitFor({ timeout: 20000 });
  await shot(m, '02-training-examples', 'training_examples');
  await last(m, 'training_examples').getByRole('button', { name: 'Check this training example' }).nth(1).click(); // Hi Mum
  await m.locator('[data-card="scam_result"]').last().waitFor({ timeout: 30000 });
  const txt = await last(m, 'scam_result').innerText();
  await shot(m, '03-scam-hi-mum', 'scam_result');
  transcripts.push({ you: '[tap] Training example: "Hi Mum, new number"', saysafe: txt.replace(/\s+/g, ' ').slice(0, 400), card: 'scam_result' });
  rec(1, 'Scam Guardian analysis (training example, tap-to-try)', /compared with a contact you saved/i.test(txt) ? 'PASS' : 'FAIL', txt.split('\n')[0]);
});

// Data questions (rules-only locally: no GROQ key).
const data = {};
for (const [k, text, kind] of [
  ['last', 'Show my last payment', 'last_payment'], ['micro', 'Did I already pay for the microwave?', 'payment_matches'], ['john', 'Did I already pay John €80?', 'payment_matches'],
  ['subs', 'Show my subscriptions', 'subscriptions_list'], ['most', 'Which costs the most?', 'subscriptions_list'], ['next', "What's coming out next?", 'subscriptions_list'],
  ['cancel', 'Cancel my streaming subscription', 'subscription_help'], ['alex', 'Find Alex in my contacts', 'contact_card'], ['contacts', 'Show my contacts', 'contact_card'],
  ['gardener', 'Who is my gardener?', 'contact_card'], ['daughter', 'I want to pay my daughter', 'send_money'],
]) {
  try { data[k] = await say(m, text, kind); if (['last', 'micro', 'john', 'subs', 'cancel', 'contacts', 'gardener'].includes(k)) await shot(m, `04-${k}`, kind); }
  catch (e) { data[k] = { error: String(e.message).slice(0, 120) }; transcripts.push({ you: text, saysafe: 'ERROR: ' + data[k].error }); }
}

await safe(2, 'Channel3 product search and results', async () => {
  const r = await say(m, 'Compare real shops for a microwave', null);
  await m.waitForTimeout(8000);
  const n = await m.locator('[data-card="product_cards"]').count();
  const txt = n ? await last(m, 'product_cards').innerText() : '';
  if (n && !/Demo Shop/.test(txt)) { await shot(m, '05-channel3', 'product_cards'); rec(2, 'Channel3 product search and results', 'PASS', `${HOSTED ? 'real Channel3' : 'STUBBED Channel3 (recorded response, scripts/mock-channel3.mjs)'}: ${(txt.match(/€/g) ?? []).length} prices`); }
  else rec(2, 'Channel3 product search and results', 'FAIL', (await lastReply(m).innerText()).slice(0, 160));
  transcripts.at(-1).saysafe = (await lastReply(m).innerText()).replace(/\s+/g, ' ').slice(0, 300);
});
await safe(3, 'Product comparison', async () => {
  await say(m, 'Compare them', 'compare');
  rec(3, 'Product comparison', 'PASS', 'compare card rendered');
});

let reqId = null;
await safe(4, 'Demo Shop purchase selection', async () => {
  await say(m, 'I need a microwave', 'product_cards');
  await m.getByRole('list', { name: 'Demo Shop options' }).last().getByRole('button').first().click();
  await m.getByRole('button', { name: /Prepare PayPal Sandbox payment/ }).click();
  await last(m, 'payment_prep').waitFor({ timeout: 20000 });
  rec(4, 'Demo Shop purchase selection', 'PASS', 'product sheet -> payment_prep card');
});
await safe(5, 'Purchase review and confirmation', async () => {
  const t = await last(m, 'payment_prep').innerText();
  await shot(m, '06-payment-prep', 'payment_prep');
  await m.getByRole('button', { name: /^Allow/ }).last().click();
  await last(m, 'family_status').waitFor({ timeout: 20000 });
  reqId = (await last(m, 'family_status').locator('a[href^="/order/"]').getAttribute('href'))?.split('/').pop();
  rec(5, 'Purchase review and confirmation', /€120\.00/.test(t) && reqId ? 'PASS' : 'FAIL', `server amount €120.00, request ${reqId}`);
});
await safe(6, 'Family approval request', async () => {
  const t = await last(m, 'family_status').innerText();
  rec(6, 'Family approval request', /Pending|family/i.test(t) ? 'PASS' : 'FAIL', t.split('\n').slice(0, 2).join(' / '));
});
await safe(7, 'Alex Approve / Decline (Try as Alex too, same browser)', async () => {
  await m.goto(BASE + '/profile'); await m.getByTestId('try-as-alex').click();
  await m.waitForURL('**/family/assistant');
  const rv = m.locator('[data-card="family_review"]').last(); await rv.waitFor({ timeout: 20000 });
  const txt = await rv.innerText();
  await shot(m, '07-alex-review', 'family_review');
  const sampleShown = /Sample/.test(await m.locator('main').innerText()) && (await m.locator('[data-card="family_review"]').count()) === 1;
  await rv.getByRole('button', { name: 'Approve' }).click(); await rv.getByText('Approved').first().waitFor({ timeout: 15000 });
  const st = sql(`SELECT status FROM approvals WHERE request_id='${reqId}'`);
  rec(7, 'Alex Approve / Decline (Try as Alex too, same browser)', /Simple Dial Microwave/.test(txt) && (!DB || st === 'approved') ? 'PASS' : 'FAIL', `approval=${st || 'n/a'}; only the real request is reviewable: ${(await m.locator('[data-card="family_review"]').count()) === 1}${sampleShown ? '' : ''}`);
});
await safe(8, 'Return to Mary’s chat', async () => {
  await m.goto(BASE + '/home'); await m.goto(BASE + '/assistant');
  const cont = m.locator('[data-card="family_status"]').last().getByRole('button', { name: 'Continue to PayPal' });
  await cont.waitFor({ timeout: 20000 });
  rec(8, 'Return to Mary’s chat', 'PASS', 'card re-read from server: Approved + Continue to PayPal');
});
let payUrl = null;
await safe(9, 'Continue to PayPal Sandbox', async () => {
  await m.locator('[data-card="family_status"]').last().getByRole('button', { name: 'Continue to PayPal' }).click();
  await m.waitForURL(/sandbox\.paypal\.com\/checkoutnow\?token=/, { timeout: 20000 });
  payUrl = m.url();
  rec(9, 'Continue to PayPal Sandbox', 'PASS', HOSTED ? payUrl : `MOCK PayPal: ${payUrl.slice(0, 70)}`);
});
await safe(10, 'Buyer approval', async () => {
  if (HOSTED) return rec(10, 'Buyer approval', 'BLOCKED BY PAYPAL', 'needs the real sandbox buyer login (done manually after deploy)');
  const token = new URL(payUrl).searchParams.get('token');
  const ap = await (await fetch(`${MOCK}/mock/approve/${token}`, { method: 'POST' })).json();
  await m.goto(ap.returnUrl.replace(/^https?:\/\/[^/]+/, BASE));
  rec(10, 'Buyer approval', 'PASS', 'MOCK PayPal (simulated approval) — not PayPal itself');
});
await safe(11, 'Capture and verified receipt', async () => {
  if (HOSTED) return rec(11, 'Capture and verified receipt', 'BLOCKED BY PAYPAL', 'follows buyer approval');
  await m.getByTestId('order-state').waitFor({ timeout: 25000 });
  const page = await m.locator('main').innerText();
  await shot(m, '08-receipt-page');
  rec(11, 'Capture and verified receipt', /Captured/.test(page) && /Verification pending/.test(page) ? 'PASS' : 'FAIL', 'MOCK PayPal: captured; webhook honestly "Verification pending" (mock signatures never verify)');
});
await safe(12, 'Searchable payment history', async () => {
  await m.goto(BASE + '/assistant');
  await say(m, 'Show my payments', 'payment_history');
  const card = last(m, 'payment_history');
  await card.getByRole('searchbox').fill('microwave'); await card.getByRole('button', { name: 'Search' }).click();
  await m.waitForTimeout(1500);
  const t = await last(m, 'payment_history').innerText();
  await shot(m, '09-history-search', 'payment_history');
  rec(12, 'Searchable payment history', /microwave/i.test(t) && /Sample/.test(t) ? 'PASS' : 'FAIL', t.match(/\d+ results? for “microwave”/)?.[0] ?? '');
});
await safe(13, 'Potential duplicate-payment warning', async () => {
  const t = data.john?.card ?? '';
  rec(13, 'Potential duplicate-payment warning', /Possible duplicate/.test(t) ? 'PASS' : 'FAIL', 'John Smith €80 ×2 (sample)');
});
await safe(14, 'Contact search and recipient selection (send money hand-off)', async () => {
  await say(m, 'Send Alex €50', 'send_money');
  const card = last(m, 'send_money');
  await card.getByRole('button', { name: /Choose/ }).first().click();
  await card.getByRole('button', { name: 'Yes, these details are right' }).click();
  await last(m, 'send_money').getByTestId('paypal-send-link').waitFor();
  const t = await last(m, 'send_money').innerText();
  const href = await last(m, 'send_money').getByTestId('paypal-send-link').getAttribute('href');
  await shot(m, '10-send-money', 'send_money');
  const all = await m.locator('main').innerText();
  rec(14, 'Contact search and recipient selection (send money hand-off)', /Nothing is sent by SaySafe/.test(t) && !/€50(\.00)? sent/i.test(all) && href.startsWith('https://www.paypal.com/') ? 'PASS' : 'FAIL', href);
});
await safe(15, 'Subscription search and cancellation guidance (+ Demo Membership API cancel)', async () => {
  const t = data.cancel?.card ?? '';
  const ok1 = /Netflix/.test(t) && /help\.netflix\.com/.test(t);
  // Demo Membership: start -> (mock) approve -> active -> cancel card -> tap -> PayPal confirmed.
  await say(m, 'Show my subscriptions', 'subscriptions_list');
  await last(m, 'subscriptions_list').getByRole('button', { name: 'Try the Demo Membership' }).click();
  await last(m, 'demo_membership').getByRole('button', { name: 'Start Demo Membership' }).click();
  await m.waitForURL(/sandbox\.paypal\.com/, { timeout: 20000 });
  let ok2 = false; let info = '';
  if (!HOSTED) {
    const subId = new URL(m.url()).searchParams.get('subscription_id') ?? sql("SELECT paypal_subscription_id FROM companion_subscriptions WHERE source='paypal_sandbox_subscription' ORDER BY created_at DESC LIMIT 1");
    const ap = await (await fetch(`${MOCK}/mock/approve-sub/${subId}`, { method: 'POST' })).json();
    await m.goto(ap.returnUrl.replace(/^https?:\/\/[^/]+/, BASE));
    await last(m, 'demo_membership').getByTestId('demo-status').getByText('Active').waitFor({ timeout: 20000 });
    await last(m, 'demo_membership').getByRole('button', { name: 'Cancel membership' }).click();
    await last(m, 'demo_cancel_intent').getByTestId('cancel-billing').click();
    await m.locator('[data-card="demo_cancel_intent"][data-phase="confirmed"]').last().waitFor({ timeout: 20000 });
    await shot(m, '11-demo-membership-cancelled', 'demo_cancel_intent');
    ok2 = true; info = 'MOCK PayPal subscription: provider_confirmed after GET';
  }
  rec(15, 'Subscription search and cancellation guidance (+ Demo Membership API cancel)', ok1 && (HOSTED || ok2) ? 'PASS' : 'FAIL', `Netflix official link: ${ok1}; ${info}`);
});
await safe(16, 'Voice-driven core workflow (mic -> transcript -> same handler)', async () => {
  await m.goto(BASE + '/assistant');
  // Whisper (Groq) isn't configured locally: the transcription answer is stubbed; everything after it is the real app.
  if (!HOSTED) await m.route('**/api/voice/transcribe', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Who is my gardener?' }) }));
  const before = await m.locator('[data-card="contact_card"]').count();
  await m.getByRole('button', { name: 'Speak' }).click();
  await m.waitForTimeout(2500);
  await m.getByRole('button', { name: /Stop listening|Stop/ }).first().click().catch(() => {});
  await m.waitForFunction((n) => document.querySelectorAll('[data-card="contact_card"]').length > n, before, { timeout: 25000 });
  const t = await last(m, 'contact_card').innerText();
  rec(16, 'Voice-driven core workflow (mic -> transcript -> same handler)', /Pat Doyle/.test(t) ? 'PASS' : 'FAIL', HOSTED ? 'real STT' : 'fake mic; STT response stubbed (no Groq key locally)');
});
await safe(17, 'Reload and browser Back restoration', async () => {
  const n = await m.locator('[data-card]').count();
  await m.reload(); await m.waitForSelector('[data-card]');
  const n2 = await m.locator('[data-card]').count();
  await m.goto(BASE + '/activity'); await m.getByRole('heading', { name: 'Activity' }).waitFor();
  await m.goBack(); await m.waitForSelector('[data-card]');
  const n3 = await m.locator('[data-card]').count();
  rec(17, 'Reload and browser Back restoration', n2 === n && n3 === n ? 'PASS' : 'FAIL', `cards ${n} -> reload ${n2} -> back ${n3}`);
});
await safe(18, 'Authorisation and isolation (Mary, Alex, another visitor)', async () => {
  const c2 = await ctx(); const o = await c2.newPage();
  await o.goto(BASE + '/'); await o.getByRole('button', { name: /^Try as Mary/ }).first().click(); await o.waitForURL('**/assistant');
  const mine = await m.evaluate(async () => (await (await fetch('/api/companion/contacts')).json()).contacts.map((x) => x.id));
  const theirs = await o.evaluate(async () => (await (await fetch('/api/companion/contacts')).json()).contacts.map((x) => x.id));
  const overlap = mine.filter((x) => theirs.includes(x)).length;
  const cross = await o.evaluate(async (id) => (await fetch(`/api/payments/${id}`)).status, reqId);
  const crossC = await o.evaluate(async (id) => (await fetch(`/api/companion/contacts/${id}`)).status, mine[0]);
  // Alex's session (family cookie only) can't read Mary's private records.
  const c3 = await b.newContext(); const fam = await c3.newPage();
  const cookies = (await c.cookies()).filter((k) => k.name === 'ss_family'); await c3.addCookies(cookies); await fam.goto(BASE + '/help');
  const famCompanion = await fam.evaluate(async () => (await fetch('/api/companion/contacts')).status);
  const famDecideOwn = await m.evaluate(async () => { const r = await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'family' }) }); return r.status; });
  rec(18, 'Authorisation and isolation (Mary, Alex, another visitor)', overlap === 0 && cross === 404 && crossC === 404 && famCompanion === 403 ? 'PASS' : 'FAIL', `overlap=${overlap}, other visitor -> Mary's payment ${cross}, contact ${crossC}; Alex -> Mary's contacts ${famCompanion}`);
  await c2.close(); await c3.close(); void famDecideOwn;
});

// ---------- Screens + mobile QA (390) ----------
const screens = [['home', '/home'], ['activity', '/activity'], ['profile', '/profile']];
for (const [name, path] of screens) {
  await m.goto(BASE + path); await m.waitForLoadState('networkidle'); await m.waitForTimeout(800);
  await shot(m, `12-${name}-390`);
  const v = await axe(m, `${name}-390`); const of = await overflow(m);
  console.log(`   axe ${name}@390: ${v} violations; horizontal overflow: ${of}`);
}
await m.goto(BASE + '/assistant'); await m.waitForSelector('[data-card]');
console.log(`   axe assistant@390 (with cards): ${await axe(m, 'assistant-390')} violations; overflow: ${await overflow(m)}`);
// Sample order page.
const sampleOrder = await m.evaluate(async () => (await (await fetch('/api/activity?limit=50')).json()).items.find((i) => i.example && i.type === 'payment')?.href);
if (sampleOrder) { await m.goto(BASE + sampleOrder); await m.getByTestId('sample-order').waitFor(); await shot(m, '13-sample-order'); console.log(`   axe sample-order@390: ${await axe(m, 'sample-order-390')}`); }
// Desktop header with the website link.
const d = await ctx(1440); const dp = await d.newPage(); await d.addCookies(await c.cookies());
await dp.goto(BASE + '/home'); await dp.waitForLoadState('networkidle'); await dp.waitForTimeout(600); await shot(dp, '14-home-1440');
const web = dp.getByTestId('website-link'); await web.click(); await dp.waitForURL(BASE + '/');
const stillIn = await dp.evaluate(async () => (await (await fetch('/api/me')).json()).elder?.name ?? null);
console.log(`   website link -> / ; still signed in as: ${stillIn}`);
console.log(`   axe landing@1440: ${await axe(dp, 'landing-1440')}`);
await dp.getByRole('button', { name: /Continue as Mary/ }).first().waitFor({ timeout: 10000 }).then(() => console.log('   landing offers "Continue as Mary"')).catch(() => console.log('   landing: no Continue button'));

fs.writeFileSync(`${OUT}/e2e-demo-results.json`, JSON.stringify({ base: BASE, hosted: HOSTED, paypal: HOSTED ? 'real sandbox' : 'MOCK (scripts/mock-paypal.mjs)', at: new Date().toISOString(), welcomePrompts, results, axe: axeOut, websiteLinkKeepsSession: stillIn }, null, 2));
fs.writeFileSync(`${OUT}/transcripts.json`, JSON.stringify(transcripts, null, 2));
console.log(`\n${results.filter((r) => r.status === 'PASS').length}/${results.length} PASS`);
await b.close();
