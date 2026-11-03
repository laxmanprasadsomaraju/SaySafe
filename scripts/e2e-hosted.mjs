// Hosted end-to-end of the Assistant family flow + the payment companion, against the DEPLOYED app (real PayPal
// sandbox, real Groq, real Channel3). The local-only scripts (e2e-assistant-family.mjs, e2e-companion.mjs) need
// scripts/mock-paypal.mjs and direct SQLite access; this file ports every check that works without them, and
// checks server state through the public API instead of SQL. It also captures raw screenshots for docs/screenshots.
//
//   OUT=/tmp/hosted/shots node scripts/e2e-hosted.mjs https://saysafe.onrender.com [family|companion|all]
//
// Money: creates real SANDBOX orders. With GUEST_PAY=1 it completes ONE order on PayPal's hosted sandbox page with
// a fictional guest card (sandbox test card), so the receipt is a real capture. The Demo Membership is only started
// up to the PayPal approval redirect; it is never approved (the browser is stopped at the redirect).
// Uses the sandbox egress proxy (HTTPS_PROXY) for hosted runs, like e2e-browser.mjs. Run with parallelism 1 (Groq).
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
const BASE = process.argv[2] ?? 'https://saysafe.onrender.com';
const PART = process.argv[3] ?? 'all';
const OUT = process.env.OUT ?? '/tmp/hosted/shots';
const GUEST_PAY = process.env.GUEST_PAY === '1';
fs.mkdirSync(OUT, { recursive: true });
const results = []; const axeOut = []; const notes = [];
const ok = (n, pass, info = '') => { results.push({ n, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'} ${n}${info ? ` — ${info}` : ''}`); };
const skip = (n, why) => { results.push({ n, pass: null, info: why }); console.log(`SKIP ${n} — ${why}`); };
const px = process.env.HTTPS_PROXY || process.env.https_proxy;
let proxy;
if (px && !/localhost|127\.0\.0\.1/.test(BASE)) { const u = new URL(px); proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined }; }
const b = await chromium.launch(proxy ? { proxy } : {});
const post = (p, url, body, method = 'POST') => p.evaluate(async ([u, x, m]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: x === undefined ? undefined : JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body, method]);
const get = (p, url) => p.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => ({})) }; }, url);
const ctx = async (width = 390) => {
  const c = await b.newContext({ viewport: { width, height: width >= 1000 ? 900 : 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce', locale: 'en-IE', timezoneId: 'Europe/Dublin' });
  await c.addInitScript(() => localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, autoSpeak: false, rate: 0.95, readAll: false, lang: 'en' })));
  return c;
};
const send = async (p, t) => { await p.fill('#assistant-input', t); await p.keyboard.press('Enter'); };
const last = (p, kind) => p.locator(`[data-card="${kind}"]`).last();
/** Redact ids, emails and codes in the DOM before a screenshot: PayPal ids keep only their last 4. */
const redact = (p) => p.evaluate(() => {
  const rules = [
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => '[email hidden]'],
    [/\b(hh|usr|pay|sub|mpay|ctc|scan|rfq|sess)_[A-Za-z0-9_-]{8,}/g, () => '[id hidden]'],
    [/\b(I|WH|BA|EC|PAYID)-[A-Z0-9-]{8,}\b/g, (m) => `${m.split('-')[0]}-••••${m.slice(-4)}`],
    [/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{12,20}\b/g, (m) => `••••${m.slice(-4)}`],
    [/\b\d{6}\b(?=[^€\d]*(code|Code))/g, () => '••••••'],
  ];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { let t = n.nodeValue; for (const [re, f] of rules) t = t.replace(re, f); if (t !== n.nodeValue) n.nodeValue = t; }
  for (const el of document.querySelectorAll('[title]')) { const t = el.getAttribute('title'); if (/[A-Z0-9]{12,}|@/.test(t)) el.removeAttribute('title'); }
});
const axe = async (p, label) => {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  axeOut.push({ label, axe: r.violations.map((v) => `${v.id}:${v.nodes.length}:${v.nodes[0]?.target}`), overflow });
};
/** Viewport screenshot with the element scrolled near the top (keeps the app frame). */
const shotAt = async (p, sel, name, { full = false, offset = 90 } = {}) => {
  if (sel) { const el = p.locator(sel).last(); await el.waitFor({ timeout: 25000 }); await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await p.evaluate((o) => window.scrollBy(0, -o), offset); }
  await p.waitForTimeout(400); await redact(p);
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  await axe(p, name);
};
/** Element-only screenshot of a card, with the fixed composer/tab bar hidden for the shot. */
const shotCard = async (p, sel, name) => {
  const el = p.locator(sel).last(); await el.waitFor({ timeout: 25000 });
  await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await p.evaluate(() => window.scrollBy(0, -90)); await p.waitForTimeout(300);
  await redact(p);
  const tag = await p.addStyleTag({ content: '[data-testid="bottom-stack"]{visibility:hidden!important}' });
  await el.screenshot({ path: `${OUT}/${name}.png` }).catch((e) => notes.push(`${name}: ${e}`));
  await tag.evaluate((t) => t.remove());
};

