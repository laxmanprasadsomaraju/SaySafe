// REAL end-to-end on PayPal's hosted sandbox checkout page (guest card flow, fictional test buyer).
// 1) SaySafe creates the order (server). 2) A browser approves it on www.sandbox.paypal.com.
// 3) PayPal redirects back to SaySafe's return URL, which confirms + captures and shows the receipt.
// Usage: node scripts/paypal-hosted-e2e.mjs [baseUrl]   (needs HTTPS_PROXY in this sandbox only)
import { chromium } from 'playwright';
const BASE = process.argv[2] ?? 'http://localhost:8787';
const OUT = process.env.OUT ?? '/tmp/e2e';
const local = await chromium.launch(); const lctx = await local.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const lp = await lctx.newPage();
const api = (method, u, body) => lp.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [method, u, body]);
await lp.goto(BASE + '/'); await api('POST', '/api/demo/start', { name: 'Mary' });
const created = await api('POST', '/api/payments', { items: [{ productId: 'kettle-classic', quantity: 1 }], idempotencyKey: 'hosted' + Date.now() });
const reqId = created.body.request.id; console.log('SaySafe request', reqId, created.body.request.state, created.body.approveUrl);

// Refresh / lost callback cannot invent success: confirm before payer approval must fail.
const early = await api('POST', `/api/payments/${reqId}/confirm`, { orderId: new URL(created.body.approveUrl).searchParams.get('token') });
console.log('confirm before PayPal approval ->', early.status, early.body.error ?? early.body.state);

const pu = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const remote = await chromium.launch(pu ? { proxy: { server: `${pu.protocol}//${pu.host}`, username: decodeURIComponent(pu.username) || undefined, password: decodeURIComponent(pu.password) || undefined } } : {});
const ctx = await remote.newContext({ viewport: { width: 1200, height: 900 }, locale: 'en-IE', ignoreHTTPSErrors: true });
let returnUrl = null;
const baseHost = new URL(BASE).host;
await ctx.route((u) => u.host === baseHost, (route) => { returnUrl = route.request().url(); route.abort(); });
const p = await ctx.newPage();
await p.goto(created.body.approveUrl, { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {});
await p.waitForTimeout(8000);
for (let i = 0; i < 3; i++) {
  await p.locator('#createAccount').click({ timeout: 30000 }).catch(() => {});
  if (await p.locator('input[name=cardNumber]').waitFor({ timeout: 20000 }).then(() => true).catch(() => false)) break;
}
await p.screenshot({ path: `${OUT}/paypal-hosted-guest.png`, timeout: 10000 }).catch(() => {});
const byLabel = async (label, v) => { const l = p.getByLabel(label, { exact: false }).first(); try { await l.click({ timeout: 8000 }); await l.pressSequentially(v, { delay: 30 }); } catch { console.log('fill fail', String(label)); } };
await byLabel(/Email Address/i, `saysafe.test.${Date.now()}@example.com`);
await byLabel(/Phone number/i, '851234567');
await byLabel(/Card number/i, '4032039317984658');
await byLabel(/Expiry date/i, '1230');
await byLabel(/CVV/i, '123');
await byLabel(/First name/i, 'Mary');
await byLabel(/Last name/i, 'Testbuyer');
await byLabel(/Address line 1/i, '1 Test Street');
await byLabel(/Town|City/i, 'Limerick');
const county = p.getByLabel(/County/i).first(); await county.selectOption({ index: 15 }).catch(() => console.log('county select fail'));
await p.getByText(/Save info & create your PayPal account/i).first().click({ timeout: 5000 }).catch(() => console.log('toggle text fail'));
await p.waitForTimeout(1000);
if (await p.getByLabel(/Create password/i).first().isVisible().catch(() => false)) {
  console.log('account switch still on: filling fictional sandbox details');
  await byLabel(/Create password/i, 'Sandbox#' + Date.now().toString().slice(-6));
  await byLabel(/Date of birth/i, '01011950');
}
await p.waitForTimeout(1500);
await p.screenshot({ path: `${OUT}/paypal-hosted-filled.png`, fullPage: true, timeout: 10000 }).catch(() => {});
await p.getByRole('button', { name: /Agree and (Pay|Continue)|Pay Now|Continue/i }).first().click({ timeout: 15000 });
for (let i = 0; i < 40 && !returnUrl; i++) await p.waitForTimeout(1000);
if (!returnUrl) {
  await p.screenshot({ path: `${OUT}/paypal-hosted-stuck.png`, timeout: 10000 }).catch(() => {});
  console.log('NO RETURN. url:', p.url()); console.log((await p.locator('body').innerText().catch(() => '')).slice(0, 800));
} else {
  console.log('PayPal redirected back to:', returnUrl.replace(/PayerID=[^&]+/, 'PayerID=***'));
  // Follow the real return URL in SaySafe's UI: it confirms + captures server-side and shows the receipt.
  await lp.goto(returnUrl.replace(/^https?:\/\/[^/]+/, BASE)); 
  await lp.getByText(/Paid|Payment complete|receipt/i).first().waitFor({ timeout: 45000 }).catch(() => {});
  await lp.waitForTimeout(1500);
  await lp.screenshot({ path: `${OUT}/receipt-mobile.png`, fullPage: true });
  const final = await api('GET', `/api/payments/${reqId}`);
  const f = final.body; console.log('FINAL', JSON.stringify({ state: f.state, amountCents: f.amountCents, currency: f.currency, orderId: f.paypalOrderId, captureId: f.paypalCaptureId, captureStatus: f.captureStatus, receipt: f.receipt }).slice(0, 600));
  // Duplicate capture attempt after success
  const dup = await api('POST', `/api/payments/${reqId}/confirm`, { orderId: f.paypalOrderId ?? new URL(returnUrl).searchParams.get('token') });
  console.log('second confirm ->', dup.status, dup.body.state, 'captureId same:', dup.body.paypalCaptureId === f.paypalCaptureId);
}
await remote.close(); await local.close();
