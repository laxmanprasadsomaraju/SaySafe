// Screenshots for the Learn SaySafe guides, the Judges' Guide and the Features page.
//
//   node scripts/shots-docs.mjs http://127.0.0.1:8792        # local build: mock PayPal :9999 + recorded Channel3 :9998
//   node scripts/shots-docs.mjs https://saysafe.onrender.com # hosted: real Channel3 + real PayPal Sandbox
//
// Writes web/public/docs-assets/<guide>/<nn>-<slug>-<w>.webp (w = 1440 desktop or 390 phone) and
// web/public/docs-assets/manifest.json (where each shot came from). Pages read the manifest at build time
// (web/src/learn/shots.ts imports it), so: run this, then `npm run build`.
//
// Honesty rules built in:
//  - The PayPal-hosted login/approval page is NEVER captured (it shows the buyer's email). Guides show a text step.
//  - Local runs use a MOCK PayPal. Every shot that shows PayPal order/capture details is stamped
//    "Illustration from local test build" and its ids are replaced by "[ID hidden · local test]". The manifest marks them
//    source "local". A hosted run replaces them with real sandbox screens only when it completes the buyer step.
//  - Hosted buyer step: only when PAYPAL_BUYER_EMAIL and PAYPAL_BUYER_PASSWORD are set in the ENVIRONMENT (never a file,
//    never logged). Without them the hosted run keeps the previous (local, labelled) receipt shots untouched.
//  - Sample data stays labelled "Sample data" by the app itself; nothing is retouched except mock ids.
//
// Options: ONLY=g02,g05 (guides to re-shoot; the journey still runs, other shots are skipped) · HEADFUL=1
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8792').replace(/\/$/, '');
const HOSTED = !/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE);
const MOCK = process.env.MOCK_PAYPAL ?? 'http://127.0.0.1:9999';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'web/public/docs-assets');
const TMP = process.env.TMP_DIR ?? '/tmp/shots-docs';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const PACE = HOSTED ? 6500 : 0; // hosted: ≤10 Assistant requests a minute
const BUYER = { email: process.env.PAYPAL_BUYER_EMAIL, password: process.env.PAYPAL_BUYER_PASSWORD };
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(TMP, { recursive: true });

