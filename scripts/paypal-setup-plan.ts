/**
 * Idempotent setup of the "SaySafe Demo Membership" PayPal SANDBOX plan (€2.99/month).
 * Finds the product + plan by name and price, creating them only when missing (fixed PayPal-Request-Ids, so a
 * re-run after a timeout cannot create duplicates). Prints the plan id for the env var PAYPAL_DEMO_PLAN_ID.
 * Never hardcode the id in code.
 *
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npx tsx scripts/paypal-setup-plan.ts
 *
 * Optional (for testing the buyer flow without the app):
 *   npx tsx scripts/paypal-setup-plan.ts --probe-subscription <householdId> <publicOrigin>
 *       creates a subscription with custom_id=<householdId> and prints PayPal's approve link
 *   npx tsx scripts/paypal-setup-plan.ts --get <I-subscriptionId>
 *   npx tsx scripts/paypal-setup-plan.ts --cancel <I-subscriptionId>     (prints the HTTP status, then GETs it)
 * Sandbox only. Prints no secrets.
 */
export {};
const BASE = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
if (!/^https:\/\/api-m\.sandbox\.paypal\.com\/?$/.test(BASE)) throw new Error('Sandbox only.');
const PRODUCT_NAME = 'SaySafe Demo Membership';
const PLAN_NAME = 'SaySafe Demo Membership €2.99/month';

function creds() {
  const c = process.env.PAYPAL_CREDENTIALS;
  if (c && c.includes(':')) { const i = c.indexOf(':'); return `${c.slice(0, i)}:${c.slice(i + 1)}`; }
  return `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`;
}
async function token(): Promise<string> {
  const r = await fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(creds()).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!r.ok) throw new Error(`OAuth failed: ${r.status}`);
  return ((await r.json()) as any).access_token;
}
async function api(t: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: r.status, data };
}

const t = await token();
const [flag, a1, a2] = process.argv.slice(2);

if (flag === '--get' || flag === '--cancel') {
  if (!/^I-[A-Z0-9]+$/.test(a1 ?? '')) throw new Error('Give a subscription id like I-XXXX');
  if (flag === '--cancel') {
    const c = await api(t, 'POST', `/v1/billing/subscriptions/${a1}/cancel`, { reason: 'SaySafe setup script cancel (sandbox)' });
    console.log('cancel ->', c.status, c.data ? JSON.stringify(c.data) : '(no body)');
  }
  const g = await api(t, 'GET', `/v1/billing/subscriptions/${a1}`);
  console.log('get ->', g.status, JSON.stringify({ id: g.data?.id, status: g.data?.status, status_update_time: g.data?.status_update_time, custom_id: g.data?.custom_id, plan_id: g.data?.plan_id }));
  process.exit(0);
}

// 1. Product (find by name, else create with a fixed request id)
const products = await api(t, 'GET', '/v1/catalogs/products?page_size=20&total_required=true');
let product = (products.data?.products ?? []).find((p: any) => p.name === PRODUCT_NAME);
if (!product) {
  const c = await api(t, 'POST', '/v1/catalogs/products', { name: PRODUCT_NAME, description: 'SaySafe Demo Shop sandbox membership. No real money.', type: 'SERVICE', category: 'SOFTWARE' }, { 'PayPal-Request-Id': 'saysafe-demo-membership-product-v1' });
  if (c.status >= 300) throw new Error(`Create product failed: ${c.status} ${JSON.stringify(c.data)}`);
  product = c.data;
  console.log('created product', product.id);
} else console.log('found product', product.id);

// 2. Plan (find an ACTIVE plan with the same name on that product, else create)
const plans = await api(t, 'GET', `/v1/billing/plans?product_id=${product.id}&page_size=20`);
let plan = (plans.data?.plans ?? []).find((p: any) => p.name === PLAN_NAME && p.status === 'ACTIVE');
if (!plan) {
  const c = await api(t, 'POST', '/v1/billing/plans', {
    product_id: product.id, name: PLAN_NAME, description: 'Monthly SaySafe Demo Membership (sandbox)', status: 'ACTIVE',
    billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: '2.99', currency_code: 'EUR' } } }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 1 },
  }, { 'PayPal-Request-Id': `saysafe-demo-membership-plan-v1-${product.id}` });
  if (c.status >= 300) throw new Error(`Create plan failed: ${c.status} ${JSON.stringify(c.data)}`);
  plan = c.data;
  console.log('created plan', plan.id);
} else console.log('found plan', plan.id);
const full = await api(t, 'GET', `/v1/billing/plans/${plan.id}`);
const price = full.data?.billing_cycles?.[0]?.pricing_scheme?.fixed_price;
console.log(`plan ${plan.id}: ${full.data?.status} ${price?.value} ${price?.currency_code} every ${full.data?.billing_cycles?.[0]?.frequency?.interval_count} ${full.data?.billing_cycles?.[0]?.frequency?.interval_unit}`);
console.log(`\nPAYPAL_DEMO_PLAN_ID=${plan.id}`);

if (flag === '--probe-subscription') {
  if (!a1 || !a2) throw new Error('Usage: --probe-subscription <householdId> <publicOrigin>');
  const s = await api(t, 'POST', '/v1/billing/subscriptions', {
    plan_id: plan.id, custom_id: a1,
    application_context: { brand_name: 'SaySafe Demo Shop', user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: `${a2}/api/companion/subscriptions/demo/return`, cancel_url: `${a2}/api/companion/subscriptions/demo/return?declined=1` },
  }, { 'PayPal-Request-Id': `saysafe-probe-${a1}-${Date.now()}` });
  console.log('subscription', s.status, s.data?.id, s.data?.status);
  console.log('approve at:', (s.data?.links ?? []).find((l: any) => l.rel === 'approve')?.href);
}
