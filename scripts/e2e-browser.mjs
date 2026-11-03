// Browser end-to-end + axe audit against a running server. node scripts/e2e-browser.mjs [baseUrl]
import { chromium, devices } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const BASE = process.argv[2] ?? 'http://localhost:8787';
const OUT = process.env.OUT ?? '/tmp/e2e';
const results = []; const axeOut = [];
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const axe = async (page, label) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  axeOut.push({ label, violations: r.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0]?.target}`) });
};
const post = (page, url, body) => page.evaluate(async ([u, b]) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body]);

const px = process.env.HTTPS_PROXY || process.env.https_proxy;
let proxy;
if (px && !/localhost|127\.0\.0\.1/.test(BASE)) { const u = new URL(px); proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined }; }
const browser = await chromium.launch(proxy ? { proxy } : {});
try {
  // Landing, desktop + mobile
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await d.goto(BASE + '/'); await d.waitForLoadState('networkidle');
  await d.screenshot({ path: `${OUT}/landing-desktop.png`, fullPage: true }); await axe(d, 'landing desktop');
  ok('landing explains product', await d.getByRole('heading', { level: 1 }).isVisible());

  const mctx = await browser.newContext({ ...devices['iPhone 13'] });
  const m = await mctx.newPage();
  await m.goto(BASE + '/'); await m.waitForLoadState('networkidle');
  await m.screenshot({ path: `${OUT}/landing-mobile.png`, fullPage: true }); await axe(m, 'landing mobile');

  // Elder: start demo -> home
  await m.getByRole('button', { name: /Try it free as Mary/ }).first().click();
  await m.waitForURL('**/check'); ok('Try it as Mary opens the guided scam check', true);
  await m.goto(BASE + '/home'); await m.waitForLoadState('networkidle');
  await m.screenshot({ path: `${OUT}/home-mobile.png`, fullPage: true }); await axe(m, 'home mobile');
  const tiles = await m.locator('nav[aria-label="Shortcuts"] button').count();
  ok('home has 4 shortcuts', tiles === 4, `found ${tiles}`);
  const tabs = await m.locator('nav[aria-label="Main"] a').evaluateAll((as) => as.filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.textContent));
  ok('one bottom nav: Home, Assistant, Activity, Profile', tabs.join() === 'Home,Assistant,Activity,Profile', tabs.join());
  ok('no display buttons in the header, no idle voice bar', (await m.locator('header button').count()) === 0 && (await m.getByTestId('voice-bar').count()) === 0);
  ok('home shows at most one outstanding action', (await m.locator('#next-h').count()) <= 1);
  await m.getByRole('button', { name: /Check a message/ }).click(); await m.waitForURL('**/assistant');
  ok('Check a message opens the Assistant in check mode', await m.locator('#assistant-input').isVisible());

  // Check a fake support message
  await m.goto(BASE + '/check'); await m.waitForLoadState('networkidle');
  await m.getByRole('button', { name: /Account suspended/ }).click();
  await m.getByText(/Suspicious/).first().waitFor({ timeout: 30000 });
  await m.waitForTimeout(800);
  await m.screenshot({ path: `${OUT}/check-scam-mobile.png`, fullPage: true }); await axe(m, 'check result mobile');
  ok('fake PayPal support flagged', true);

  // Official contact page + malicious lookalike + invoice via API
  const scan = async (text) => (await post(m, '/api/scan', { text })).body.verdict;
  ok('official PayPal contact recognised', ['verified_official_contact', 'no_obvious_warning_signs'].includes(await scan('https://www.paypal.com/ie/cshelp/contact-us'))); // three public verdicts since the scam calibration
  ok('malicious PayPal-looking link rejected', (await scan('http://paypal.com.secure-login-help.net/verify')) === 'suspicious');
  ok('genuine PayPal invoice not called safe', (await scan('https://www.paypal.com/invoice/p/#INV2-AB12')) !== 'verified_official_contact');

  // Family pairing (second browser = family member's phone)
  const inv = await post(m, '/api/family/invite', {});
  const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const f = await fctx.newPage(); await f.goto(BASE + '/family');
  const pr = await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
  ok('family pairs with one-time code', pr.status === 200);

  // Large purchase awaits approval
  const big = await post(m, '/api/payments', { items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: 'e2e' + Date.now() });
  ok('large purchase awaits family approval', big.body.request?.state === 'FAMILY_APPROVAL_PENDING', big.body.request?.state);
  await m.goto(`${BASE}/order/${big.body.request.id}`); await m.waitForLoadState('networkidle');
  await m.screenshot({ path: `${OUT}/order-awaiting-mobile.png`, fullPage: true }); await axe(m, 'order awaiting mobile');

  // Family member declines in HIS Assistant (review card with the exact item and amount)
  await f.goto(BASE + '/family'); await f.waitForLoadState('networkidle');
  await f.screenshot({ path: `${OUT}/family-dashboard.png`, fullPage: true }); await axe(f, 'family dashboard');
  await f.goto(BASE + '/family/assistant'); await f.waitForLoadState('networkidle');
  const review = f.locator('[data-card="family_review"]').last(); await review.waitFor({ timeout: 20000 });
  ok('family review card in the family Assistant shows the server amount', /€120\.00/.test(await review.innerText()));
  await f.screenshot({ path: `${OUT}/family-assistant.png`, fullPage: true }); await axe(f, 'family assistant');
  await review.getByRole('button', { name: 'Decline' }).click();
  await f.waitForTimeout(1500);
  const co = await post(m, `/api/payments/${big.body.request.id}/checkout`, {});
  ok('family decline prevents payment', co.status === 409, `checkout -> ${co.status}`);
  await m.reload(); await m.waitForLoadState('networkidle');
  await m.screenshot({ path: `${OUT}/order-declined-mobile.png`, fullPage: true });

  // Small purchase goes to real PayPal sandbox approval page
  const small = await post(m, '/api/payments', { items: [{ productId: 'kettle-classic', quantity: 1 }], idempotencyKey: 'e2e-s' + Date.now() });
  ok('small purchase creates real sandbox order', /sandbox\.paypal\.com/.test(small.body.approveUrl ?? ''), small.body.request?.state);
  if (small.body.approveUrl) {
    await m.goto(small.body.approveUrl, { timeout: 45000 }).catch(() => {});
    await m.waitForTimeout(4000);
    ok('redirects to PayPal sandbox approval page', /paypal\.com/.test(m.url()), m.url().slice(0, 60));
    await m.screenshot({ path: `${OUT}/paypal-approval-mobile.png`, timeout: 15000 }).catch(() => {});
  }
} catch (e) { ok('script error', false, String(e).slice(0, 300)); }
finally {
  await browser.close();
  console.log('\nAXE'); for (const a of axeOut) console.log(a.label, a.violations.length ? a.violations : 'no violations');
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
}
