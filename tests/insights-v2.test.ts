/**
 * Insights v2: Mary's /api/insights/summary now answers "what did I buy, cancel, look at, who do I trust, what was
 * flagged" from her own data only. Expected numbers come from the sample definitions (shared/demoData.ts) and the
 * rows this test writes, never copied from the endpoint. Alex's family views must not gain any of it.
 * Also: the webhook verification body carries the raw event bytes (P1).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

vi.hoisted(() => { process.env.API_LIMIT_PER_MIN = '5000'; process.env.AI_SESSION_LIMIT_PER_MIN = '1000'; process.env.COMPANION_LIMIT_PER_MIN = '5000'; });

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { sha } from '../server/auth';
import { getProduct } from '../server/catalogue/products';
import { recordProducts } from '../server/memory/store';
import { statusBucket } from '../server/insights/summary';
import { verifyRequestBody } from '../server/paypal/client';
import { SAMPLE_SHOP, SAMPLE_CONTACTS } from '../shared/demoData';
import { InsightsSummary } from '../shared/insightsSummary';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
beforeAll(() => { process.env.DEMO_SEED = 'on'; });

async function mary() {
  const a = request.agent(app);
  const r = await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
  const tok = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ss_elder='))!.split(';')[0].split('=')[1];
  const s = db.prepare('SELECT household_id, user_id FROM sessions WHERE token_hash=?').get(sha(decodeURIComponent(tok))) as { household_id: string; user_id: string };
  return { a, hh: s.household_id, uid: s.user_id };
}
let n = 0;
function realPurchase(hh: string, productId: string, state: string, approval: 'approved' | 'declined' | 'pending' | null = null) {
  const p = getProduct(productId)!;
  const id = `pay_v2test${String(++n).padStart(6, '0')}${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, captured_amount, captured_currency, paypal_capture_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, hh, state, JSON.stringify([{ productId: p.id, name: p.name, quantity: 1, unitCents: p.priceCents }]), 'SaySafe Demo Shop', p.priceCents, p.currency, `fp_${id}`,
    state === 'CAPTURED' ? (p.priceCents / 100).toFixed(2) : null, state === 'CAPTURED' ? p.currency : null, state === 'CAPTURED' ? `CAP${id.slice(-10).toUpperCase()}` : null);
  if (approval) db.prepare('INSERT INTO approvals (id, request_id, fingerprint, status, nonce, expires_at, created_at) VALUES (?,?,?,?,?,?,datetime(\'now\'))')
    .run(`apr_${id}`, id, `fp_${id}`, approval, `nonce_${id}`, Date.now() + 86_400_000);
  return { id, name: p.name, cents: p.priceCents };
}

describe('statusBucket', () => {
  it('maps each state + approval to one outcome', () => {
    expect(statusBucket('CAPTURED', null)).toBe('paid');
    expect(statusBucket('CANCELLED', 'declined')).toBe('declined');
    expect(statusBucket('CANCELLED', null)).toBe('cancelled');
    expect(statusBucket('BLOCKED', null)).toBe('cancelled');
    expect(statusBucket('FAMILY_APPROVAL_PENDING', 'expired')).toBe('expired');
    expect(statusBucket('FAMILY_APPROVAL_PENDING', 'pending')).toBe('waiting');
    expect(statusBucket('CAPTURE_PENDING', null)).toBe('waiting');
    expect(statusBucket('FAILED', null)).toBe('failed');
    expect(statusBucket('REFUND_PENDING', null)).toBe('refunded');
  });
});

describe('Mary: Insights v2 from her own data', () => {
  it('fresh Try as Mary: sample outcomes, contacts, cancelled and approvals are labelled sample; nothing real is invented', async () => {
    const { a } = await mary();
    const s = (await a.get('/api/insights/summary').expect(200)).body;
    expect(InsightsSummary.safeParse(s).success).toBe(true);
    const shop = SAMPLE_SHOP.filter((x) => getProduct(x.productId));
    const want = { paid: 0, waiting: 0, cancelled: 0, declined: 0, failed: 0, refunded: 0, expired: 0 } as Record<string, number>;
    for (const x of shop) want[statusBucket(x.state, x.approval)!]++;
    expect(s.payments.sample.byStatus).toEqual(want);
    expect(Object.values(s.payments.sandboxByStatus).every((v) => v === 0)).toBe(true);
    // Approvals: real none, sample from the definitions.
    expect(s.approvals.real).toEqual({ requested: 0, pending: 0, approved: 0, declined: 0, expired: 0 });
    expect(s.approvals.sample.requested).toBe(shop.filter((x) => x.approval).length);
    expect(s.approvals.sample.declined).toBe(shop.filter((x) => x.approval === 'declined').length);
    expect(s.approvals.sample.expired).toBe(shop.filter((x) => x.approval === 'expired').length);
    // Contacts: all sample, names + relations only.
    expect(s.contacts).toMatchObject({ total: SAMPLE_CONTACTS.length, own: 0, sample: SAMPLE_CONTACTS.length });
    expect(s.contacts.list.every((c: any) => c.sample === true && !('phone' in c) && !('email' in c))).toBe(true);
    for (const c of SAMPLE_CONTACTS) { if (c.phone) expect(JSON.stringify(s)).not.toContain(c.phone); }
    // Cancelled orders: the sample cancelled + declined ones, labelled sample.
    const cancelledShop = shop.filter((x) => x.state === 'CANCELLED');
    expect(s.cancelled.orders).toHaveLength(cancelledShop.length);
    expect(s.cancelled.orders.every((o: any) => o.kind === 'sample')).toBe(true);
    expect(s.cancelled.orders.filter((o: any) => o.how === 'declined')).toHaveLength(cancelledShop.filter((x) => x.approval === 'declined').length);
    expect(s.cancelled.subscriptions).toEqual([]);
    // Funnel: nothing looked at yet; sample purchases never counted.
    expect(s.shopping).toMatchObject({ productsLooked: 0, searches: 0, purchasesStarted: 0, purchasesPaid: 0, lookedAndBought: 0 });
  });

  it('real purchases, funnel, own contact and a cancelled subscription; sample and real never mixed', async () => {
    const { a, hh, uid } = await mary();
    // What she looked at: one Assistant search showing two Demo Shop products, one real-shop search showing one listing.
    const kettle = getProduct('kettle-classic')!; const radio = getProduct('radio')!;
    recordProducts(hh, uid, [kettle, radio].map((p) => ({ productId: `demo:${p.id}`, title: p.name, price: p.priceCents / 100, currency: p.currency, retailer: 'SaySafe Demo Shop', item: { id: p.id } })), 'demo', 'kettle');
    recordProducts(hh, uid, [{ productId: 'c3_abc123', title: 'Quiet microwave 20L', price: 89, currency: 'EUR', retailer: 'Some Shop', item: { id: 'c3_abc123' } }], 'channel3', 'quiet microwave');
    // Real (app-flow) purchases: kettle paid, radio failed, toaster cancelled, microwave over limit declined by family.
    const paid = realPurchase(hh, 'kettle-classic', 'CAPTURED');
    realPurchase(hh, 'radio', 'FAILED');
    realPurchase(hh, 'toaster', 'CANCELLED');
    const declined = realPurchase(hh, 'microwave', 'CANCELLED', 'declined');
    await a.post('/api/companion/contacts').set(H).send({ name: 'Neighbour Nora', relation: 'neighbour', phone: '+353 1 555 0199' }).expect(201);
    const sub = (await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Garden Weekly', amountCents: 500, currency: 'EUR', frequency: 'monthly' }).expect(201)).body;
    const subId = sub.id ?? sub.subscription?.id;
    await a.post(`/api/companion/subscriptions/${subId}/status`).set(H).send({ to: 'instructions_opened' }).expect(200);
    await a.post(`/api/companion/subscriptions/${subId}/status`).set(H).send({ to: 'user_reported_cancelled', note: 'Phoned them' }).expect(200);

    const s = (await a.get('/api/insights/summary').expect(200)).body;
    expect(InsightsSummary.safeParse(s).success).toBe(true);
    expect(s.payments.sandboxByStatus).toEqual({ paid: 1, waiting: 0, cancelled: 1, declined: 1, failed: 1, refunded: 0, expired: 0 });
    // Paid total is the real capture only; the sample column is unchanged and separate.
    expect(s.payments.sandbox.captured).toEqual({ count: 1, totals: [{ currency: kettle.currency, cents: paid.cents }] });
    expect(s.payments.sample.byStatus.paid).toBe(SAMPLE_SHOP.filter((x) => x.state === 'CAPTURED' && getProduct(x.productId)).length);
    expect(s.approvals.real).toEqual({ requested: 1, pending: 0, approved: 0, declined: 1, expired: 0 });
    expect(s.shopping).toMatchObject({ productsLooked: 3, demoProducts: 2, channel3Products: 1, searches: 2, purchasesStarted: 4, purchasesPaid: 1, lookedAndBought: 1 });
    expect(s.contacts).toMatchObject({ total: SAMPLE_CONTACTS.length + 1, own: 1 });
    expect(JSON.stringify(s.contacts)).not.toContain('555 0199');
    expect(s.cancelled.orders.filter((o: any) => o.kind === 'sandbox').map((o: any) => o.how).sort()).toEqual(['cancelled', 'declined']);
    expect(s.cancelled.orders.find((o: any) => o.id === declined.id)?.how).toBe('declined');
    expect(s.cancelled.subscriptions).toEqual([expect.objectContaining({ merchant: 'Garden Weekly', kind: 'user_entered', how: 'you_reported' })]);

    // ---------- Alex: none of this reaches the family views ----------
    const res = await a.post('/api/demo/alex').set(H).send({}).expect(200);
    const fam = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ss_family='))!.split(';')[0];
    const fs = (await request(app).get('/api/insights/summary?as=family').set('Cookie', fam).expect(200)).body;
    expect(fs.role).toBe('family');
    expect(fs.shopping).toBeNull(); expect(fs.contacts).toBeNull(); expect(fs.cancelled).toBeNull();
    const fi = (await request(app).get('/api/family/insights').set('Cookie', fam).expect(200)).body;
    const PRIVATE = ['Neighbour Nora', '555 0199', 'Garden Weekly', 'Quiet microwave', 'quiet microwave', 'c3_abc123', paid.id, kettle.name, radio.name];
    for (const blob of [JSON.stringify(fs), JSON.stringify(fi)]) for (const p of PRIVATE) expect(blob, p).not.toContain(p);
    // The over-limit (reviewed) request is visible to Alex; the under-limit paid one is not counted for him.
    expect(fi.payments.some((p: any) => p.id === declined.id)).toBe(true);
    expect(fi.kpis.sandboxCaptured.count).toBe(0);
    expect(fs.payments.sandbox.captured.count).toBe(0);
    expect(fs.approvals.real.declined).toBe(1);
  });
});

describe('P1: webhook verification sends the raw event bytes', () => {
  it('splices the body unchanged (number format, escapes, key order) into valid JSON', () => {
    const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"10.10"},"n":1.50,"note":"caf\\u00e9 \\/ ok","z":1,"a":2}}';
    const body = verifyRequestBody({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-id': 't1' }, raw, 'WHID');
    expect(body).toContain(`"webhook_event":${raw}}`);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ auth_algo: 'SHA256withRSA', transmission_id: 't1', webhook_id: 'WHID', webhook_event: { id: 'WH-1' } });
    expect(JSON.stringify(parsed.webhook_event)).not.toBe(raw); // proof that re-serialising would have changed the bytes
  });
  it('refuses a body that is not one JSON object (no injection into the envelope)', () => {
    expect(() => verifyRequestBody({}, '[1,2]', 'W')).toThrow();
    expect(() => verifyRequestBody({}, '{"a":1}, "webhook_id":"evil"', 'W')).toThrow();
    expect(() => verifyRequestBody({}, 'not json', 'W')).toThrow();
  });
});
