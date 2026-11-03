// Browser test of the payment companion cards (phase 2) against a LOCAL server wired to scripts/mock-paypal.mjs
// (no PayPal keys; PayPal itself is NOT exercised: the browser stops at the sandbox.paypal.com redirect, approval is
// simulated on the mock, then PayPal's return URL is followed). AI is off, so the rules-only intent fallback runs.
// Covers: payment search with a partial name and a repeated amount, subscription totals, the external cancel hand-off
// labelled user-reported, the Demo Membership (start -> return -> cancel card; a typed "yes" does NOT cancel; mock
// PayPal 500 -> Retry; the tap -> CANCELLED -> provider_confirmed), trusted contacts + the scam contact_mismatch
// evidence, reload persistence, family view exclusion, Profile "Delete all". Then a UX pass at 320/390/1440 in
// default and large text: axe WCAG 2.2 A/AA, horizontal overflow (page and every card), screenshots to $OUT.
//
//   node scripts/mock-paypal.mjs 9999 &
//   DATABASE_FILE=/tmp/cc/e2e.db PORT=8787 PAYPAL_API_BASE=http://127.0.0.1:9999 PAYPAL_ALLOW_LIVE=yes \
//     PAYPAL_CLIENT_ID=mock PAYPAL_CLIENT_SECRET=mock PAYPAL_DEMO_PLAN_ID=P-MOCKPLAN npx tsx server/index.ts &   (no GROQ_API_KEY)
//   QA_DB=/tmp/cc/e2e.db OUT=/tmp/cc/shots node scripts/e2e-companion.mjs [base]
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK_PAYPAL ?? 'http://127.0.0.1:9999';
const OUT = process.env.OUT ?? '/tmp/cc/shots';
const DB = process.env.QA_DB ?? '/tmp/cc/e2e.db';
const PART = process.argv[3] ?? 'all';   // flows | qa | all  (qa reuses $OUT/state.json from flows)
fs.mkdirSync(OUT, { recursive: true });
const results = []; const axeOut = [];
const ok = (n, pass, info = '') => { results.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${n}${info ? ` — ${info}` : ''}`); };
const sql = (q) => execFileSync('sqlite3', [DB, q]).toString().trim();
const b = await chromium.launch();
const post = (p, url, body, method = 'POST') => p.evaluate(async ([u, x, m]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body, method]);
const getS = (p, url) => p.evaluate(async (u) => (await fetch(u)).status, url);
const ctx = async (width = 390, mode = 'default') => {
  const c = await b.newContext({ viewport: { width, height: width >= 1000 ? 900 : 844 }, reducedMotion: 'reduce' });
  await c.addInitScript((m) => { localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, autoSpeak: false, rate: 0.95, readAll: false, lang: 'en' })); if (m === 'large') localStorage.setItem('ss-large', 'on'); }, mode);
  return c;
};
const stub = (p) => p.route('https://www.sandbox.paypal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><title>PayPal (stub)</title><main><h1>Stopped at the PayPal redirect (test stub)</h1></main></html>' }));
const send = async (p, t) => { await p.fill('#assistant-input', t); await p.keyboard.press('Enter'); };
const last = (p, kind) => p.locator(`[data-card="${kind}"]`).last();
const shot = async (p, kind, name) => {
  const el = last(p, kind); await el.waitFor({ timeout: 20000 });
  await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await p.evaluate(() => window.scrollBy(0, -90)); await p.waitForTimeout(200);
  // The fixed composer + tab bar would be stitched over a tall card in an element screenshot: hide them for the shot only.
  const tag = await p.addStyleTag({ content: '[data-testid="bottom-stack"]{visibility:hidden!important}' });
  await el.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
  await tag.evaluate((t) => t.remove());
};
const axe = async (p, label) => {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const lay = await p.evaluate(() => ({
    page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    cards: [...document.querySelectorAll('[data-card]')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.getAttribute('data-card')),
  }));
  axeOut.push({ label, axe: r.violations.map((v) => `${v.id}:${v.nodes.length}:${v.nodes[0]?.target}`), overflow: lay.page, cardOverflow: lay.cards });
  return r.violations.length === 0 && !lay.page && lay.cards.length === 0;
};

let thread = null; let cookies = null; let hh = null; let SHOP = null;
const SHOP_ID = `pay_e2eshop${Date.now().toString(36)}`;
if (PART !== 'qa') try {
  const mc = await ctx(); const m = await mc.newPage(); await stub(m);
  await m.goto(BASE + '/'); await m.waitForLoadState('networkidle');
  await post(m, '/api/demo/start', { name: 'Mary' });
  hh = sql('SELECT household_id FROM sessions ORDER BY rowid DESC LIMIT 1');
  // A Demo Shop purchase of the same amount: it must NOT appear next to John's name.
  sql(`INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, paypal_capture_id) VALUES ('${SHOP_ID}', '${hh}', 'CAPTURED', '[{"productId":"kettle-classic","name":"Classic Kettle","quantity":1}]', 'SaySafe Demo Shop', 8000, 'EUR', 'fp', 'CAP${SHOP_ID.toUpperCase()}')`);

  // ---------- 1. Payments: chips, add records, search with a partial name and a repeated amount ----------
  await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input');
  const chips = await m.getByRole('group', { name: 'Ask about your records' }).getByRole('button').allInnerTexts();
  ok('suggestion chips on a fresh conversation', chips.join('|') === 'Did I already pay someone?|What do I pay every month?|Find a trusted contact', chips.join('|'));
  await m.getByRole('button', { name: 'Did I already pay someone?' }).click();
  const rec = last(m, 'companion_records'); await rec.waitFor();
  const addRecord = async (who, amt, date, method) => {
    await rec.getByRole('button', { name: 'Add a record' }).click();
    const f = rec.getByRole('form', { name: 'Add a payment record' });
    await f.getByLabel('Who you paid').fill(who); await f.getByLabel('Amount (€)').fill(amt); await f.getByLabel('Date').fill(date); await f.getByLabel('How you paid').selectOption(method);
    await f.getByRole('button', { name: 'Save record' }).click();
    await rec.getByRole('status').filter({ hasText: `to ${who}` }).waitFor();
  };
  await addRecord('John Smith', '80', '2026-10-01', 'bank_transfer');
  await addRecord('Mary-Kate Byrne', '80', '2026-10-12', 'cash');
  await shot(m, 'companion_records', '01-payment-records');
  ok('records saved (server)', sql(`SELECT COUNT(*) FROM companion_payments WHERE household_id='${hh}'`) === '2');
  await send(m, 'Did I already pay John €80?');
  const pm = last(m, 'payment_matches'); await pm.waitFor({ timeout: 15000 });
  await pm.getByText('John Smith').first().waitFor();
  const pmT = await pm.innerText();
  ok('payment card: John Smith matched, badge "Recorded by you — not verified"', /John Smith/.test(pmT) && pmT.includes('Recorded by you — not verified'));
  ok('payment card: partial-name and repeated-amount caveats', /partial|first name/i.test(pmT) && /more than once|different one/i.test(pmT), pmT.replace(/\s+/g, ' ').slice(0, 400));
  ok('payment card: "Don’t pay again until you’ve checked with John" guidance', /Don't pay again until you've checked with John/.test(pmT));
  ok('payment card: Demo Shop €80 purchase excluded, with the note', !/Classic Kettle/.test(pmT) && /Demo Shop payments are not shown/.test(pmT));
  await shot(m, 'payment_matches', '02-payment-matches');
  // Edit from the card, then the card re-runs the search.
  await pm.getByRole('button', { name: /Edit record of John Smith/ }).click();
  const ef = pm.getByRole('form', { name: 'Edit payment record' }); await ef.getByLabel(/Note/).fill('garden work'); await ef.getByRole('button', { name: 'Save changes' }).click();
  await pm.getByText('Record updated.').waitFor();
  await pm.getByText(/garden work/).first().waitFor({ timeout: 10000 });
  ok('edit from the payment card is saved and shown', sql(`SELECT memo FROM companion_payments WHERE recipient='John Smith' AND household_id='${hh}'`) === 'garden work');

  // ---------- 2. Subscriptions: add, totals ----------
  await m.goto(BASE + '/profile'); await m.getByRole('link', { name: 'My subscriptions' }).click();
  await m.waitForURL('**/assistant');
  const sr = last(m, 'companion_records'); await sr.waitFor(); await sr.getByText('What you pay regularly').waitFor();
  const addSub = async (name, amt, freq, next) => {
    await sr.getByRole('button', { name: 'Add a subscription' }).click();
    const f = sr.getByRole('form', { name: 'Add a subscription' });
    await f.getByLabel('Company').fill(name); await f.getByLabel('Amount (€)').fill(amt); await f.getByLabel('How often').selectOption(freq); if (next) await f.getByLabel(/Next charge/).fill(next);
    await f.getByRole('button', { name: 'Save' }).click();
    await sr.locator(`[data-sub="${name}"]`).waitFor();
  };
  await addSub('Netflix', '12.99', 'monthly', '2026-11-20');
  await addSub('Spotify', '10.99', 'monthly');
  await addSub('Garden Club', '60', 'yearly');
  await send(m, 'What do I pay every month?');
  const mc2 = last(m, 'monthly_costs'); await mc2.waitFor({ timeout: 15000 });
  await mc2.getByTestId('monthly-EUR').waitFor();
  const mon = await mc2.getByTestId('monthly-EUR').innerText(); const ann = await mc2.getByTestId('annual-EUR').innerText();
  ok('totals: €28.98 a month, €347.76 a year (12.99 + 10.99 + 60/12)', mon === '€28.98' && ann === '€347.76', `${mon} / ${ann}`);
  ok('Netflix shows next expected charge and source', /Next expected charge: 20 Nov 2026/.test(await mc2.innerText()) && /Entered by you — not verified/.test(await mc2.innerText()));
  await shot(m, 'monthly_costs', '03-subscriptions-totals');
  // Select by tap -> Keep
  await mc2.locator('[data-sub="Spotify"] > button').click();
  await mc2.locator('[data-sub="Spotify"]').getByRole('button', { name: 'Keep' }).click();
  await mc2.getByText('Kept. SaySafe keeps counting Spotify.').waitFor();
  ok('tap a subscription -> Keep', true);

  // ---------- 3. External cancel hand-off (voice: merchant name) ----------
  await send(m, 'cancel my Netflix subscription');
  const sh = last(m, 'subscription_help'); await sh.waitFor({ timeout: 15000 });
  const href = await sh.getByRole('link', { name: /Open Netflix’s cancel page/ }).getAttribute('href');
  ok('official Netflix link card', href === 'https://help.netflix.com/en/node/407', href);
  const shT = await sh.innerText();
  ok('copy separates the PayPal billing authorisation from the service contract', /The service with Netflix/.test(shT) && /PayPal automatic payment/.test(shT));
  await shot(m, 'subscription_help', '04-external-cancel-handoff');
  await sh.getByRole('button', { name: 'I’ve cancelled it' }).click();
  await sh.getByLabel(/Anything to note/).fill('confirmation email 3 Nov');
  await sh.getByRole('button', { name: 'Yes, I’ve cancelled it' }).click();
  await sh.getByTestId('user-reported').waitFor({ timeout: 10000 });
  ok('labelled "You told SaySafe this is cancelled — not confirmed by the provider"', (await sh.getByTestId('user-reported').innerText()).includes('You told SaySafe this is cancelled — not confirmed by the provider'));
  ok('server: user_reported_cancelled, confirmed_by user (never provider_confirmed)', sql(`SELECT sub_state||'/'||confirmed_by FROM companion_subscriptions WHERE merchant='Netflix' AND household_id='${hh}'`) === 'user_reported_cancelled/user');
  await shot(m, 'subscription_help', '05-external-user-reported');

  // ---------- 4. Trusted contacts + scam contact_mismatch evidence ----------
  await m.goto(BASE + '/assistant?records=contacts');
  const cr = last(m, 'companion_records'); await cr.waitFor(); await cr.getByText('My trusted contacts').waitFor();
  await cr.getByRole('button', { name: 'Add a contact' }).click();
  const cf = cr.getByRole('form', { name: 'Add a trusted contact' });
  await cf.getByLabel('Name').fill('Tom'); await cf.getByLabel(/Who they are/).fill('son'); await cf.getByLabel('Phone').fill('+353 87 123 4567');
  await cf.getByRole('button', { name: 'Save contact' }).click();
  await cr.getByText('Tom saved.').waitFor();
  await send(m, "What's my son's number?");
  const cc = last(m, 'contact_card'); await cc.waitFor({ timeout: 15000 });
  const tel = await cc.getByRole('link', { name: 'Call Tom' }).getAttribute('href');
  ok('contact card: "Saved by you — not verified" + call link to the saved number', tel === 'tel:+353871234567' && (await cc.innerText()).includes('Saved by you — not verified'), tel);
  await shot(m, 'contact_card', '06-contact-lookup');
  await m.goto(BASE + '/assistant?mode=check'); await m.waitForSelector('#assistant-input');
  await send(m, 'Hi Mum it’s Tom, my new number is +353 87 999 1111 can you send €200 today');
  const sc = last(m, 'scam_result'); await sc.getByTestId('contact-evidence').waitFor({ timeout: 20000 });
  const ev = await sc.getByTestId('contact-evidence').innerText();
  ok('scam card shows the contact_mismatch evidence and the saved-number advice', /from Tom, but the number isn't the one you saved/.test(ev) && /ending 4567/.test(ev) && /\+353 87 999 1111/.test(ev), ev.replace(/\s+/g, ' ').slice(0, 200));
  await shot(m, 'scam_result', '07-scam-contact-mismatch');

  // ---------- 5. Demo Membership: start -> PayPal (stub) -> return -> active ----------
  await m.goto(BASE + '/assistant?records=subscriptions');
  await last(m, 'companion_records').getByText('What you pay regularly').waitFor();
  const before = await m.locator('[data-card="monthly_costs"]').count();
  await send(m, 'What do I pay every month?');
  await m.locator('[data-card="monthly_costs"]').nth(before).waitFor({ timeout: 15000 });
  const mc3 = last(m, 'monthly_costs');
  await mc3.getByRole('button', { name: 'Try the Demo Membership' }).click();
  const dm = last(m, 'demo_membership'); await dm.getByRole('button', { name: 'Start Demo Membership' }).waitFor({ timeout: 15000 });
  await dm.getByRole('button', { name: 'Start Demo Membership' }).click();
  await m.waitForURL(/sandbox\.paypal\.com\/webapps\/billing\/subscriptions\?ba_token=BA-I-/, { timeout: 15000 });
  const subId = new URL(m.url()).searchParams.get('ba_token').replace(/^BA-/, '');
  ok('Start opens the PayPal sandbox approval page (goToPayPal)', /^I-MOCK/.test(subId), m.url());
  const ap = await (await fetch(`${MOCK}/mock/approve-sub/${subId}`, { method: 'POST' })).json();
  await m.goto(ap.returnUrl.replace(/^https?:\/\/[^/]+/, BASE));
  await m.waitForURL('**/assistant', { timeout: 15000 });
  const dm2 = last(m, 'demo_membership'); await dm2.getByTestId('demo-status').getByText('Active').waitFor({ timeout: 15000 });
  ok('return to /assistant?membership=active shows the status from PayPal', (await dm2.innerText()).includes('Back from PayPal: PayPal shows the membership as active.'));
  await shot(m, 'demo_membership', '08-demo-active');
  await dm2.getByRole('button', { name: 'Cancel membership' }).click();
  const dc = last(m, 'demo_cancel_intent'); await dc.getByTestId('confirm-text').waitFor({ timeout: 15000 });
  ok('confirmation card shows the exact text', (await dc.getByTestId('confirm-text').innerText()) === 'Cancel SaySafe Demo Membership billing via PayPal');
  ok('big "Cancel billing via PayPal" button', (await dc.getByTestId('cancel-billing').innerText()) === 'Cancel billing via PayPal');
  await shot(m, 'demo_cancel_intent', '09-demo-cancel-confirm');
  thread = await m.evaluate(() => sessionStorage.getItem('ss-assistant-thread'));
  // A typed/spoken "yes" never cancels.
  await send(m, 'yes');
  await m.getByText('To be safe, please tap “Cancel billing via PayPal” on the card yourself.').last().waitFor({ timeout: 10000 });
  const still = await (await fetch(`${MOCK}/mock/sub/${subId}`)).json();
  ok('"yes" does not cancel: PayPal still ACTIVE, card still waiting for the tap', still.status === 'ACTIVE' && (await dc.getAttribute('data-phase')) === 'confirm');
  // PayPal 500 -> error status with Retry; nothing confirmed.
  await fetch(`${MOCK}/mock/sub-cancel-mode/500`, { method: 'POST' });
  await dc.getByTestId('cancel-billing').click();
  await dc.getByRole('button', { name: 'Retry' }).waitFor({ timeout: 15000 });
  ok('PayPal 500 -> "Not cancelled — nothing is confirmed" + Retry', /Not cancelled — nothing is confirmed/.test(await dc.innerText()) && sql(`SELECT sub_state FROM companion_subscriptions WHERE paypal_subscription_id='${subId}'`) !== 'provider_confirmed');
  await shot(m, 'demo_cancel_intent', '10-demo-cancel-retry');
  await dc.getByRole('button', { name: 'Retry' }).click();
  await dc.getByTestId('cancel-billing').waitFor({ timeout: 15000 });
  ok('Retry needs a new tap (fresh confirmation shown)', (await dc.getAttribute('data-phase')) === 'confirm');
  await dc.getByTestId('cancel-billing').click();
  await dc.getByText('PayPal confirmed the billing authorisation is cancelled', { exact: true }).waitFor({ timeout: 15000 });
  const after = await (await fetch(`${MOCK}/mock/sub/${subId}`)).json();
  ok('tap -> mock PayPal CANCELLED -> server provider_confirmed (paypal_api) -> success card', after.status === 'CANCELLED' && sql(`SELECT sub_state||'/'||confirmed_by FROM companion_subscriptions WHERE paypal_subscription_id='${subId}'`) === 'provider_confirmed/paypal_api');
  await shot(m, 'demo_cancel_intent', '11-demo-cancel-confirmed');
  ok('the used token is not kept in the saved conversation', !(await m.evaluate(() => sessionStorage.getItem('ss-assistant-thread'))).match(/"token":"[A-Za-z0-9_-]{20,}"/));

  // ---------- 6. Reload persistence ----------
  await m.reload(); await m.waitForSelector('#assistant-input');
  await last(m, 'demo_cancel_intent').getByText('PayPal confirmed the billing authorisation is cancelled', { exact: true }).waitFor({ timeout: 15000 });
  await last(m, 'demo_membership').getByText('Cancelled — confirmed by PayPal').waitFor({ timeout: 15000 });
  ok('after reload: Demo Membership re-read from the server (cancelled, confirmed by PayPal)', true);
  await m.goto(BASE + '/assistant?records=subscriptions');
  const sr2 = last(m, 'companion_records'); await sr2.locator('[data-sub="Netflix"]').waitFor({ timeout: 15000 });
  ok('after reload: Netflix still "You told SaySafe this is cancelled — not confirmed by the provider"', (await sr2.locator('[data-sub="Netflix"]').innerText()).includes('You told SaySafe this is cancelled — not confirmed by the provider'));
  ok('after reload: totals exclude Netflix (Spotify + Garden Club)', (await sr2.getByTestId('monthly-EUR').innerText()) === '€15.99');
  cookies = await mc.cookies();
  fs.writeFileSync(`${OUT}/state.json`, JSON.stringify({ thread, cookies, hh, shop: SHOP_ID }));

  // ---------- 7. Family view never shows any of it ----------
  const inv = await post(m, '/api/family/invite', {});
  const fc = await ctx(); const f = await fc.newPage(); await f.goto(BASE + '/'); await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
  const st = await Promise.all(['/api/companion/payments', '/api/companion/subscriptions', '/api/companion/contacts'].map((u) => getS(f, u)));
  ok('family session: companion API 403', st.every((s) => s === 403), st.join(','));
  await f.addInitScript((t) => sessionStorage.setItem('ss-assistant-thread-family', t), thread.replace('"v":1', '"v":1'));
  await f.goto(BASE + '/family/assistant'); await f.waitForLoadState('networkidle'); await f.waitForTimeout(800);
  const famCards = await f.locator('[data-card="payment_matches"],[data-card="monthly_costs"],[data-card="subscription_help"],[data-card="demo_cancel_intent"],[data-card="contact_card"],[data-card="companion_records"],[data-card="demo_membership"]').count();
  ok('family assistant: no companion card even from a planted conversation', famCards === 0, String(famCards));
  const fp = await (await f.goto(BASE + '/profile')) && await f.locator('[data-testid="companion-data"]').count();
  ok('family profile: no "My records" / delete section', fp === 0);
  await fc.close();
} catch (e) { ok('flow crashed', false, String(e?.stack ?? e).slice(0, 600)); }

// ---------- 8. UX pass: 320 / 390 / 1440 × default / large text ----------
if (PART === 'qa') ({ thread, cookies, hh, shop: SHOP } = JSON.parse(fs.readFileSync(`${OUT}/state.json`, 'utf8')));
else SHOP = SHOP_ID;
if (PART !== 'flows' && thread && cookies) {
  for (const width of [320, 390, 1440]) for (const mode of ['default', 'large']) {
    const c = await ctx(width, mode); await c.addCookies(cookies);
    await c.addInitScript((t) => { if (!sessionStorage.getItem('qa-once')) { sessionStorage.setItem('ss-assistant-thread', t); sessionStorage.setItem('qa-once', '1'); } }, thread);
    const p = await c.newPage(); await stub(p);
    await p.goto(BASE + '/assistant'); await p.waitForSelector('#assistant-input');
    for (const k of ['payment_matches', 'monthly_costs', 'subscription_help', 'demo_membership', 'demo_cancel_intent']) await last(p, k).waitFor({ timeout: 15000 });
    await p.waitForTimeout(1200);
    const clean = await axe(p, `assistant-${width}-${mode}`);
    ok(`UX ${width}px ${mode}: axe 0, no page/card overflow`, clean, JSON.stringify(axeOut[axeOut.length - 1]));
    for (const k of ['payment_matches', 'monthly_costs', 'subscription_help', 'demo_cancel_intent']) await shot(p, k, `qa-${width}-${mode}-${k}`);
    await p.goto(BASE + '/profile'); await p.locator('[data-testid="companion-data"]').waitFor();
    await p.locator('[data-testid="companion-data"]').getByRole('button', { name: 'Delete all my companion data' }).click();
    await p.locator('[data-testid="companion-data"]').evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForLoadState('networkidle'); await p.waitForTimeout(600);
    const cleanP = await axe(p, `profile-${width}-${mode}`);
    ok(`UX ${width}px ${mode} profile (delete confirm open): axe 0, no overflow`, cleanP, JSON.stringify(axeOut[axeOut.length - 1]));
    await p.locator('[data-testid="companion-data"]').screenshot({ path: `${OUT}/qa-${width}-${mode}-profile-privacy.png` });
    await c.close();
  }
  // ---------- 9. Profile: Delete all my companion data ----------
  const c = await ctx(390); await c.addCookies(cookies); const p = await c.newPage();
  await p.goto(BASE + '/profile');
  const box = p.locator('[data-testid="companion-data"]'); await box.waitFor();
  await box.getByRole('button', { name: 'Delete all my companion data' }).click();
  await box.getByRole('button', { name: 'Yes, delete everything' }).click();
  await box.getByRole('status').waitFor({ timeout: 10000 });
  const msg = await box.getByRole('status').innerText();
  const left = sql(`SELECT (SELECT COUNT(*) FROM companion_payments WHERE household_id='${hh}')||'/'||(SELECT COUNT(*) FROM companion_subscriptions WHERE household_id='${hh}')||'/'||(SELECT COUNT(*) FROM companion_contacts WHERE household_id='${hh}')||'/'||(SELECT COUNT(*) FROM payment_requests WHERE id='${SHOP}')`);
  ok('Delete all: records gone, Demo Shop payment kept', /Deleted 2 payment records, 4 subscriptions and 1 contact/.test(msg) && left === '0/0/0/1', `${msg} [${left}]`);
  await c.close();
}

await b.close();
fs.writeFileSync(`${OUT}/e2e-companion.json`, JSON.stringify({ results, axe: axeOut }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map((f) => f.n).join(' | ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
