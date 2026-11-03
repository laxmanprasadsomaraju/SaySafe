/**
 * Webhook intake over HTTP (MOCKED PayPal: signature verification and Orders API are test doubles).
 * Proves: signature failure, verify-API error, durable persistence, dedupe, out-of-order delivery, no regression,
 * amount/order mismatch, crash-during-processing -> PayPal retry is processed (not swallowed), and that unverified
 * events are never stored. What is proven LIVE (real PayPal) is listed separately in docs/TEST-EVIDENCE.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const st = vi.hoisted(() => ({ verify: 'ok' as 'ok' | 'fail' | 'throw', orders: new Map<string, any>(), captureCalls: 0 }));
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    st.orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return st.orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => JSON.parse(JSON.stringify(st.orders.get(id)))),
  captureOrder: vi.fn(async () => { st.captureCalls++; const e: any = new Error('timeout'); e.name = 'TimeoutError'; throw e; }),
  getCapture: vi.fn(async () => { const e: any = new Error('timeout'); throw e; }),
  refundCapture: vi.fn(async () => { throw new Error('no refunds here'); }),
  verifyWebhook: vi.fn(async () => { if (st.verify === 'throw') throw new Error('verify api down'); return st.verify === 'ok'; }),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: (o: any) => o.links[0].href,
}));

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import * as pay from '../server/payments/service';
import { __webhookTestHooks } from '../server/payments/webhooks';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
const post = (ev: unknown) => request(app).post('/api/paypal/webhook').set(H).send(JSON.stringify(ev));
const stateOf = (id: string) => (db.prepare('SELECT state FROM payment_requests WHERE id=?').get(id) as any).state;
let n = 0;
const completed = (requestId: string, orderId: string, value = '32.00', id = `WH-${++n}-${Date.now()}`) => ({
  id, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture', create_time: new Date().toISOString(),
  resource: { id: `CAP${orderId}`, status: 'COMPLETED', custom_id: requestId, amount: { value, currency_code: 'EUR' }, supplementary_data: { related_ids: { order_id: orderId } }, payer: { email_address: 'buyer@example.com', name: { given_name: 'Should', surname: 'NotBeStored' } } },
});

/** A real-flow request left in CAPTURE_PENDING because the capture response never arrived. */
async function pendingCapture() {
  const a = request.agent(app);
  await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
  const { body } = await a.post('/api/payments').set(H).send({ items: [{ productId: 'kettle-classic', quantity: 1 }], idempotencyKey: 'k' + Math.random().toString(36).slice(2, 14) }).expect(200);
  const id = body.request.id as string;
  const orderId = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(id) as any).o;
  st.orders.get(orderId).status = 'APPROVED';
  const r = await a.post(`/api/payments/${id}/confirm`).set(H).send({ orderId });
  expect(r.status).toBe(503);
  expect(r.body.error).toBe('outcome_unknown');
  expect(stateOf(id)).toBe('CAPTURE_PENDING');
  return { a, id, orderId };
}

beforeEach(() => { st.verify = 'ok'; __webhookTestHooks.beforeDispatch = null; });

