/**
 * Refund lifecycle + Payments v2 capture lookup. PayPal is a TEST DOUBLE (vi.mock) whose refund/capture objects
 * follow the shapes recorded from a real sandbox refund (tests/fixtures/paypal-refund-*.json).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';

const pp = vi.hoisted(() => {
  process.env.ADMIN_LIMIT_PER_MIN = '1000';
  return {
    orders: new Map<string, any>(),
    captures: new Map<string, any>(),
    refunds: new Map<string, any>(),
    byKey: new Map<string, any>(),
    refundCalls: [] as { capId: string; key: string; customId?: string }[],
    realRefunds: 0,
    refundMode: 'ok' as 'ok' | 'timeout' | '5xx_before' | '422' | 'pending',
    getCaptureMode: 'ok' as 'ok' | 'net',
    getRefundMode: 'ok' as 'ok' | 'net',
    delayMs: 0,
    onRefund: null as null | ((ref: any) => void),
  };
});

const REFUND_FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/paypal-refund-response.json', import.meta.url), 'utf8'));
const REFUND_GET_FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/paypal-refund-get.json', import.meta.url), 'utf8'));
const CAPTURE_FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/paypal-capture-get.json', import.meta.url), 'utf8'));
const CAPTURE_REFUNDED_FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/paypal-capture-refunded-get.json', import.meta.url), 'utf8'));
const FULLY_REFUNDED_422 = JSON.parse(fs.readFileSync(new URL('./fixtures/paypal-refund-422-fully-refunded.json', import.meta.url), 'utf8'));

const err = (status: number, data?: any) => Object.assign(new Error(`PayPal ${status}`), { status, data });

vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(),
  getOrder: vi.fn(async (id: string) => pp.orders.get(id)),
  captureOrder: vi.fn(),
  getCapture: vi.fn(async (id: string) => {
    if (pp.getCaptureMode === 'net') throw new Error('ETIMEDOUT');
    const c = pp.captures.get(id);
    if (!c) throw err(404, { name: 'RESOURCE_NOT_FOUND' });
    return JSON.parse(JSON.stringify(c));
  }),
  refundCapture: vi.fn(async (capId: string, key: string, customId?: string) => {
    pp.refundCalls.push({ capId, key, customId });
    if (pp.delayMs) await new Promise((r) => setTimeout(r, pp.delayMs));
    const replay = pp.byKey.get(key);
    if (replay) return JSON.parse(JSON.stringify(replay)); // PayPal-Request-Id replay: same refund, no new money movement
    if (pp.refundMode === '5xx_before') throw err(503, { name: 'SERVICE_UNAVAILABLE' });
    if (pp.refundMode === '422') throw err(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'REFUND_NOT_ALLOWED' }] });
    const cap = pp.captures.get(capId);
    if (cap.status === 'REFUNDED') throw err(422, FULLY_REFUNDED_422);
    const id = 'REF' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const ref = {
      ...REFUND_FIXTURE, id, amount: { ...cap.amount }, custom_id: customId,
      status: pp.refundMode === 'pending' ? 'PENDING' : 'COMPLETED',
      links: [{ href: `https://api.sandbox.paypal.com/v2/payments/refunds/${id}`, rel: 'self', method: 'GET' }, { href: `https://api.sandbox.paypal.com/v2/payments/captures/${capId}`, rel: 'up', method: 'GET' }],
    };
    pp.realRefunds++;
    if (ref.status === 'COMPLETED') cap.status = 'REFUNDED';
    pp.refunds.set(id, ref);
    pp.byKey.set(key, ref);
    pp.onRefund?.(ref);
    if (pp.refundMode === 'timeout') throw new Error('The operation was aborted due to timeout'); // refunded at PayPal, answer lost
    return JSON.parse(JSON.stringify(ref));
  }),
  getRefund: vi.fn(async (id: string) => {
    if (pp.getRefundMode === 'net') throw new Error('ECONNRESET');
    const r = pp.refunds.get(id);
    if (!r) throw err(404, { name: 'RESOURCE_NOT_FOUND' });
    return { ...JSON.parse(JSON.stringify(r)), payer: { merchant_id: 'F2JQY6Z9P5J2U' } };
  }),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: () => null,
}));

import { db } from '../server/db/index';
import { createApp } from '../server/app';
import * as pay from '../server/payments/service';
import { reconcile, __resetReconcileThrottle } from '../server/payments/reconcile';
import { adminRefund, checkAdminToken, refundCaptureId, refundFromWebhook, __resetRefundState } from '../server/payments/refund';
import { buildTimeline } from '../server/payments/timeline';
import { assertTransition, TransitionError } from '../server/payments/stateMachine';
import * as client from '../server/paypal/client';
import { DEMO_MERCHANT } from '../server/catalogue/products';

const app = createApp();
const TOKEN = 'test-admin-token-0123456789abcdef';
const rnd = () => Math.random().toString(36).slice(2, 12);
const row = (id: string) => db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id) as any;
const refundRow = (id: string) => db.prepare('SELECT * FROM refunds WHERE request_id=?').get(id) as any;
const getCaptureMock = client.getCapture as unknown as ReturnType<typeof vi.fn>;

function household() {
  const hh = 'hh_' + rnd(), u = 'usr_' + rnd();
  db.prepare("INSERT INTO users (id,name,role) VALUES (?,?,'elder')").run(u, 'Mary');
  db.prepare('INSERT INTO households (id, elder_id) VALUES (?,?)').run(hh, u);
  db.prepare('INSERT INTO spending_policies (household_id, approval_threshold_cents) VALUES (?,?)').run(hh, 7500);
  return { hh, u };
}

/** A captured Demo Shop payment, known to the PayPal double (order + Payments v2 capture). */
function captured(hh: string, opts: { cents?: number; state?: string; captureAmount?: string; captureCurrency?: string; captureCustomId?: string; merchant?: string } = {}) {
  const id = 'pay_' + rnd(), oid = 'ORDER' + rnd().toUpperCase(), cap = 'CAP' + rnd().toUpperCase();
  const cents = opts.cents ?? 3200;
  const value = (cents / 100).toFixed(2);
  db.prepare(`INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, paypal_order_id, paypal_capture_id, captured_amount, captured_currency, payee_name, idempotency_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, hh, opts.state ?? 'CAPTURED', JSON.stringify([{ productId: 'kettle-classic', name: 'Kettle', unitCents: cents, quantity: 1, lineCents: cents, image: 'k.jpg' }]),
    opts.merchant ?? DEMO_MERCHANT, cents, 'EUR', 'fp', oid, cap, value, 'EUR', 'SaySafe Demo Shop', 'k' + rnd());
  pp.captures.set(cap, {
    ...CAPTURE_FIXTURE, id: cap, status: 'COMPLETED', custom_id: opts.captureCustomId ?? id,
    amount: { currency_code: opts.captureCurrency ?? 'EUR', value: opts.captureAmount ?? value },
    supplementary_data: { related_ids: { order_id: oid } },
  });
  pp.orders.set(oid, { id: oid, status: 'COMPLETED', purchase_units: [{ custom_id: id, amount: { currency_code: 'EUR', value }, payments: { captures: [{ id: cap, status: 'COMPLETED', amount: { currency_code: 'EUR', value } }] } }] });
  return { id, oid, cap };
}

const admin = (id: string, body: object = {}, token: string | null = TOKEN) => {
  const r = request(app).post(`/api/admin/payments/${id}/refund`).set('Content-Type', 'application/json');
  return (token == null ? r : r.set('X-Admin-Token', token)).send(body);
};

function refundEvent(eventId: string, ref: any, overrides: any = {}) {
  return { id: eventId, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource_type: 'refund', create_time: ref.create_time, resource: { ...ref, ...overrides } };
}
const postWebhook = (ev: any) => request(app).post('/api/paypal/webhook').set('Content-Type', 'application/json').send(JSON.stringify(ev));

async function elderAgent() {
  const a = request.agent(app);
  const name = 'E' + rnd();
  await a.post('/api/demo/start').send({ name }).expect(200);
  const hh = (db.prepare('SELECT h.id FROM households h JOIN users u ON u.id=h.elder_id WHERE u.name=?').get(name) as any).id as string;
  return { a, hh };
}
async function familyAgent(elder: ReturnType<typeof request.agent>) {
  const { body } = await elder.post('/api/family/invite').send({}).expect(200);
  const f = request.agent(app);
  await f.post('/api/family/pair').send({ code: body.code, name: 'Alex' }).expect(200);
  return f;
}

beforeEach(() => {
  process.env.ADMIN_TOKEN = TOKEN;
  pp.refundCalls.length = 0; pp.realRefunds = 0; pp.refundMode = 'ok'; pp.getCaptureMode = 'ok'; pp.getRefundMode = 'ok'; pp.delayMs = 0; pp.onRefund = null;
  __resetRefundState(); __resetReconcileThrottle();
});

describe('fixtures recorded from the real sandbox', () => {
  it('refund response / GET refund / GET capture shapes are what the code relies on', () => {
    expect(REFUND_FIXTURE.status).toBe('COMPLETED');
    expect(REFUND_FIXTURE.amount).toEqual({ currency_code: 'EUR', value: '32.00' });
    expect(refundCaptureId(REFUND_FIXTURE)).toBe('7GW748197L509353B');
    expect(REFUND_GET_FIXTURE.id).toBe(REFUND_FIXTURE.id);
    expect(REFUND_GET_FIXTURE.payer).toBeUndefined(); // stripped before committing
    expect(CAPTURE_FIXTURE.status).toBe('COMPLETED');
    expect(CAPTURE_FIXTURE.supplementary_data.related_ids.order_id).toMatch(/^[A-Z0-9]+$/);
    expect(CAPTURE_REFUNDED_FIXTURE.status).toBe('REFUNDED');
    expect(FULLY_REFUNDED_422.details[0].issue).toBe('CAPTURE_FULLY_REFUNDED');
  });
});

describe('who may refund', () => {
  it('family members cannot refund: the old family route is gone and the admin route needs the merchant token', async () => {
    const { a, hh } = await elderAgent();
    const f = await familyAgent(a);
    const { id } = captured(hh);
    const old = await f.post(`/api/family/requests/${id}/refund`).send({});
    expect(old.status).toBe(404);
    expect((await f.post(`/api/admin/payments/${id}/refund`).send({})).status).toBe(401);
    expect(row(id).state).toBe('CAPTURED');
    expect(pp.refundCalls.length).toBe(0);
  });

  it('the elder cannot refund; "Request a refund" records a request only (REFUND_REQUESTED), clearly labelled', async () => {
    const { a, hh } = await elderAgent();
    const { id } = captured(hh);
    expect((await a.post(`/api/admin/payments/${id}/refund`).send({})).status).toBe(401);
    const res = await a.post(`/api/payments/${id}/refund-request`).send({ reason: 'Arrived broken' }).expect(200);
    expect(res.body.state).toBe('CAPTURED');
    expect(res.body.refund).toMatchObject({ status: 'REFUND_REQUESTED', label: 'Request sent — not refunded yet', canRequest: false });
    expect(res.body.timeline.events.map((e: any) => e.kind)).toContain('refund_asked');
    expect(res.body.timeline.pending).toContain('Refund request sent — not refunded yet');
    await a.post(`/api/payments/${id}/refund-request`).send({}).expect(200); // double tap
    expect((db.prepare('SELECT COUNT(*) n FROM refund_requests WHERE request_id=?').get(id) as any).n).toBe(1);
    expect(pp.refundCalls.length).toBe(0);
    expect(row(id).state).toBe('CAPTURED');
  });

  it('missing admin token -> 401, wrong token -> 403', async () => {
    const { hh } = household();
    const { id } = captured(hh);
    expect((await admin(id, {}, null)).status).toBe(401);
    const wrong = await admin(id, {}, TOKEN.slice(0, -1) + 'X');
    expect(wrong.status).toBe(403);
    expect((await admin(id, {}, 'short')).status).toBe(403);
    expect(pp.refundCalls.length).toBe(0);
    expect(row(id).state).toBe('CAPTURED');
  });

  it('refunds are disabled (503 "Refunds not enabled") without ADMIN_TOKEN, or with a too-short one', async () => {
    const { hh } = household();
    const { id } = captured(hh);
    delete process.env.ADMIN_TOKEN;
    const r = await admin(id);
    expect(r.status).toBe(503);
    expect(r.body.message).toBe('Refunds not enabled');
    process.env.ADMIN_TOKEN = 'too-short';
    expect((await admin(id, {}, 'too-short')).status).toBe(503);
    expect(pp.refundCalls.length).toBe(0);
  });

  it('token comparison: equal only for the exact token', () => {
    expect(checkAdminToken(TOKEN)).toBe('ok');
    expect(checkAdminToken(TOKEN + ' ')).toBe('wrong');
    expect(checkAdminToken('')).toBe('missing');
    expect(checkAdminToken(undefined)).toBe('missing');
    delete process.env.ADMIN_TOKEN;
    expect(checkAdminToken(TOKEN)).toBe('disabled');
  });
});

describe('admin refund', () => {
  it('happy path: PayPal key stored before the call, response verified, GET refund confirms, webhook correlated + deduped', async () => {
    const { a, hh } = await elderAgent();
    const { id, cap } = captured(hh);
    await a.post(`/api/payments/${id}/refund-request`).send({}).expect(200);
    const res = await admin(id).expect(200);
    expect(res.body).toMatchObject({ status: 'REFUNDED', outcome: 'refunded', duplicate: false });
    expect(res.body.refundId).toMatch(/^REF/);
    expect(pp.refundCalls).toEqual([{ capId: cap, key: `refund-${id}-1`, customId: id }]);
    const rr = refundRow(id);
    expect(rr).toMatchObject({ paypal_request_id: `refund-${id}-1`, status: 'COMPLETED', refund_id: res.body.refundId, amount: '32.00', currency: 'EUR' });
    expect(row(id).state).toBe('REFUNDED');
    expect((db.prepare('SELECT status FROM refund_requests WHERE request_id=?').get(id) as any).status).toBe('REFUNDED');
    // audit order: key recorded (refund.requested) before PayPal's answer (evidence.refund_completed)
    const actions = (db.prepare('SELECT action FROM audit_log WHERE target=? ORDER BY id').all(id) as any[]).map((x) => x.action);
    expect(actions.indexOf('payment.CAPTURED->REFUND_PENDING')).toBeLessThan(actions.indexOf('evidence.refund_completed'));
    expect(actions).toContain('payment.REFUND_PENDING->REFUNDED');

    const ref = pp.refunds.get(res.body.refundId);
    const w1 = await postWebhook(refundEvent('WH-R1', ref)).expect(200);
    expect(w1.body.outcome).toBe('already_refunded');
    expect((await postWebhook(refundEvent('WH-R1', ref)).expect(200)).body.duplicate).toBe(true);
    const t = buildTimeline(row(id));
    const kinds = t.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['capture_verified', 'refund_asked', 'refund_requested', 'refund_completed', 'refund_verified', 'refund_webhook']));
    expect(kinds.indexOf('refund_requested')).toBeLessThan(kinds.indexOf('refund_completed'));
    expect(t.events.find((e) => e.kind === 'refund_completed')!.source).toMatch(/PayPal refund response/);
    expect(t.events.find((e) => e.kind === 'refund_verified')!.source).toMatch(/Payments v2 · refund/);
    expect(t.events.find((e) => e.kind === 'capture_verified')!.source).toMatch(/Payments v2 · capture/);
    expect(t.pending).not.toContain('Signed PayPal refund notice not received yet');
    const view = (await a.get(`/api/payments/${id}`).expect(200)).body;
    expect(view.refund).toMatchObject({ status: 'REFUNDED', refundId: res.body.refundId });
    expect(view.receipt).not.toBeNull();
  });

  it('already refunded: a second call returns the same result with no PayPal call; PayPal-side refund is not repeated', async () => {
    const { hh } = household();
    const { id, cap } = captured(hh);
    const first = await admin(id).expect(200);
    const again = await admin(id).expect(200);
    expect(again.body).toMatchObject({ status: 'REFUNDED', outcome: 'already_refunded', duplicate: true, refundId: first.body.refundId });
    expect(pp.refundCalls.length).toBe(1);

    // Refunded at PayPal (e.g. in the PayPal dashboard) but still CAPTURED here: no POST, record follows PayPal.
    const b = captured(hh);
    pp.captures.get(b.cap).status = 'REFUNDED';
    const r = await admin(b.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('already_refunded');
    expect(pp.refundCalls.length).toBe(1);
    expect(row(b.id).state).toBe('REFUNDED');
    expect(cap).toBeTruthy();
  });

  it('duplicate concurrent refund calls make exactly one PayPal refund call and get the same result', async () => {
    const { hh } = household();
    const { id } = captured(hh);
    pp.delayMs = 150;
    const [x, y, z] = await Promise.all([admin(id), admin(id), adminRefund(id, 'merchant-admin')]);
    expect(pp.refundCalls.length).toBe(1);
    expect(pp.realRefunds).toBe(1);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(new Set([x.body.refundId, y.body.refundId, z.refundId]).size).toBe(1);
    expect([x.body.duplicate, y.body.duplicate, z.duplicate].filter(Boolean).length).toBe(2);
  });

  it('refusing a payment that is not captured (pending, failed, cancelled)', async () => {
    const { hh } = household();
    for (const state of ['CAPTURE_PENDING', 'FAILED', 'CANCELLED', 'PAYER_APPROVED']) {
      const { id } = captured(hh, { state });
      const r = await admin(id);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('not_captured');
      expect(row(id).state).toBe(state);
    }
    expect(pp.refundCalls.length).toBe(0);
    expect((await admin('pay_doesnotexist')).status).toBe(404);
  });

  it('amount/currency mismatch with PayPal (GET capture) or a partial amount: nothing refunded', async () => {
    const { hh } = household();
    const a = captured(hh, { captureAmount: '1.00' });
    const r1 = await admin(a.id);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('amount_mismatch');
    const b = captured(hh, { captureCurrency: 'USD' });
    expect((await admin(b.id)).body.error).toBe('amount_mismatch');
    const c = captured(hh);
    const p = await admin(c.id, { amount: '10.00' });
    expect(p.status).toBe(400);
    expect(p.body.error).toBe('partial_refund_unsupported');
    expect((await admin(c.id, { amount: '32.00', currency: 'EUR' })).status).toBe(200); // explicit full amount is fine
    const d = captured(hh);
    db.prepare("UPDATE payment_requests SET captured_amount='31.00' WHERE id=?").run(d.id);
    expect((await admin(d.id)).body.error).toBe('amount_mismatch');
    const e = captured(hh);
    expect((await admin(e.id, { captureId: 'CAPSOMETHINGELSE' })).body.error).toBe('capture_mismatch');
    const f = captured(hh, { merchant: 'Some Other Shop' });
    expect((await admin(f.id)).body.error).toBe('not_demo_shop');
    expect(pp.refundCalls.length).toBe(1);
    for (const x of [a, b, d, e, f]) expect(row(x.id).state).toBe('CAPTURED');
  });

  it('PayPal capture unreachable before refunding: 503, nothing refunded, still CAPTURED', async () => {
    const { hh } = household();
    const { id } = captured(hh);
    pp.getCaptureMode = 'net';
    const r = await admin(id);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('paypal_unavailable');
    expect(row(id).state).toBe('CAPTURED');
    expect(pp.refundCalls.length).toBe(0);
  });

  it('cross-household: another household id, another household elder, or a capture belonging to another payment are rejected', async () => {
    const one = await elderAgent();
    const two = await elderAgent();
    const { id } = captured(one.hh);
    expect((await admin(id, { householdId: two.hh })).status).toBe(404);
    expect((await two.a.post(`/api/payments/${id}/refund-request`).send({})).status).toBe(404);
    expect((await two.a.get(`/api/payments/${id}`)).status).toBe(404);
    const other = captured(two.hh);
    const swapped = captured(one.hh, { captureCustomId: other.id }); // PayPal says this capture is for another purchase
    const r = await admin(swapped.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('capture_mismatch');
    expect(pp.refundCalls.length).toBe(0);
    expect(row(id).state).toBe('CAPTURED');
  });

  it('a 4xx from PayPal leaves the payment CAPTURED with a clear error; a later retry uses a NEW key', async () => {
    const { hh } = household();
    const { id } = captured(hh);
    pp.refundMode = '422';
    const r = await admin(id);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('refund_failed');
    expect(r.body.message).toMatch(/REFUND_NOT_ALLOWED.*still captured/);
    expect(row(id).state).toBe('CAPTURED');
    expect(refundRow(id)).toMatchObject({ status: 'FAILED', attempt: 1 });
    pp.refundMode = 'ok';
    expect((await admin(id).expect(200)).body.status).toBe('REFUNDED');
    expect(pp.refundCalls.map((c) => c.key)).toEqual([`refund-${id}-1`, `refund-${id}-2`]);
    expect(pp.realRefunds).toBe(1);
  });

  it('timeout -> REFUND_PENDING (202) -> reconcile resolves it from GET capture (REFUNDED)', async () => {
    const { a, hh } = await elderAgent();
    const { id } = captured(hh);
    pp.refundMode = 'timeout';
    const r = await admin(id);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'REFUND_PENDING', outcome: 'unknown' });
    expect(row(id).state).toBe('REFUND_PENDING');
    expect(refundRow(id)).toMatchObject({ status: 'UNKNOWN', refund_id: null });
    expect(pp.realRefunds).toBe(1);
    const view = (await a.get(`/api/payments/${id}`).expect(200)).body;
    expect(view.refund.status).toBe('REFUND_PENDING');
    expect(view.timeline.pending).toContain('Refund sent to PayPal — waiting for PayPal to confirm');
    const rec = await a.post(`/api/payments/${id}/reconcile`).send({}).expect(200);
    expect(rec.body.outcome).toBe('refunded');
    expect(row(id).state).toBe('REFUNDED');
    expect(pp.realRefunds).toBe(1);
    const t = buildTimeline(row(id));
    expect(t.events.find((e) => e.kind === 'refund_verified')!.source).toMatch(/shows REFUNDED/);
  });

  it('timeout then admin retry reuses the SAME PayPal-Request-Id: PayPal replays, money moves once', async () => {
    const { hh } = household();
    const { id } = captured(hh);
    pp.refundMode = 'timeout';
    expect((await admin(id)).status).toBe(202);
    pp.refundMode = 'ok';
    const again = await admin(id).expect(200);
    expect(again.body.status).toBe('REFUNDED');
    expect(new Set(pp.refundCalls.map((c) => c.key))).toEqual(new Set([`refund-${id}-1`]));
    expect(pp.realRefunds).toBe(1);
  });

  it('5xx before PayPal acted -> REFUND_PENDING; reconcile sees capture still COMPLETED and stays pending (never guesses)', async () => {
    const { hh } = household();
    const { id } = captured(hh);
    pp.refundMode = '5xx_before';
    expect((await admin(id)).status).toBe(202);
    expect(await reconcile(id)).toEqual({ outcome: 'pending', state: 'REFUND_PENDING' });
    pp.getCaptureMode = 'net';
    expect(await reconcile(id)).toEqual({ outcome: 'unknown', state: 'REFUND_PENDING' });
    pp.getCaptureMode = 'ok'; pp.refundMode = 'ok';
    expect((await admin(id).expect(200)).body.status).toBe('REFUNDED'); // resume with the stored key
    expect(pp.realRefunds).toBe(1);
  });

  it('PENDING refund -> reconcile resolves via GET /v2/payments/refunds/{id}', async () => {
    const { hh } = household();
    const { id, cap } = captured(hh);
    pp.refundMode = 'pending';
    const r = await admin(id);
    expect(r.status).toBe(202);
    expect(r.body.outcome).toBe('pending');
    const refundId = refundRow(id).refund_id;
    expect(refundId).toMatch(/^REF/);
    expect((await reconcile(id)).outcome).toBe('pending');
    pp.refunds.get(refundId).status = 'COMPLETED';
    pp.captures.get(cap).status = 'REFUNDED';
    pp.getRefundMode = 'net';
    expect((await reconcile(id)).outcome).toBe('unknown');
    pp.getRefundMode = 'ok';
    expect(await reconcile(id)).toEqual({ outcome: 'refunded', state: 'REFUNDED' });
  });

  it('webhook before the refund response: REFUNDED once, the late response is accepted, never regressed', async () => {
    const { hh } = household();
    const { id } = captured(hh);
    let hook: string | null = null;
    pp.onRefund = (ref) => {
      // Signed notice arrives (and is stored) while our POST is still waiting for PayPal's answer.
      db.prepare("INSERT INTO webhook_events (id, event_type, resource_id, verified, payload_json) VALUES (?,?,?,1,?)")
        .run('WH-EARLY-' + ref.id, 'PAYMENT.CAPTURE.REFUNDED', ref.id, JSON.stringify({ capture_id: refundCaptureId(ref), create_time: ref.create_time }));
      hook = refundFromWebhook(refundEvent('WH-EARLY-' + ref.id, ref));
    };
    const r = await admin(id).expect(200);
    expect(hook).toBe('refunded');
    expect(r.body.status).toBe('REFUNDED');
    expect(row(id).state).toBe('REFUNDED');
    const transitions = (db.prepare("SELECT action, actor FROM audit_log WHERE target=? AND action LIKE 'payment.%->REFUNDED'").all(id) as any[]);
    expect(transitions).toEqual([{ action: 'payment.REFUND_PENDING->REFUNDED', actor: 'paypal-webhook' }]);
    expect(refundRow(id).refund_id).toBe(r.body.refundId);
    const kinds = buildTimeline(row(id)).events.map((e) => e.kind);
    expect(kinds.slice(-4)).toEqual(['refund_requested', 'refund_completed', 'refund_verified', 'refund_webhook']);
  });

  it('refund webhook correlation: unknown refund, other capture, partial amount and non-COMPLETED are ignored', async () => {
    const { hh } = household();
    const { id, cap } = captured(hh);
    const base = { ...REFUND_FIXTURE, id: 'REFX' + rnd(), custom_id: undefined, amount: { currency_code: 'EUR', value: '32.00' }, links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/CAPNOTOURS` }] };
    expect(refundFromWebhook(refundEvent('E1', base))).toBe('unknown_request');
    const ours = { ...base, links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${cap}` }] };
    expect(refundFromWebhook(refundEvent('E2', { ...ours, custom_id: 'pay_someoneelse' }))).toBe('custom_id_mismatch');
    expect(refundFromWebhook(refundEvent('E3', { ...ours, amount: { currency_code: 'EUR', value: '5.00' } }))).toBe('amount_mismatch');
    expect(refundFromWebhook(refundEvent('E4', { ...ours, status: 'PENDING' }))).toBe('no_change');
    expect(row(id).state).toBe('CAPTURED');
    // A full refund made outside SaySafe (e.g. PayPal dashboard) for our capture: the signed notice is authoritative.
    expect((await postWebhook(refundEvent('E5', ours)).expect(200)).body.outcome).toBe('refunded');
    expect(row(id).state).toBe('REFUNDED');
    expect(buildTimeline(row(id)).events.find((e) => e.kind === 'refund_completed')!.source).toMatch(/Signed PayPal webhook/);
  });
});

describe('Payments v2 capture lookup (getCapture)', () => {
  function completedOrder(hh: string) {
    const c = captured(hh, { state: 'CAPTURE_PENDING' });
    db.prepare('UPDATE payment_requests SET paypal_capture_id=NULL, captured_amount=NULL, captured_currency=NULL WHERE id=?').run(c.id);
    return c;
  }
  it('reconcile of a COMPLETED order confirms the capture with GET /v2/payments/captures/{id} and records payments-v2 evidence', async () => {
    const { hh } = household();
    const c = completedOrder(hh);
    expect(await reconcile(c.id)).toEqual({ outcome: 'captured', state: 'CAPTURED' });
    expect(getCaptureMock.mock.calls.some((x: any[]) => x[0] === c.cap)).toBe(true);
    const ev = db.prepare("SELECT actor, detail_json FROM audit_log WHERE target=? AND action='evidence.capture_verified'").get(c.id) as any;
    expect(ev.actor).toBe('paypal-v2');
    expect(JSON.parse(ev.detail_json)).toMatchObject({ source: 'payments-v2', captureId: c.cap, status: 'COMPLETED', amount: '32.00', currency: 'EUR' });
    expect(buildTimeline(row(c.id)).events.find((e) => e.kind === 'capture_verified')!.verified).toBe(true);
  });
  it('Payments v2 unreachable -> unknown (no change); v2 amount differs -> mismatch; v2 PENDING -> pending', async () => {
    const { hh } = household();
    const a = completedOrder(hh);
    pp.getCaptureMode = 'net';
    expect(await reconcile(a.id)).toEqual({ outcome: 'unknown', state: 'CAPTURE_PENDING' });
    pp.getCaptureMode = 'ok';
    pp.captures.get(a.cap).amount.value = '3.20';
    expect(await reconcile(a.id)).toEqual({ outcome: 'mismatch', state: 'CAPTURE_PENDING' });
    const b = completedOrder(hh);
    pp.captures.get(b.cap).status = 'PENDING';
    expect(await reconcile(b.id)).toEqual({ outcome: 'pending', state: 'CAPTURE_PENDING' });
    const c = completedOrder(hh);
    pp.captures.get(c.cap).status = 'REFUNDED';
    expect(await reconcile(c.id)).toEqual({ outcome: 'refunded', state: 'REFUNDED' });
  });
  it('receipt timeline: opening a captured payment reads the capture once from Payments v2', async () => {
    const { a, hh } = await elderAgent();
    const { id, cap } = captured(hh);
    const before = getCaptureMock.mock.calls.filter((x: any[]) => x[0] === cap).length;
    const v = (await a.get(`/api/payments/${id}`).expect(200)).body;
    expect(v.timeline.events.find((e: any) => e.kind === 'capture_verified')).toMatchObject({ verified: true });
    await a.get(`/api/payments/${id}`).expect(200);
    expect(getCaptureMock.mock.calls.filter((x: any[]) => x[0] === cap).length - before).toBe(1);
  });
});

describe('state machine', () => {
  it('refund transitions', () => {
    expect(() => assertTransition('CAPTURED', 'REFUND_PENDING')).not.toThrow();
    expect(() => assertTransition('REFUND_PENDING', 'REFUNDED')).not.toThrow();
    expect(() => assertTransition('REFUND_PENDING', 'CAPTURED')).not.toThrow();
    expect(() => assertTransition('REFUND_PENDING', 'FAILED')).toThrow(TransitionError);
    expect(() => assertTransition('CAPTURE_PENDING', 'REFUND_PENDING')).toThrow(TransitionError);
    expect(() => assertTransition('REFUNDED', 'CAPTURED')).toThrow(TransitionError);
  });
  it('publicView: refund info only for paid payments', () => {
    const { hh } = household();
    const c = captured(hh, { state: 'PAYER_APPROVED' });
    expect(pay.publicView(row(c.id)).refund).toBeNull();
    const d = captured(hh);
    expect(pay.publicView(row(d.id)).refund).toMatchObject({ status: null, canRequest: true });
  });
});