const t0 = new Date();
console.log('START', t0.toISOString(), BASE);
const health = await (await fetch(BASE + '/api/health').catch(() => null))?.json().catch(() => null);
ok('/api/health ok, PayPal sandbox, Groq, Channel3, persistent DB', !!health?.ok && health.paypal?.env === 'sandbox' && health.ai?.groq?.ok && health.channel3?.configured && health.db?.persistent, JSON.stringify(health));

let m, f, mc, fc;
try {
  // ---------- Landing (desktop 1440) ----------
  const dc = await ctx(1440); const d = await dc.newPage();
  await d.goto(BASE + '/'); await d.waitForLoadState('networkidle'); await d.waitForTimeout(1200);
  await redact(d); await d.screenshot({ path: `${OUT}/landing-desktop-1440.png` }); await axe(d, 'landing-desktop-1440');
  await dc.close();

  // ---------- Mary + Alex ----------
  mc = await ctx(); m = await mc.newPage();
  await m.goto(BASE + '/'); await m.waitForLoadState('networkidle');
  const st = await post(m, '/api/demo/start', { name: 'Mary' });
  ok('demo household started as Mary', st.status === 200, String(st.status));
  await m.goto(BASE + '/home'); await m.waitForLoadState('networkidle'); await m.waitForTimeout(800);
  await shotAt(m, null, 'mobile-home');
  await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input'); await m.waitForTimeout(800);
  const chips = await m.getByRole('group', { name: 'Ask about your records' }).getByRole('button').allInnerTexts().catch(() => []);
  ok('companion suggestion chips on a fresh conversation', chips.join('|') === 'Did I already pay someone?|What do I pay every month?|Find a trusted contact', chips.join('|'));
  await shotAt(m, null, 'mobile-assistant');

  if (PART === 'family' || PART === 'all') {
    // ---------- Scam check (fictional PayPal phishing text) ----------
    await m.goto(BASE + '/assistant?mode=check'); await m.waitForSelector('#assistant-input');
    await send(m, 'PayPal: Your account has been limited. Confirm your details within 24 hours at http://paypa1-account-review.com/verify or your account will be closed. Reply STOP to opt out.');
    const sc = last(m, 'scam_result'); await sc.waitFor({ timeout: 45000 }); await m.waitForTimeout(1500);
    const scT = await sc.innerText();
    ok('scam check: fictional PayPal phishing text flagged as suspicious', /suspicious/i.test(scT), scT.replace(/\s+/g, ' ').slice(0, 160));
    await shotCard(m, '[data-card="scam_result"]', 'scam-check-result');

    // ---------- Channel3 products ----------
    await m.goto(BASE + '/assistant?mode=find'); await m.waitForSelector('#assistant-input');
    // Find mode searches the Demo Shop by default; "real shops" asks Channel3 (live retailer listings).
    await send(m, 'Find a quiet kettle under 60 euro in real shops');
    const shop = m.getByRole('list', { name: 'Shop listings' }).last();
    const got = await shop.waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
    if (got) {
      await m.waitForTimeout(2500);
      const imgs = await shop.locator('img').evaluateAll((is) => is.map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth })));
      ok('Channel3 listings show real product images', imgs.length > 0 && imgs.filter((i) => i.w > 0 && /^https:/.test(i.src)).length >= Math.min(2, imgs.length), `${imgs.filter((i) => i.w > 0).length}/${imgs.length} loaded`);
      await shotAt(m, '[data-card="product_cards"]', 'assistant-channel3-products');
    } else ok('Channel3 listings returned', false, 'no "Shop listings" card in 60 s');

    // ---------- Family: pair Alex, Mary asks, Alex approves ----------
    const inv = await post(m, '/api/family/invite', {});
    fc = await ctx(); f = await fc.newPage(); await f.goto(BASE + '/'); await f.waitForLoadState('networkidle');
    const pr = await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
    ok('Alex pairs with the one-time code', pr.status === 200, String(pr.status));
    await m.goto(BASE + '/assistant?mode=find'); await m.waitForSelector('#assistant-input');
    const nLists = await m.getByRole('list', { name: 'Demo Shop options' }).count(); // earlier turns may hold lists too
    await send(m, 'I need a microwave');
    const list = m.getByRole('list', { name: 'Demo Shop options' }).nth(nLists); await list.waitFor({ timeout: 60000 });
    await list.getByRole('button').first().click();
    await m.getByRole('button', { name: /Prepare PayPal Sandbox payment/ }).click();
    await m.getByRole('button', { name: /^Allow/ }).last().waitFor({ timeout: 20000 });
    await m.getByRole('button', { name: /^Allow/ }).last().click();
    await last(m, 'family_status').getByText('Pending').waitFor({ timeout: 20000 });
    const id = (await m.locator('[data-card="family_status"] a[href^="/order/"]').last().getAttribute('href')).split('/').pop();
    ok('Mary’s card shows Pending (family review) with the server amount', (await last(m, 'family_status').innerText()).includes('€120.00'));
    const s1 = await get(m, `/api/payments/${id}`);
    ok('server: request is FAMILY_APPROVAL_PENDING', s1.body.state === 'FAMILY_APPROVAL_PENDING' || s1.body.request?.state === 'FAMILY_APPROVAL_PENDING', s1.body.state ?? s1.body.request?.state);
    await shotAt(m, '[data-card="family_status"]', 'family-approval-pending-mary');

    await f.goto(BASE + '/family'); await f.waitForLoadState('networkidle');
    const tabs = await f.locator('nav[aria-label="Main"] a').evaluateAll((as) => as.filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.textContent));
    ok('Alex’s tabs: Home, Assistant, Activity, Profile', tabs.join() === 'Home,Assistant,Activity,Profile', tabs.join());
    ok('Insights reachable from Alex’s Home', await f.getByRole('link', { name: /Open insights dashboard/ }).isVisible());
    await f.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Assistant' }).click(); await f.waitForURL('**/family/assistant');
    const review = last(f, 'family_review'); await review.waitFor({ timeout: 20000 });
    const txt = await review.innerText();
    ok('Alex’s review card: exact item, shop and amount from the server', /Simple Dial Microwave 20L/.test(txt) && /€120\.00/.test(txt) && /SaySafe Demo Shop/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 120));
    await shotAt(f, '[data-card="family_review"]', 'family-alex-approves');
    await review.getByRole('button', { name: 'Approve' }).click();
    await review.getByText('Approved').first().waitFor({ timeout: 15000 });
    await shotAt(f, '[data-card="family_review"]', 'family-alex-approved');
    const cont = last(m, 'family_status').getByRole('button', { name: 'Continue to PayPal' });
    await cont.waitFor({ timeout: 20000 });
    ok('Mary’s card turns Approved and offers Continue to PayPal (polled from the server)', true);
    await m.reload(); await last(m, 'family_status').getByRole('button', { name: 'Continue to PayPal' }).waitFor({ timeout: 20000 });
    ok('state survives reload (re-fetched by id)', true);
    await last(m, 'family_status').getByRole('button', { name: 'Continue to PayPal' }).click();
    await m.waitForURL(/sandbox\.paypal\.com\/checkoutnow\?token=/, { timeout: 45000 });
    ok('Continue to PayPal redirects to the REAL PayPal sandbox approval page', /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=[A-Z0-9]{17}/.test(m.url()), m.url().slice(0, 50));
    const early = await (async () => { const q = await mc.newPage(); await q.goto(BASE + '/home'); const r = await post(q, `/api/payments/${id}/confirm`, { orderId: new URL(m.url()).searchParams.get('token') }); await q.close(); return r; })();
    ok('confirm before buyer approval is refused', early.status >= 400, `${early.status} ${early.body.error ?? ''}`);

    if (GUEST_PAY) {
      // Guest card on PayPal's hosted sandbox page (fictional sandbox test card). Same steps as paypal-hosted-e2e.mjs.
      const p = m; await p.waitForTimeout(8000);
      for (let i = 0; i < 3; i++) {
        await p.locator('#createAccount').click({ timeout: 30000 }).catch(() => {});
        if (await p.locator('input[name=cardNumber]').waitFor({ timeout: 20000 }).then(() => true).catch(() => false)) break;
      }
      const byLabel = async (label, v) => { const l = p.getByLabel(label, { exact: false }).first(); try { await l.click({ timeout: 8000 }); await l.pressSequentially(v, { delay: 30 }); } catch { notes.push(`guest fill fail ${label}`); } };
      await byLabel(/Email Address/i, `saysafe.test.${Date.now()}@example.com`);
      await byLabel(/Phone number/i, '851234567');
      await byLabel(/Card number/i, '4032039317984658');
      await byLabel(/Expiry date/i, '1230');
      await byLabel(/CVV/i, '123');
      await byLabel(/First name/i, 'Mary');
      await byLabel(/Last name/i, 'Testbuyer');
      await byLabel(/Address line 1/i, '1 Test Street');
      await byLabel(/Town|City/i, 'Limerick');
      await p.getByLabel(/County/i).first().selectOption({ index: 15 }).catch(() => notes.push('county select fail'));
      await p.getByText(/Save info & create your PayPal account/i).first().click({ timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(1000);
      if (await p.getByLabel(/Create password/i).first().isVisible().catch(() => false)) {
        await byLabel(/Create password/i, 'Sandbox#' + Date.now().toString().slice(-6));
        await byLabel(/Date of birth/i, '01011950');
      }
      await p.waitForTimeout(1500);
      await p.getByRole('button', { name: /Agree and (Pay|Continue)|Pay Now|Continue/i }).first().click({ timeout: 15000 }).catch(() => notes.push('pay button not found'));
      const back = await p.waitForURL((u) => u.host === new URL(BASE).host, { timeout: 90000 }).then(() => true).catch(() => false);
      ok('guest card approval on PayPal’s hosted sandbox page returns to SaySafe', back, back ? '' : p.url().slice(0, 80));
      if (back) {
        await p.getByTestId('order-state').waitFor({ timeout: 45000 }).catch(() => {});
        let page = '';
        for (let i = 0; i < 8; i++) { page = await p.locator('main').innerText(); if (/Verified/.test(page)) break; await p.waitForTimeout(8000); await p.reload(); await p.getByTestId('order-state').waitFor({ timeout: 30000 }).catch(() => {}); }
        const fin = await get(p, `/api/payments/${id}`); const fs2 = fin.body.state ?? fin.body.request?.state;
        ok('server: request CAPTURED after buyer approval', fs2 === 'CAPTURED', fs2);
        ok('receipt shows the signed webhook as verified', /Verified/.test(page), /Verification pending/.test(page) ? 'still "Verification pending" after ~70 s' : '');
        await shotAt(p, null, 'receipt-page', { full: true });
        const ask = p.getByRole('button', { name: 'Ask the Assistant' });
        if (await ask.isVisible().catch(() => false)) {
          await ask.click(); await p.waitForURL('**/assistant');
          const rc = last(p, 'receipt'); await rc.waitFor({ timeout: 20000 });
          ok('receipt card in the Assistant shows €120.00 from the server', /€120\.00/.test(await rc.innerText()), (await rc.innerText()).replace(/\s+/g, ' ').slice(0, 160));
          await shotCard(p, '[data-card="receipt"]', 'receipt-verified');
        }
        // Activity + transaction detail
        await p.goto(BASE + '/activity'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(1200);
        await shotAt(p, null, 'activity');
        await p.goto(`${BASE}/order/${id}`); await p.getByTestId('order-state').waitFor({ timeout: 30000 });
        await shotAt(p, null, 'transaction-detail', { full: true });
      }
    } else skip('buyer approval on PayPal', 'GUEST_PAY not set');

    // ---------- Profile voice, native insights ----------
    await m.goto(BASE + '/profile'); await m.waitForLoadState('networkidle');
    await shotAt(m, '#voice-h', 'profile-voice-settings', { offset: 70 });
    await f.goto(BASE + '/family/insights'); await f.waitForLoadState('networkidle'); await f.waitForTimeout(3000);
    ok('native Family Safety Insights renders for Alex', (await f.locator('main').innerText()).length > 100);
    await shotAt(f, null, 'family-insights');
  }

  if (PART === 'receipt') {
    // Family-approved purchase -> stop at the PayPal redirect and write its URL; a sandbox BUYER approves it in another
    // browser (PayPal's own page); this script polls PayPal's order status, then follows the return URL in Mary's
    // session, which confirms + captures (server side) and appends the receipt card.
    const inv = await post(m, '/api/family/invite', {});
    fc = await ctx(); f = await fc.newPage(); await f.goto(BASE + '/'); await f.waitForLoadState('networkidle');
    await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
    await m.goto(BASE + '/assistant?mode=find'); await m.waitForSelector('#assistant-input');
    await send(m, 'I need a microwave');
    const list = m.getByRole('list', { name: 'Demo Shop options' }).last(); await list.waitFor({ timeout: 60000 });
    await list.getByRole('button').first().click();
    await m.getByRole('button', { name: /Prepare PayPal Sandbox payment/ }).click();
    await m.getByRole('button', { name: /^Allow/ }).last().waitFor({ timeout: 20000 }); await m.getByRole('button', { name: /^Allow/ }).last().click();
    await last(m, 'family_status').getByText('Pending').waitFor({ timeout: 20000 });
    const id = (await m.locator('[data-card="family_status"] a[href^="/order/"]').last().getAttribute('href')).split('/').pop();
    await f.goto(BASE + '/family/assistant'); const review = last(f, 'family_review'); await review.waitFor({ timeout: 20000 });
    await review.getByRole('button', { name: 'Approve' }).click(); await review.getByText('Approved').first().waitFor({ timeout: 15000 });
    let approveUrl = null;
    await m.route('https://www.sandbox.paypal.com/**', (r) => { approveUrl ??= r.request().url(); r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><title>PayPal (handed off)</title><main><h1>Handed off to the sandbox buyer</h1></main></html>' }); });
    await last(m, 'family_status').getByRole('button', { name: 'Continue to PayPal' }).waitFor({ timeout: 20000 });
    await last(m, 'family_status').getByRole('button', { name: 'Continue to PayPal' }).click();
    for (let i = 0; i < 30 && !approveUrl; i++) await m.waitForTimeout(500);
    ok('family-approved purchase reaches the real PayPal sandbox approval URL', /checkoutnow\?token=[A-Z0-9]{17}/.test(approveUrl ?? ''), approveUrl?.slice(0, 50));
    fs.writeFileSync(`${OUT}/approve-url.txt`, approveUrl ?? '');
    const token = new URL(approveUrl).searchParams.get('token');
    console.log('WAITING_FOR_BUYER', approveUrl);
    let status = null;
    for (let i = 0; i < 120; i++) { // up to 20 minutes
      status = (await get(f, `/api/paypal/orders/${token}/status`)).body;
      if (/APPROVED|COMPLETED/.test(status?.orderStatus ?? '')) break;
      await m.waitForTimeout(10000);
    }
    ok('sandbox buyer approved the order on PayPal’s page', /APPROVED|COMPLETED/.test(status?.orderStatus ?? ''), status?.orderStatus);
    await m.unroute('https://www.sandbox.paypal.com/**');
    await m.goto(`${BASE}/checkout/return?token=${token}`);
    await m.getByTestId('order-state').waitFor({ timeout: 45000 });
    await m.getByText('Added to your Assistant conversation.').waitFor({ timeout: 20000 }).catch(() => notes.push('no "Added to your Assistant conversation" line'));
    let page = '';
    for (let i = 0; i < 10; i++) { page = await m.locator('main').innerText(); if (/Verified/.test(page)) break; await m.waitForTimeout(8000); await m.reload(); await m.getByTestId('order-state').waitFor({ timeout: 30000 }).catch(() => {}); }
    const fin = await get(m, `/api/payments/${id}`);
    ok('server: CAPTURED once after buyer approval', fin.body.state === 'CAPTURED', fin.body.state);
    ok('receipt shows the signed PayPal webhook as verified', /Verified/.test(page), /Verification pending/.test(page) ? 'still "Verification pending" after ~90 s' : '');
    const dup = await post(m, `/api/payments/${id}/confirm`, { orderId: token });
    ok('a second confirm returns the same capture (no second charge)', dup.status === 200 && (dup.body.paypalCaptureId ?? dup.body.receipt?.captureId) === (fin.body.paypalCaptureId ?? fin.body.receipt?.captureId), String(dup.status));
    await shotAt(m, null, 'receipt-page', { full: true });
    await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input');
    const rc = last(m, 'receipt');
    if (await rc.waitFor({ timeout: 20000 }).then(() => true).catch(() => false)) {
      ok('receipt card in the Assistant shows €120.00 from the server', /€120\.00/.test(await rc.innerText()), (await rc.innerText()).replace(/\s+/g, ' ').slice(0, 200));
      await shotCard(m, '[data-card="receipt"]', 'receipt-verified');
    } else ok('receipt card appended in the Assistant', false);
    await m.goto(BASE + '/activity'); await m.waitForLoadState('networkidle'); await m.waitForTimeout(1500);
    await shotAt(m, null, 'activity');
    await m.goto(`${BASE}/order/${id}`); await m.getByTestId('order-state').waitFor({ timeout: 30000 }); await m.waitForTimeout(800);
    await shotAt(m, null, 'transaction-detail', { full: true });
    fs.writeFileSync(`${OUT}/receipt-state.json`, JSON.stringify({ id, token: '…' + token.slice(-4), state: fin.body.state }));
  }

  if (PART === 'companion' || PART === 'all') {
    // ---------- Companion: payment records + search (in a fresh conversation, where the chips show) ----------
    await m.goto(BASE + '/assistant'); await m.evaluate(() => sessionStorage.removeItem('ss-assistant-thread'));
    await m.reload(); await m.waitForSelector('#assistant-input');
    await m.getByRole('button', { name: 'Did I already pay someone?' }).click();
    const rec = last(m, 'companion_records'); await rec.waitFor({ timeout: 20000 });
    const addRecord = async (who, amt, date, method) => {
      await rec.getByRole('button', { name: 'Add a record' }).click();
      const fm = rec.getByRole('form', { name: 'Add a payment record' });
      await fm.getByLabel('Who you paid').fill(who); await fm.getByLabel('Amount (€)').fill(amt); await fm.getByLabel('Date').fill(date); await fm.getByLabel('How you paid').selectOption(method);
      await fm.getByRole('button', { name: 'Save record' }).click();
      await rec.getByRole('status').filter({ hasText: `to ${who}` }).waitFor({ timeout: 15000 });
    };
    await addRecord('John Smith', '80', '2026-10-01', 'bank_transfer');
    await addRecord('Mary-Kate Byrne', '80', '2026-10-12', 'cash');
    const lp = await get(m, '/api/companion/payments');
    ok('records saved (server API)', (lp.body.payments ?? lp.body.items ?? lp.body).length === 2, String((lp.body.payments ?? lp.body.items ?? lp.body).length));
    await send(m, 'Did I already pay John €80?');
    const pm = last(m, 'payment_matches'); await pm.waitFor({ timeout: 30000 }); await pm.getByText('John Smith').first().waitFor({ timeout: 15000 });
    const pmT = await pm.innerText();
    ok('payment card: John Smith matched, "Recorded by you — not verified"', /John Smith/.test(pmT) && pmT.includes('Recorded by you — not verified'));
    ok('payment card: partial-name and repeated-amount caveats', /partial|first name/i.test(pmT) && /more than once|different one/i.test(pmT));
    ok('payment card: "Don’t pay again until you’ve checked with John" guidance', /Don't pay again until you've checked with John/.test(pmT));
    const dupes = (pmT.match(/Don't pay again until you've checked with John/g) ?? []).length;
    notes.push(`payment_matches: the "Don't pay again…" line appears ${dupes}x on the hosted build`);
    await shotCard(m, '[data-card="payment_matches"]', 'companion-payment-matches');
    skip('payment card: Demo Shop €80 purchase excluded', 'needs a CAPTURED €80 Demo Shop row planted by SQL (local only)');

    // ---------- Subscriptions ----------
    await m.goto(BASE + '/profile'); await m.getByRole('link', { name: 'My subscriptions' }).click(); await m.waitForURL('**/assistant');
    const sr = last(m, 'companion_records'); await sr.waitFor({ timeout: 20000 }); await sr.getByText('What you pay regularly').waitFor();
    const addSub = async (name, amt, freq, next) => {
      await sr.getByRole('button', { name: 'Add a subscription' }).click();
      const fm = sr.getByRole('form', { name: 'Add a subscription' });
      await fm.getByLabel('Company').fill(name); await fm.getByLabel('Amount (€)').fill(amt); await fm.getByLabel('How often').selectOption(freq); if (next) await fm.getByLabel(/Next charge/).fill(next);
      await fm.getByRole('button', { name: 'Save' }).click();
      await sr.locator(`[data-sub="${name}"]`).waitFor({ timeout: 15000 });
    };
    await addSub('Netflix', '12.99', 'monthly', '2026-11-20');
    await addSub('Spotify', '10.99', 'monthly');
    await addSub('Garden Club', '60', 'yearly');
    await send(m, 'What do I pay every month?');
    const mc2 = last(m, 'monthly_costs'); await mc2.waitFor({ timeout: 30000 }); await mc2.getByTestId('monthly-EUR').waitFor();
    const mon = await mc2.getByTestId('monthly-EUR').innerText(); const ann = await mc2.getByTestId('annual-EUR').innerText();
    ok('totals: €28.98 a month, €347.76 a year', mon === '€28.98' && ann === '€347.76', `${mon} / ${ann}`);
    ok('Netflix shows next expected charge and source', /Next expected charge: 20 Nov 2026/.test(await mc2.innerText()) && /Entered by you — not verified/.test(await mc2.innerText()));
    await shotCard(m, '[data-card="monthly_costs"]', 'companion-subscriptions');
    await mc2.locator('[data-sub="Spotify"] > button').click();
    await mc2.locator('[data-sub="Spotify"]').getByRole('button', { name: 'Keep' }).click();
    await mc2.getByText('Kept. SaySafe keeps counting Spotify.').waitFor({ timeout: 10000 });
    ok('tap a subscription -> Keep', true);

    // ---------- External cancel hand-off ----------
    await send(m, 'cancel my Netflix subscription');
    const sh = last(m, 'subscription_help'); await sh.waitFor({ timeout: 30000 });
    const href = await sh.getByRole('link', { name: /Open Netflix’s cancel page/ }).getAttribute('href');
    ok('official Netflix link card', href === 'https://help.netflix.com/en/node/407', href);
    ok('copy separates the PayPal billing authorisation from the service contract', /The service with Netflix/.test(await sh.innerText()) && /PayPal automatic payment/.test(await sh.innerText()));
    await sh.getByRole('button', { name: 'I’ve cancelled it' }).click();
    await sh.getByLabel(/Anything to note/).fill('confirmation email 3 Nov');
    await sh.getByRole('button', { name: 'Yes, I’ve cancelled it' }).click();
    await sh.getByTestId('user-reported').waitFor({ timeout: 15000 });
    ok('labelled "You told SaySafe this is cancelled — not confirmed by the provider"', (await sh.getByTestId('user-reported').innerText()).includes('You told SaySafe this is cancelled — not confirmed by the provider'));
    const subs = await get(m, '/api/companion/subscriptions');
    const nf = (subs.body.subscriptions ?? subs.body.items ?? subs.body).find?.((s) => s.merchant === 'Netflix');
    ok('server: Netflix user-reported, never provider-confirmed', !!nf && /user_reported/.test(JSON.stringify(nf)) && !/provider_confirmed/.test(JSON.stringify(nf)), JSON.stringify(nf ?? subs.body).slice(0, 160));

    // ---------- Trusted contacts + contact mismatch ----------
    await m.goto(BASE + '/assistant?records=contacts');
    const cr = last(m, 'companion_records'); await cr.waitFor({ timeout: 20000 }); await cr.getByText('My trusted contacts').waitFor();
    await cr.getByRole('button', { name: 'Add a contact' }).click();
    const cf = cr.getByRole('form', { name: 'Add a trusted contact' });
    await cf.getByLabel('Name').fill('Tom'); await cf.getByLabel(/Who they are/).fill('son'); await cf.getByLabel('Phone').fill('+353 87 123 4567');
    await cf.getByRole('button', { name: 'Save contact' }).click(); await cr.getByText('Tom saved.').waitFor({ timeout: 15000 });
    await send(m, "What's my son's number?");
    const cc = last(m, 'contact_card'); await cc.waitFor({ timeout: 30000 });
    const tel = await cc.getByRole('link', { name: 'Call Tom' }).getAttribute('href');
    ok('contact card: "Saved by you — not verified" + call link to the saved number', tel === 'tel:+353871234567' && (await cc.innerText()).includes('Saved by you — not verified'), tel);
    await shotCard(m, '[data-card="contact_card"]', 'companion-trusted-contact');
    await m.goto(BASE + '/assistant?mode=check'); await m.waitForSelector('#assistant-input');
    await send(m, 'Hi Mum it’s Tom, my new number is +353 87 999 1111 can you send €200 today');
    const sc2 = last(m, 'scam_result'); await sc2.getByTestId('contact-evidence').waitFor({ timeout: 45000 });
    const ev = await sc2.getByTestId('contact-evidence').innerText();
    ok('scam card shows the contact_mismatch evidence and the saved-number advice', /from Tom, but the number isn't the one you saved/.test(ev) && /ending 4567/.test(ev) && /\+353 87 999 1111/.test(ev), ev.replace(/\s+/g, ' ').slice(0, 200));
    await shotCard(m, '[data-card="scam_result"]', 'companion-scam-contact-mismatch');

    // ---------- Demo Membership: start up to the PayPal redirect only (never approved) ----------
    await m.route('https://www.sandbox.paypal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><title>PayPal (stopped)</title><main><h1>Stopped at the PayPal redirect (hosted test does not approve the membership)</h1></main></html>' }));
    await m.goto(BASE + '/assistant?records=subscriptions'); await last(m, 'companion_records').getByText('What you pay regularly').waitFor({ timeout: 20000 });
    const before = await m.locator('[data-card="monthly_costs"]').count();
    await send(m, 'What do I pay every month?');
    await m.locator('[data-card="monthly_costs"]').nth(before).waitFor({ timeout: 30000 });
    const tryBtn = last(m, 'monthly_costs').getByRole('button', { name: 'Try the Demo Membership' });
    if (await tryBtn.isVisible().catch(() => false)) {
      await tryBtn.click();
      const dm = last(m, 'demo_membership'); await dm.getByRole('button', { name: 'Start Demo Membership' }).waitFor({ timeout: 20000 });
      await shotCard(m, '[data-card="demo_membership"]', 'companion-demo-membership-start');
      await dm.getByRole('button', { name: 'Start Demo Membership' }).click();
      const went = await m.waitForURL(/sandbox\.paypal\.com\/webapps\/billing\/subscriptions\?ba_token=BA-I-/, { timeout: 30000 }).then(() => true).catch(() => false);
      ok('Start Demo Membership creates a real sandbox subscription and redirects to PayPal approval (not approved)', went, went ? 'ba_token=BA-I-…' + m.url().slice(-4) : m.url().slice(0, 80));
    } else ok('Demo Membership offered on the monthly costs card', false, 'button not visible');
    for (const s of ['return -> active', 'typed "yes" does not cancel', 'PayPal 500 -> Retry', 'tap cancel -> CANCELLED -> provider_confirmed']) skip(`Demo Membership: ${s}`, 'needs buyer approval (not done on hosted by instruction) or the mock PayPal');

    // ---------- Family exclusion ----------
    if (!f) {
      await m.unroute('https://www.sandbox.paypal.com/**');
      const inv = await post(m, '/api/family/invite', {});
      fc = await ctx(); f = await fc.newPage(); await f.goto(BASE + '/'); await f.waitForLoadState('networkidle');
      await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
    }
    if (f) {
      const codes = await Promise.all(['/api/companion/payments', '/api/companion/subscriptions', '/api/companion/contacts'].map(async (u) => (await get(f, u)).status));
      ok('family session: companion API 403', codes.every((s) => s === 403), codes.join(','));
      await f.goto(BASE + '/profile'); await f.waitForLoadState('networkidle');
      ok('family profile: no "My records" / delete section', (await f.locator('[data-testid="companion-data"]').count()) === 0);
    }
    // ---------- Reload persistence ----------
    await m.unroute('https://www.sandbox.paypal.com/**').catch(() => {});
    await m.goto(BASE + '/assistant?records=subscriptions');
    const sr2 = last(m, 'companion_records'); await sr2.locator('[data-sub="Netflix"]').waitFor({ timeout: 20000 });
    ok('after reload: Netflix still user-reported', (await sr2.locator('[data-sub="Netflix"]').innerText()).includes('You told SaySafe this is cancelled — not confirmed by the provider'));
  }
} catch (e) { ok('script error', false, String(e?.stack ?? e).slice(0, 500)); try { await m?.screenshot({ path: `${OUT}/zz-error-mary.png` }); } catch {} }
finally {
  await b.close();
  console.log('\nAXE / OVERFLOW');
  for (const a of axeOut) console.log(`${a.axe.length || a.overflow ? 'ISSUE' : 'OK   '} ${a.label} axe=${a.axe.length}${a.axe.length ? ' ' + a.axe.join('; ') : ''} overflow=${a.overflow}`);
  for (const n of notes) console.log('NOTE', n);
  const pass = results.filter((r) => r.pass === true).length; const fail = results.filter((r) => r.pass === false).length; const sk = results.filter((r) => r.pass === null).length;
  console.log(`\n${pass} passed, ${fail} failed, ${sk} skipped; axe violations ${axeOut.reduce((n, a) => n + a.axe.length, 0)}; ${t0.toISOString()} -> ${new Date().toISOString()}`);
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, start: t0, end: new Date(), results, axe: axeOut, notes }, null, 2));
}