describe('webhook intake (mocked PayPal)', () => {
  it('signature verification failure: 400, nothing stored, nothing changed', async () => {
    const p = await pendingCapture();
    st.verify = 'fail';
    const ev = completed(p.id, p.orderId);
    expect((await post(ev).expect(400)).body).toMatchObject({ error: 'unverified' });
    st.verify = 'throw';
    await post(ev).expect(400);
    expect(db.prepare('SELECT 1 FROM webhook_events WHERE id=?').get(ev.id)).toBeUndefined();
    expect(stateOf(p.id)).toBe('CAPTURE_PENDING');
  });

  it('verified COMPLETED (arriving BEFORE the capture response) records CAPTURED; a later confirm makes no new capture call', async () => {
    const p = await pendingCapture();
    const calls = st.captureCalls;
    const ev = completed(p.id, p.orderId);
    expect((await post(ev).expect(200)).body).toEqual({ ok: true, outcome: 'captured' });
    expect(stateOf(p.id)).toBe('CAPTURED');
    const row = db.prepare('SELECT * FROM webhook_events WHERE id=?').get(ev.id) as any;
    expect(row.verified).toBe(1);
    expect(row.processed_at).toBeTruthy();
    expect(row.outcome).toBe('captured');
    expect(row.payload_json).not.toMatch(/buyer@example\.com|NotBeStored/); // no payer PII stored
    const c = await p.a.post(`/api/payments/${p.id}/confirm`).set(H).send({ orderId: p.orderId }).expect(200);
    expect(c.body.state).toBe('CAPTURED');
    expect(c.body.receipt.webhookConfirmed).toBe(true);
    expect(st.captureCalls).toBe(calls);
  });

  it('duplicate delivery: one row, second answer is duplicate, no second state change', async () => {
    const p = await pendingCapture();
    const ev = completed(p.id, p.orderId);
    await post(ev).expect(200);
    expect((await post(ev).expect(200)).body).toEqual({ ok: true, duplicate: true });
    expect(db.prepare('SELECT COUNT(*) n FROM webhook_events WHERE id=?').get(ev.id)).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target=? AND action='payment.CAPTURE_PENDING->CAPTURED'").get(p.id)).toMatchObject({ n: 1 });
  });

  it('out of order: DENIED after COMPLETED never regresses; a second COMPLETED with another capture id is flagged', async () => {
    const p = await pendingCapture();
    await post(completed(p.id, p.orderId)).expect(200);
    const denied = { ...completed(p.id, p.orderId), event_type: 'PAYMENT.CAPTURE.DENIED' };
    expect((await post(denied).expect(200)).body.outcome).toBe('no_change');
    const other = completed(p.id, p.orderId); other.resource.id = 'CAPOTHER123';
    expect((await post(other).expect(200)).body.outcome).toBe('capture_id_mismatch');
    expect(stateOf(p.id)).toBe('CAPTURED');
  });

  it('amount or order mismatch is never recorded as paid', async () => {
    const p = await pendingCapture();
    expect((await post(completed(p.id, p.orderId, '1.00')).expect(200)).body.outcome).toBe('amount_mismatch');
    expect((await post(completed(p.id, 'ORDERNOTOURS99')).expect(200)).body.outcome).toBe('order_mismatch');
    expect(stateOf(p.id)).toBe('CAPTURE_PENDING');
  });

  it('crash during processing: stored but unprocessed, 500 so PayPal retries; the retry is processed exactly once', async () => {
    const p = await pendingCapture();
    const ev = completed(p.id, p.orderId);
    __webhookTestHooks.beforeDispatch = () => { throw new Error('simulated crash'); };
    expect((await post(ev).expect(500)).body).toMatchObject({ error: 'processing_failed', retry: true });
    let row = db.prepare('SELECT processed_at, outcome, attempts FROM webhook_events WHERE id=?').get(ev.id) as any;
    expect(row.processed_at).toBeNull();
    expect(row.outcome).toBe('failed:error');
    expect(stateOf(p.id)).toBe('CAPTURE_PENDING');
    __webhookTestHooks.beforeDispatch = null;
    expect((await post(ev).expect(200)).body).toEqual({ ok: true, outcome: 'captured' }); // PayPal's redelivery
    row = db.prepare('SELECT processed_at, outcome, attempts FROM webhook_events WHERE id=?').get(ev.id) as any;
    expect([Boolean(row.processed_at), row.outcome, row.attempts]).toEqual([true, 'captured', 2]);
    expect((await post(ev).expect(200)).body).toEqual({ ok: true, duplicate: true });
  });

  it('unknown request id and malformed bodies are harmless', async () => {
    expect((await post(completed('pay_doesnotexist1', 'ORDERXXXXXXXXXX')).expect(200)).body.outcome).toBe('unknown_request');
    await request(app).post('/api/paypal/webhook').set(H).send('{not json').expect(400);
    await post({ event_type: 'PAYMENT.CAPTURE.COMPLETED' }).expect(400);
  });

  it('reconcileFromWebhook is idempotent at the service level too', async () => {
    const p = await pendingCapture();
    const ev = completed(p.id, p.orderId);
    expect(pay.reconcileFromWebhook(ev)).toBe('captured');
    expect(pay.reconcileFromWebhook(ev)).toBe('already_captured');
  });
});
