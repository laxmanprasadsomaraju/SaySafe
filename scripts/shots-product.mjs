// Captures genuine SaySafe product states for the landing page showcases.
// node scripts/shots-product.mjs [base] — needs a running server. RECEIPT_COOKIE=<ss_elder of a session with a real captured sandbox order> RECEIPT_ID=pay_...
import { chromium } from 'playwright';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const OUT = process.env.OUT ?? 'web/public/screens';
const b = await chromium.launch();
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' };
const post = (page, url, body) => page.evaluate(async ([u, x]) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [url, body]);
const shot = async (p, name, focus) => {
  if (focus) await p.locator(focus).first().scrollIntoViewIfNeeded().catch(() => {});
  if (focus) await p.evaluate(() => window.scrollBy(0, -120));
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${name}.png` }); console.log('saved', name);
};

const m = await (await b.newContext(phone)).newPage();
await m.goto(BASE + '/'); await post(m, '/api/demo/start', { name: 'Mary' });
// 1. Scam check on the sample invoice
await m.goto(BASE + '/check'); await m.getByRole('button', { name: /invoice/i }).first().click();
await m.getByText(/Suspicious|Needs checking/).first().waitFor({ timeout: 45000 });
await m.waitForTimeout(1200);
await shot(m, 'check-result', 'text=/Suspicious|Needs checking/');
// 2. Voice shopping (typed request; same assistant path as speech)
await m.goto(BASE + '/shop'); await m.fill('#q', 'I need a kettle'); await m.getByRole('button', { name: 'Find' }).click();
await m.getByRole('button', { name: /^Choose / }).first().waitFor({ timeout: 45000 }); await m.waitForTimeout(800);
await shot(m, 'shop-voice');
// 3. Family: large purchase waits, family sees request
const inv = await post(m, '/api/family/invite', {});
const f = await (await b.newContext(phone)).newPage(); await f.goto(BASE + '/');
await post(f, '/api/family/pair', { code: inv.body.code, name: 'Alex' });
const big = await post(m, '/api/payments', { items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: 'shots' + Date.now() });
await m.goto(`${BASE}/order/${big.body.request.id}`); await m.waitForLoadState('networkidle'); await m.waitForTimeout(600);
await shot(m, 'family-waiting');
await f.goto(BASE + '/family'); await f.waitForLoadState('networkidle'); await f.waitForTimeout(600);
await shot(f, 'family-request', 'text=/Approve/');
// 4. Real captured sandbox receipt
if (process.env.RECEIPT_COOKIE && process.env.RECEIPT_ID) {
  const ctx = await b.newContext(phone);
  await ctx.addCookies([{ name: 'ss_elder', value: process.env.RECEIPT_COOKIE, url: BASE }]);
  const r = await ctx.newPage(); await r.goto(`${BASE}/order/${process.env.RECEIPT_ID}`); await r.waitForLoadState('networkidle'); await r.waitForTimeout(800);
  await shot(r, 'receipt');
}
await b.close();
