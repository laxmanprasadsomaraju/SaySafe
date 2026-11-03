/**
 * GET /api/activity: household isolation, role rules, filters and pagination. PayPal is a TEST DOUBLE here.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

const orders = new Map<string, any>();
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => orders.get(id)),
  captureOrder: vi.fn(async (id: string) => orders.get(id)),
  refundCapture: vi.fn(async () => ({ status: 'COMPLETED' })),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: () => false,
  approveLink: (o: any) => o.links[0].href,
}));

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { groupOf } from '../server/activity';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
const key = () => 'k' + Math.random().toString(36).slice(2, 14);
async function elder() { const a = request.agent(app); await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200); return a; }
async function familyFor(e: ReturnType<typeof request.agent>) {
  const { body } = await e.post('/api/family/invite').set(H).send({}).expect(200);
  const f = request.agent(app);
  await f.post('/api/family/pair').set(H).send({ code: body.code, name: 'Alex' }).expect(200);
  return f;
}
const buy = (a: any, productId: string) => a.post('/api/payments').set(H).send({ items: [{ productId, quantity: 1 }], idempotencyKey: key() }).expect(200);
const hhOf = (reqId: string) => (db.prepare('SELECT household_id h FROM payment_requests WHERE id=?').get(reqId) as any).h as string;

describe('GET /api/activity', () => {
  it('requires a session', async () => {
    await request(app).get('/api/activity').expect(401);
  });

  it('never returns another household\'s payments or scans', async () => {
    const mary = await elder();
    const other = await elder();
    const mine = (await buy(mary, 'kettle-classic')).body.request.id;
    const theirs = (await buy(other, 'toaster')).body.request.id;
    await other.post('/api/scan').set(H).send({ text: 'Your PayPal account is suspended, verify at http://paypa1-secure.example now' }).expect(200);
    const r = await mary.get('/api/activity').expect(200);
    const ids = r.body.items.map((i: any) => i.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(r.body.items.every((i: any) => i.type === 'payment' ? hhOf(i.id) === hhOf(mine) : true)).toBe(true);
    expect(r.body.items.some((i: any) => i.type === 'scan')).toBe(false);
    // The request cannot pick a household.
    const forced = await mary.get(`/api/activity?household=${hhOf(theirs)}&householdId=${hhOf(theirs)}`).expect(200);
    expect(forced.body.items.map((i: any) => i.id)).not.toContain(theirs);
  });

  it('merges payments, family decisions and scans, newest first, with sandbox labels', async () => {
    const mary = await elder();
    const alex = await familyFor(mary);
    const big = (await buy(mary, 'microwave')).body.request;
    expect(big.state).toBe('FAMILY_APPROVAL_PENDING');
    await alex.post(`/api/family/requests/${big.id}/decision`).set(H).send({ decision: 'decline', approvalId: big.approval.id }).expect(200);
    await mary.post('/api/scan').set(H).send({ text: 'URGENT your PayPal is limited, call +1 800 000 0000' }).expect(200);
    const r = await mary.get('/api/activity').expect(200);
    const pay = r.body.items.find((i: any) => i.id === big.id);
    expect(pay).toMatchObject({ type: 'payment', status: 'CANCELLED', statusGroup: 'cancelled', amountCents: 12000, currency: 'EUR', sandbox: true, captured: false, href: `/order/${big.id}` });
    expect(pay.approval.status).toBe('declined');
    expect(r.body.items.some((i: any) => i.type === 'scan' && i.verdict)).toBe(true);
    const times = r.body.items.map((i: any) => i.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('family sees only purchases routed to them for review (not under-limit ones) and only scans the elder shared', async () => {
    const mary = await elder();
    const alex = await familyFor(mary);
    const a = (await mary.post('/api/scan').set(H).send({ text: 'Your PayPal account is suspended, verify at http://paypa1-secure.example now' }).expect(200)).body;
    await mary.post('/api/scan').set(H).send({ text: 'Another odd PayPal message http://paypal.login-check.example' }).expect(200);
    await mary.post(`/api/scan/${a.scanId}/share`).set(H).send({}).expect(200);
    const kettle = (await buy(mary, 'kettle-classic')).body.request.id; // €32: under Mary's limit -> private
    const micro = (await buy(mary, 'microwave')).body.request.id; // €120: above the limit -> sent to family for review
    const r = await alex.get('/api/activity?as=family').expect(200);
    expect(r.body.role).toBe('family');
    const scans = r.body.items.filter((i: any) => i.type === 'scan');
    expect(scans.map((s: any) => s.id)).toEqual([a.scanId]);
    const pays = r.body.items.filter((i: any) => i.type === 'payment').map((i: any) => i.id);
    expect(pays).toContain(micro);
    expect(pays).not.toContain(kettle);
  });

  it('filters by text, status, type, amount and date', async () => {
    const mary = await elder();
    const k = (await buy(mary, 'kettle-classic')).body.request.id; // €32 pending at PayPal
    const t = (await buy(mary, 'toaster')).body.request.id; // €29
    await mary.post(`/api/payments/${t}/cancel`).set(H).send({}).expect(200);
    const m = (await buy(mary, 'microwave')).body.request.id; // €120 waiting for family
    const hh = hhOf(k);
    // A refund state from the refund branch, and an unknown future state: both must list without errors.
    db.prepare("UPDATE payment_requests SET state='REFUNDED', created_at='2026-01-05 10:00:00' WHERE id=?").run(k);
    db.prepare("INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint) VALUES (?,?,?,?,?,?,?,?)")
      .run('pay_future_state1', hh, 'REFUND_REQUESTED', JSON.stringify([{ name: 'Easy Tune Radio', quantity: 1 }]), 'SaySafe Demo Shop', 3900, 'EUR', 'fp');
    db.prepare("INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint) VALUES (?,?,?,?,?,?,?,?)")
      .run('pay_future_state2', hh, 'SOMETHING_NEW', JSON.stringify([{ name: 'Mystery', quantity: 1 }]), 'SaySafe Demo Shop', 100, 'EUR', 'fp2');

    const ids = async (qs: string) => (await mary.get(`/api/activity?${qs}`).expect(200)).body.items.map((i: any) => i.id);
    expect(await ids('q=toaster')).toEqual([t]);
    expect(await ids('item=MICROWAVE')).toEqual([m]);
    expect(await ids('status=cancelled')).toEqual([t]);
    expect((await ids('status=refunded')).sort()).toEqual([k, 'pay_future_state1'].sort());
    expect(await ids('status=pending')).toEqual([m]);
    expect(await ids('status=other')).toEqual(['pay_future_state2']);
    expect((await ids('min=30&max=40')).sort()).toEqual([k, 'pay_future_state1'].sort());
    expect(await ids('min=100')).toEqual([m]);
    expect(await ids('from=2026-01-01&to=2026-01-31')).toEqual([k]);
    expect(await ids('type=scan')).toEqual([]);
    await mary.get('/api/activity?status=bogus').expect(400);
    await mary.get('/api/activity?from=yesterday').expect(400);
    await mary.get('/api/activity?limit=500').expect(400);
  });

  it('shows a buyer refund request as REFUND_REQUESTED (never refunded) and refund states as they are', async () => {
    const mary = await elder();
    const a = (await buy(mary, 'kettle-classic')).body.request.id;
    const c = (await buy(mary, 'toaster')).body.request.id;
    const hh = hhOf(a);
    db.prepare("UPDATE payment_requests SET state='CAPTURED', paypal_capture_id=? WHERE id=?").run('CAPQA' + a.slice(-6), a);
    db.prepare("INSERT INTO refund_requests (id, request_id, household_id, requested_by, status) VALUES (?,?,?,?,?)").run('rr_' + a, a, hh, 'usr_x', 'REFUND_REQUESTED');
    db.prepare("UPDATE payment_requests SET state='REFUND_PENDING' WHERE id=?").run(c);
    const items = (await mary.get('/api/activity?status=refunded').expect(200)).body.items;
    const byId = Object.fromEntries(items.map((i: any) => [i.id, i]));
    expect(byId[a]).toMatchObject({ status: 'REFUND_REQUESTED', state: 'CAPTURED' });
    expect(byId[a].refundLabel).toMatch(/not refunded yet/);
    expect(byId[c]).toMatchObject({ status: 'REFUND_PENDING' });
  });

  it('paginates without gaps or repeats', async () => {
    const mary = await elder();
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await buy(mary, 'toaster')).body.request.id);
    const p1 = (await mary.get('/api/activity?limit=2&page=1').expect(200)).body;
    const p2 = (await mary.get('/api/activity?limit=2&page=2').expect(200)).body;
    const p3 = (await mary.get('/api/activity?limit=2&page=3').expect(200)).body;
    expect(p1.total).toBe(5);
    expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false]);
    const all = [...p1.items, ...p2.items, ...p3.items].map((i: any) => i.id);
    expect(new Set(all).size).toBe(5);
    expect(all.sort()).toEqual(made.sort());
  });

  it('groups unknown states as other instead of failing', () => {
    expect(groupOf('REFUND_REQUESTED')).toBe('refunded');
    expect(groupOf('PARTIALLY_REFUNDED')).toBe('refunded');
    expect(groupOf('CAPTURED')).toBe('paid');
    expect(groupOf('REFUND_PENDING')).toBe('refunded');
    expect(groupOf('WHATEVER')).toBe('other');
  });

  it('family status for the elder lists only names', async () => {
    const mary = await elder();
    await familyFor(mary);
    const r = await mary.get('/api/family/status').expect(200);
    expect(r.body.active).toEqual([{ name: 'Alex' }]);
    expect(Object.keys(r.body.active[0])).toEqual(['name']);
  });
});
