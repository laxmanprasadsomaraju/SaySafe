/**
 * REAL PayPal sandbox smoke test of SaySafe's server flow.
 * Payer approval normally happens on PayPal's page; here, for an unattended test only,
 * the order is approved with PayPal's sandbox test card via confirm-payment-source.
 * Then SaySafe's own confirmAndCapture() re-reads the order and captures it.
 *   DATABASE_FILE=:memory: npx tsx scripts/paypal-smoke.ts
 */
import { db } from '../server/db/index.js';
import * as pay from '../server/payments/service.js';

const BASE = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';

async function token() {
  const r = await fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  return ((await r.json()) as any).access_token as string;
}

const hh = 'hh_smoke_' + Date.now();
db.prepare("INSERT INTO users (id,name,role) VALUES ('u_smoke','Mary','elder')").run();
db.prepare('INSERT INTO households (id, elder_id) VALUES (?,?)').run(hh, 'u_smoke');
db.prepare('INSERT INTO spending_policies (household_id) VALUES (?)').run(hh);

const { request, approveUrl } = await pay.createRequest(hh, 'u_smoke', [{ productId: 'kettle-classic', quantity: 1 }], 'smoke' + Date.now(), 'https://example.invalid');
console.log('1. request', request.id, request.state, '\n   approve at:', approveUrl);
const orderId = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(request.id) as any).o;

const t = await token();
const conf = await fetch(`${BASE}/v2/checkout/orders/${orderId}/confirm-payment-source`, {
  method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ payment_source: { card: { number: '4032039317984658', expiry: '2030-12', name: 'Sandbox Test', security_code: '123' } } }),
});
const cj = (await conf.json()) as any;
console.log('2. sandbox test-card approval:', conf.status, cj.status ?? cj.name);

const done = await pay.confirmAndCapture(hh, 'u_smoke', request.id, orderId);
console.log('3. SaySafe verified + captured:', done.state, done.receipt);
if (done.state !== 'CAPTURED') process.exit(1);