const manifestFile = path.join(OUT, 'manifest.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { shots: {} };
let commit = 'unknown'; try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { /* */ }
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = []; const skipped = []; const failed = [];

const proxyOf = (u) => { if (!u) return undefined; const x = new URL(u); return { server: `${x.protocol}//${x.host}`, username: decodeURIComponent(x.username), password: decodeURIComponent(x.password), bypass: '127.0.0.1,localhost' }; };
const browser = await chromium.launch({ headless: !process.env.HEADFUL, ...(HOSTED && process.env.HTTPS_PROXY ? { proxy: proxyOf(process.env.HTTPS_PROXY) } : {}) });

async function context(w = 390) {
  const c = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce', locale: 'en-IE', timezoneId: 'Europe/Dublin' });
  // Voice muted by the visitor's own choice, so screenshots never wait on speech and Profile shows the chosen state.
  await c.addInitScript(() => { if (!localStorage.getItem('ss-voice-prefs')) localStorage.setItem('ss-voice-prefs', JSON.stringify({ muted: true, mutedByUser: true, autoSpeak: false, rate: 0.95, readAll: false, lang: 'en' })); });
  return c;
}

/** Thin outline around the element(s) the step is about: a CSS overlay, nothing painted into the app. */
async function highlight(p, loc) {
  if (!loc) return;
  const el = loc.first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await p.evaluate(() => document.querySelectorAll('[data-docs-hl]').forEach((n) => n.remove()));
  const box = await el.boundingBox().catch(() => null);
  if (!box) return;
  await p.evaluate(({ x, y, width, height }) => {
    const d = document.createElement('div'); d.setAttribute('data-docs-hl', '');
    Object.assign(d.style, { position: 'absolute', left: `${x + scrollX - 6}px`, top: `${y + scrollY - 6}px`, width: `${width + 12}px`, height: `${height + 12}px`, border: '3px solid #c2410c', borderRadius: '16px', boxShadow: '0 0 0 4px rgb(194 65 12 / 0.18)', pointerEvents: 'none', zIndex: '2147483646' });
    document.body.appendChild(d);
  }, box);
}
const clearHl = (p) => p.evaluate(() => document.querySelectorAll('[data-docs-hl],[data-docs-stamp]').forEach((n) => n.remove())).catch(() => {});

/** Local runs: hide mock PayPal ids and stamp the image so it is never mistaken for a real sandbox payment. */
async function localStamp(p) {
  await p.evaluate(() => {
    const re = /\bMOCK[A-Z0-9-]*(?:…|\.\.\.)?[A-Z0-9]*|\b[A-Z0-9]{3,8}(?:…|\.\.\.)[A-Z0-9]{3,6}\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{17}\b/g;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
    for (const n of nodes) if (re.test(n.nodeValue)) { re.lastIndex = 0; n.nodeValue = n.nodeValue.replace(re, '[ID hidden · local test]'); }
    const s = document.createElement('div'); s.setAttribute('data-docs-stamp', '');
    s.textContent = 'Illustration from local test build (mock PayPal) — not a real sandbox payment';
    Object.assign(s.style, { position: 'fixed', left: '8px', right: '8px', bottom: '8px', zIndex: '2147483647', background: '#15283b', color: '#fff', font: '700 13px/1.3 system-ui, sans-serif', padding: '8px 12px', borderRadius: '10px', textAlign: 'center' });
    document.body.appendChild(s);
  });
}

/**
 * One screenshot. id = "g05/03-receipt-page"; the width is appended. opts: { hl: locator, paypal: true (shows PayPal
 * order/capture details), top: locator to scroll to the top of the viewport, fullCard: locator to clip to }.
 */
async function snap(p, id, opts = {}) {
  const guide = id.split('/')[0];
  const w = p.viewportSize().width;
  const key = `${id}-${w}`;
  if (ONLY && !ONLY.has(guide)) { skipped.push(key); return; }
  if (HOSTED && opts.paypal && !opts.realReceipt) { skipped.push(`${key} (needs a completed hosted buyer step)`); return; }
  try {
    if (opts.top) { const el = opts.top.first(); await el.waitFor({ timeout: 20000 }); await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await p.evaluate(() => window.scrollBy(0, -(document.querySelector('header')?.getBoundingClientRect().height ?? 70) - 12)); }
    if (opts.hl) await highlight(p, opts.hl);
    if (opts.top && opts.hl) { const el = opts.top.first(); await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await p.evaluate(() => window.scrollBy(0, -(document.querySelector('header')?.getBoundingClientRect().height ?? 70) - 12)); }
    const stamped = !HOSTED && opts.paypal;
    if (stamped) await localStamp(p);
    await p.evaluate(() => { (document.activeElement)?.blur?.(); return document.fonts?.ready; }).catch(() => {});
    await sleep(250);
    const png = path.join(TMP, `${key.replace('/', '_')}.png`);
    await p.screenshot({ path: png, animations: 'disabled', caret: 'hide' });
    fs.mkdirSync(path.join(OUT, guide), { recursive: true });
    const file = path.join(OUT, `${key}.webp`);
    // Desktop shots are captured at 2x and stored at 1440 px wide; phone shots keep 2x (780 px) for the enlarged view.
    execFileSync('convert', [png, ...(w >= 1000 ? ['-resize', `${w}x`] : []), '-strip', '-quality', '80', '-define', 'webp:method=6', file]);
    const [iw, ih] = execFileSync('identify', ['-format', '%w %h', file]).toString().split(' ').map(Number);
    manifest.shots[key] = { file: `/docs-assets/${key}.webp`, width: iw, height: ih, viewport: w, source: HOSTED ? 'hosted' : 'local', paypalMock: Boolean(stamped), base: HOSTED ? BASE : 'local', commit, takenAt: new Date().toISOString() };
    done.push(key); log('shot', key);
  } catch (e) { failed.push(`${key}: ${e.message.split('\n')[0]}`); log('FAIL shot', key, e.message.split('\n')[0]); }
  finally { await clearHl(p); }
}

const last = (p, kind) => p.locator(`[data-card="${kind}"]`).last();
async function ask(p, text, card) {
  if (PACE) await sleep(PACE);
  const before = card ? await p.locator(`[data-card="${card}"]`).count() : 0;
  await p.fill('#assistant-input', text); await p.keyboard.press('Enter');
  if (card) await p.waitForFunction(([k, n]) => document.querySelectorAll(`[data-card="${k}"]`).length > n, [card, before], { timeout: 40000 });
  await sleep(700);
}
/** The app asks before leaving a screen with a purchase waiting ("Leave, keep it saved"): answer it like a person would. */
async function leaveIfAsked(p) { const b = p.getByRole('button', { name: 'Leave, keep it saved' }); await b.waitFor({ timeout: HOSTED ? 20000 : 4000 }).then(() => b.click()).catch(() => {}); }
async function at(p, w) { await p.setViewportSize({ width: w, height: w < 600 ? 844 : 900 }); await sleep(400); }
async function step(name, fn) { try { await fn(); } catch (e) { failed.push(`${name}: ${e.message.split('\n')[0]}`); log('FAIL step', name, e.message.split('\n')[0]); await m?.screenshot({ path: path.join(TMP, `fail-${name}.png`) }).catch(() => {}); } }

/** Local only, USE_PROXY=1: this sandbox's browser has no internet, so each real listing's own image is fetched with curl
 *  through the egress proxy and shown as the same bytes. Listing data is unchanged. Hosted runs load images normally. */
async function loadListingImages(p) {
  if (HOSTED || process.env.USE_PROXY !== '1') return;
  const srcs = await p.locator('[data-card="product_cards"] img').evaluateAll((is) => [...new Set(is.map((i) => i.getAttribute('src')).filter((u) => u && u.startsWith('https://')))]);
  for (const u of srcs) {
    let body = null; try { body = execFileSync('curl', ['-sSL', '-m', '20', u], { maxBuffer: 20e6 }); } catch { continue; }
    if (!body?.length) continue;
    const type = body[0] === 0x89 ? 'image/png' : body[0] === 0x52 ? 'image/webp' : 'image/jpeg';
    const data = `data:${type};base64,${body.toString('base64')}`;
    await p.evaluate(([src, d]) => document.querySelectorAll('img').forEach((i) => { if (i.getAttribute('src') === src) { i.setAttribute('loading', 'eager'); i.src = d; } }), [u, data]).catch(() => {});
  }
  await sleep(500);
}

let m;
try {
  // ---------- Public pages ----------
  const pub = await context(1440); const pp = await pub.newPage();
  await pp.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 });
  await step('landing', async () => {
    await snap(pp, 'g01/01-landing', { hl: pp.locator('button:visible', { hasText: 'Try as Mary' }) });
    await at(pp, 390); await snap(pp, 'g01/01-landing', { hl: pp.locator('button:visible', { hasText: 'Try as Mary' }) });
  });
  await pub.close();

  // ---------- Mary (phone width; desktop shots resize the same tab so the conversation is kept) ----------
  const mc = await context(390); m = await mc.newPage();
  if (!HOSTED) await m.route('https://www.sandbox.paypal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html lang="en"><title>PayPal Sandbox (local stub)</title><main><h1>Local stub for PayPal’s page</h1></main></html>' }));
  await m.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 });
  await m.locator('button:visible', { hasText: 'Try as Mary' }).first().click();
  await m.waitForURL(/\/assistant/, { timeout: 90000 }); await m.waitForSelector('#assistant-input');
  await last(m, 'demo_welcome').waitFor({ timeout: 20000 });

  await step('welcome', async () => {
    await snap(m, 'g01/02-welcome', { top: last(m, 'demo_welcome'), hl: last(m, 'demo_welcome') });
    await at(m, 1440); await snap(m, 'g01/02-welcome', { top: last(m, 'demo_welcome'), hl: last(m, 'demo_welcome') }); await at(m, 390);
  });

  // Guide 3: have I already paid?
  await step('already-paid', async () => {
    await ask(m, 'I received a message saying I owe €120. Can you check whether I already paid?', 'payment_matches'); await sleep(900);
    await snap(m, 'g03/01-owe-120', { top: last(m, 'payment_matches'), hl: last(m, 'payment_matches').getByText(/Sample data/).first() });
    await at(m, 1440); await snap(m, 'g03/01-owe-120', { top: last(m, 'payment_matches') }); await at(m, 390);
    await ask(m, 'Did I already pay John €80?', 'payment_matches'); await sleep(900);
    await snap(m, 'g03/02-john-duplicate', { top: last(m, 'payment_matches'), hl: last(m, 'payment_matches').getByText(/duplicate/i).first() });
  });

  // Guide 2: scam checks with the three training examples
  await step('training', async () => {
    await last(m, 'demo_welcome').getByRole('button', { name: 'Check this suspicious message' }).click();
    await last(m, 'training_examples').waitFor({ timeout: 20000 }); await sleep(500);
    await snap(m, 'g02/01-training-examples', { top: last(m, 'training_examples'), hl: last(m, 'training_examples').getByRole('button', { name: 'Check this training example' }).first() });
    const names = ['02-fake-invoice', '03-hi-mum', '04-order-notice'];
    for (let i = 0; i < 3; i++) {
      if (PACE) await sleep(PACE);
      const before = await m.locator('[data-card="scam_result"]').count();
      await m.locator('[data-card="training_examples"]').last().getByRole('button', { name: 'Check this training example' }).nth(i).click();
      await m.waitForFunction((n) => document.querySelectorAll('[data-card="scam_result"]').length > n, before, { timeout: 45000 }); await sleep(800);
      await snap(m, `g02/${names[i]}`, { top: last(m, 'scam_result'), hl: last(m, 'scam_result').locator('h2, h3, [data-verdict]').first() });
      if (i === 0) { await at(m, 1440); await snap(m, `g02/${names[i]}`, { top: last(m, 'scam_result') }); await at(m, 390); }
    }
  });

  // Guide 4: real products through Channel3 (+ the separate Demo Shop offer)
  await step('real-products', async () => {
    await ask(m, 'Can you help me buy a microwave instead?');
    const shops = m.getByRole('list', { name: 'Shop listings' }).last(); await shops.waitFor({ timeout: 45000 });
    await m.getByRole('list', { name: 'Demo Shop options' }).last().waitFor({ timeout: 20000 }).catch(() => {});
    const card = m.locator('[data-card="product_cards"]').filter({ has: m.getByRole('list', { name: 'Shop listings' }) }).last();
    await sleep(1500); await loadListingImages(m); // listing images
    await snap(m, 'g04/01-listings', { top: card, hl: card.getByText('You buy on the shop’s own website').first() });
    await at(m, 1440); await snap(m, 'g04/01-listings', { top: card }); await at(m, 390);
    await card.getByRole('list', { name: 'Shop listings' }).getByRole('button').first().click();
    const sheet = m.getByRole('dialog').last(); await sheet.waitFor({ timeout: 10000 }); await sleep(500);
    await snap(m, 'g04/02-listing-detail', { hl: sheet.getByRole('link', { name: /View on retailer site/ }) });
    await m.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await card.getByRole('button', { name: 'Compare' }).click(); await last(m, 'compare').waitFor({ timeout: 10000 }).catch(() => {}); await sleep(600);
    if (await m.locator('[data-card="compare"]').count()) await snap(m, 'g04/03-compare', { top: last(m, 'compare') });
    const offer = m.getByRole('list', { name: 'Demo Shop options' }).last();
    if (await offer.count()) await snap(m, 'g04/04-demo-shop-offer', { top: offer, hl: offer });
  });

  // Guides 5 + 6: Demo Shop purchase over €75 → family review → Alex approves → Continue to PayPal
  let orderId = null;
  await step('purchase', async () => {
    await ask(m, "Let's buy the demo microwave.", 'payment_prep');
    const prep = last(m, 'payment_prep');
    await snap(m, 'g05/01-purchase-card', { top: prep, hl: prep.getByRole('button', { name: /^Allow/ }) });
    await at(m, 1440); await snap(m, 'g05/01-purchase-card', { top: prep }); await at(m, 390);
    await prep.getByRole('button', { name: /^Allow/ }).click();
    const fam = last(m, 'family_status'); await fam.getByText('Pending').waitFor({ timeout: 20000 });
    orderId = (await fam.locator('a[href^="/order/"]').getAttribute('href')).split('/').pop();
    await snap(m, 'g06/01-mary-waiting', { top: fam, hl: fam.getByTestId('try-as-alex-card') });
  });

  await step('alex', async () => {
    await last(m, 'family_status').getByTestId('try-as-alex-card').click();
    await leaveIfAsked(m);
    await m.waitForURL(/\/family\/assistant/, { timeout: 20000 });
    const review = last(m, 'family_review'); await review.waitFor({ timeout: 20000 }); await sleep(600);
    await snap(m, 'g06/02-alex-review', { top: review, hl: review.getByRole('button', { name: 'Approve' }) });
    await at(m, 1440); await snap(m, 'g06/02-alex-review', { top: review }); await at(m, 390);
    if (PACE) await sleep(PACE);
    await review.getByRole('button', { name: 'Approve' }).click(); await review.getByText('Approved').first().waitFor({ timeout: 15000 });
    await snap(m, 'g06/03-alex-approved', { top: review, hl: review.getByText('Approved').first() });
    await m.goto(BASE + '/family'); await m.waitForLoadState('networkidle'); await sleep(800);
    await at(m, 1440); await snap(m, 'g06/04-alex-family-home'); await at(m, 390);
    await m.goto(BASE + '/family/insights'); await m.waitForLoadState('networkidle'); await sleep(1500);
    await at(m, 1440); await snap(m, 'g12/03-alex-insights'); await at(m, 390);
    await snap(m, 'g12/03-alex-insights');
    // Back to Mary: the Profile link a family member sees while trying the demo.
    await m.goto(BASE + '/profile?as=family'); await m.waitForLoadState('networkidle');
    const back = m.getByRole('link', { name: /Back to Mary/ });
    await snap(m, 'g06/05-back-to-mary', { top: m.locator('#family-h').first(), hl: back });
    await back.click(); await m.waitForURL(/\/home/, { timeout: 20000 });
  });

  await step('mary-approved', async () => {
    await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input');
    const cont = last(m, 'family_status').getByRole('button', { name: 'Continue to PayPal' }); await cont.waitFor({ timeout: 25000 });
    await snap(m, 'g06/06-mary-approved', { top: last(m, 'family_status'), hl: cont });
    await snap(m, 'g05/02-continue-to-paypal', { top: last(m, 'family_status'), hl: cont });
  });

  // PayPal step. Never screenshotted. Local: mock approval. Hosted: buyer login from the environment, if given.
  let realReceipt = false;
  await step('paypal', async () => {
    // Hosted without a buyer login: don't even create a PayPal order. Receipt shots are skipped, not mocked.
    if (HOSTED && !(BUYER.email && BUYER.password)) throw new Error('hosted run without PAYPAL_BUYER_EMAIL/PAYPAL_BUYER_PASSWORD: no PayPal order created, receipt shots skipped');
    await last(m, 'family_status').getByRole('button', { name: 'Continue to PayPal' }).click();
    await m.waitForURL(/sandbox\.paypal\.com/, { timeout: 40000 });
    if (!HOSTED) {
      const token = new URL(m.url()).searchParams.get('token');
      const ap = await (await fetch(`${MOCK}/mock/approve/${token}`, { method: 'POST' })).json();
      await m.goto(ap.returnUrl.replace(/^https?:\/\/[^/]+/, BASE));
    } else if (BUYER.email && BUYER.password) {
      await m.locator('#email').fill(BUYER.email, { timeout: 30000 }).catch(() => {});
      await m.locator('#btnNext').click({ timeout: 5000 }).catch(() => {});
      await m.locator('#password').fill(BUYER.password, { timeout: 30000 });
      await m.locator('#btnLogin').click();
      await m.locator('#payment-submit-btn, [data-testid="submit-button-initial"]').first().click({ timeout: 60000 });
      await m.waitForURL((u) => u.href.startsWith(BASE), { timeout: 90000 });
    } else { throw new Error('hosted run without PAYPAL_BUYER_EMAIL/PAYPAL_BUYER_PASSWORD: receipt shots left as they were'); }
    await m.getByTestId('order-state').waitFor({ timeout: 40000 });
    await m.locator('main').getByText(/Verification pending|Verified — signed/).first().waitFor({ timeout: 40000 });
    realReceipt = HOSTED;
    if (HOSTED) { await sleep(20000); await m.reload(); await m.getByTestId('order-state').waitFor({ timeout: 40000 }); }
  });
  const rr = { paypal: true, realReceipt };
  // Activity and Insights: on the hosted app these show real hosted data (no mock ids), so they are taken even without the buyer step.
  const rv = { paypal: true, realReceipt: realReceipt || HOSTED };
  await step('receipt', async () => {
    if (!(await m.getByTestId('order-state').count())) throw new Error('no receipt page (PayPal step did not complete)');
    await snap(m, 'g05/03-back-from-paypal', { ...rr, hl: m.getByTestId('order-state') });
    await at(m, 1440); await snap(m, 'g07/02-receipt-page', { ...rr }); await at(m, 390);
    const tl = m.getByRole('heading', { name: /timeline|evidence/i }).first();
    if (await tl.count()) await snap(m, 'g07/03-timeline', { ...rr, top: tl });
    await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input');
    await ask(m, 'Did my payment go through?', 'receipt');
    await snap(m, 'g07/01-receipt-card', { ...rr, top: last(m, 'receipt'), hl: last(m, 'receipt') });
  });

  // Guide 8: Activity
  await step('activity', async () => {
    await m.goto(BASE + '/activity'); await m.waitForLoadState('networkidle'); await sleep(1000);
    await at(m, 1440); await snap(m, 'g08/01-activity', { ...rv }); await at(m, 390);
    const search = m.getByRole('searchbox').first();
    if (await search.count()) { await search.fill('microwave'); await search.press('Enter'); await sleep(1200); await snap(m, 'g08/02-search', { ...rv, hl: search }); await search.fill(''); await search.press('Enter'); await sleep(600); }
    const filters = m.locator('main [role="group"], main fieldset').first();
    if (await filters.count()) await snap(m, 'g08/03-filters', { ...rv, top: filters, hl: filters });
  });

  // Guide 9: subscriptions
  await step('subscriptions', async () => {
    await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input');
    await ask(m, 'Show my subscriptions', 'subscriptions_list');
    await snap(m, 'g09/01-subscriptions', { top: last(m, 'subscriptions_list'), hl: last(m, 'subscriptions_list').getByText(/Sample data/).first() });
    await ask(m, 'Cancel my streaming subscription');
    await sleep(1200);
    const help = m.locator('[data-card="subscription_help"], [data-card="demo_cancel_intent"]').last();
    if (await help.count()) await snap(m, 'g09/02-cancel-help', { top: help, hl: help });
    const tryDm = last(m, 'subscriptions_list').getByRole('button', { name: 'Try the Demo Membership' });
    if (await tryDm.count()) { await tryDm.click(); await last(m, 'demo_membership').waitFor({ timeout: 20000 }); await sleep(600); await snap(m, 'g09/03-demo-membership', { top: last(m, 'demo_membership'), hl: last(m, 'demo_membership').getByRole('button', { name: 'Start Demo Membership' }) }); }
  });

  // Guide 10: trusted contacts + send-money hand-off
  await step('contacts', async () => {
    await ask(m, 'Find Alex in my contacts', 'contact_card');
    await snap(m, 'g10/01-find-alex', { top: last(m, 'contact_card'), hl: last(m, 'contact_card') });
    await ask(m, 'Send Alex €50', 'send_money');
    const card = last(m, 'send_money');
    await card.getByRole('button', { name: /Choose/ }).first().click();
    await card.getByRole('button', { name: 'Yes, these details are right' }).click();
    await last(m, 'send_money').getByTestId('paypal-send-link').waitFor({ timeout: 15000 });
    await snap(m, 'g10/02-send-money', { top: last(m, 'send_money'), hl: last(m, 'send_money').getByTestId('paypal-send-link') });
  });

  // Guide 11: voice
  await step('voice', async () => {
    const speak = m.getByRole('button', { name: /^Speak|Start listening|Tap to speak/ }).first();
    await m.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    if (await speak.count()) await snap(m, 'g11/02-speak-button', { hl: speak });
    await m.goto(BASE + '/profile'); await m.waitForLoadState('networkidle');
    await snap(m, 'g11/01-voice-settings', { top: m.locator('#voice-h').first(), hl: m.locator('#voice-h').first().locator('xpath=ancestor::section[1]') });
  });

  // Guide 12: Mary's insights (+ Home card)
  await step('insights', async () => {
    await m.goto(BASE + '/home'); await m.getByTestId('home-insights').waitFor({ timeout: 20000 }); await sleep(800);
    await snap(m, 'g01/03-home', { hl: m.locator('nav[aria-label="Shortcuts"]') });
    await snap(m, 'g12/01-home-insights-card', { top: m.getByTestId('home-insights'), hl: m.getByRole('link', { name: /View insights/ }) });
    await m.goto(BASE + '/insights'); await m.locator('#spending').waitFor({ timeout: 20000 }); await sleep(800);
    await at(m, 1440); await snap(m, 'g12/02-mary-insights', { ...rv }); await at(m, 390);
    await snap(m, 'g12/02-mary-insights', { ...rv });
  });

  // Guide 13: settings and accessibility
  await step('settings', async () => {
    await m.goto(BASE + '/profile'); await m.waitForLoadState('networkidle'); await sleep(500);
    await at(m, 1440); await snap(m, 'g13/01-profile'); await at(m, 390);
    await snap(m, 'g13/02-accessibility', { top: m.locator('#a11y-h').first(), hl: m.locator('#a11y-h').first().locator('xpath=ancestor::section[1]') });
    await snap(m, 'g01/04-demo-help', { top: m.locator('#demohelp-h'), hl: m.getByTestId('reset-demo') });
    await m.goto(BASE + '/assistant'); await m.waitForSelector('#assistant-input'); await m.evaluate(() => window.scrollTo(0, 0));
    await m.getByRole('button', { name: /^Menu/ }).click(); await m.getByRole('button', { name: 'Display' }).click(); await sleep(400);
    await snap(m, 'g13/03-assistant-menu', { hl: m.getByRole('group', { name: 'Conversation options' }) });
    await m.keyboard.press('Escape');
  });

  // Guide 14: troubleshooting — a sample order can't be paid or checked with PayPal
  await step('troubleshooting', async () => {
    const act = await m.evaluate(async () => (await (await fetch('/api/activity?type=payment&limit=50')).json()));
    const items = act.items ?? act;
    const sample = items.find((i) => i.example && /PAYER_APPROVAL_PENDING|CAPTURE_PENDING/.test(i.state ?? ''));
    if (sample) { await m.goto(BASE + `/order/${sample.id}`); await m.getByTestId('sample-order').waitFor({ timeout: 15000 }); await sleep(500); await snap(m, 'g14/01-sample-order', { hl: m.getByTestId('sample-order') }); }
  });
} catch (e) {
  failed.push(`fatal: ${e.message.split('\n')[0]}`); log('FATAL', e);
} finally {
  manifest.generatedAt = new Date().toISOString(); manifest.lastBase = HOSTED ? BASE : 'local';
  manifest.shots = Object.fromEntries(Object.entries(manifest.shots).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  await browser.close();
  log(`\n${done.length} shots written, ${skipped.length} skipped, ${failed.length} failed`);
  if (skipped.length) log('skipped:', skipped.join(' | '));
  if (failed.length) { log('failed:', failed.join('\n  ')); process.exitCode = 1; }
}
