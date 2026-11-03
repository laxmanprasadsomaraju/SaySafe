/**
 * Payment recovery simulations: lost webhook, lost redirect, capture timeout + retry, duplicate and
 * out-of-order webhooks, lazy sweep, evidence timeline, webhook PII minimisation, unauthorised approvals
 * and tampered amounts. PayPal is a TEST DOUBLE (vi.mock); nothing here talks to PayPal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const orders = new Map<string, any>();
const pp = vi.hoisted(() => ({ getOrderFailures: 0, getOrderMode: 'ok' as 'ok' | 'net' | '404' | '500', captureMode: 'ok' as 'ok' | 'lost_response' | 'webhook_first', realCaptures: 0, onWebhookFirst: null as null | ((o: any) => void) }));

function completeAtPayPal(o: any, opts: { value?: string; currency?: string; status?: string } = {}) {
  o.status = 'COMPLETED';
  o.purchase_units[0].payments = { captures: [{ id: 'CAP' + o.id, status: opts.status ?? 'COMPLETED', amount: { currency_code: opts.currency ?? o.purchase_units[0].amount.currency_code, value: opts.value ?? o.purchase_units[0].amount.value }, create_time: '2026-11-03T00:10:00Z' }] };
  pp.realCaptures++;
}

vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => {
    if (pp.getOrderFailures > 0) { pp.getOrderFailures--; throw new Error('ECONNRESET'); }
    if (pp.getOrderMode === 'net') throw new Error('ETIMEDOUT');
    if (pp.getOrderMode === '500') { const e: any = new Error('PayPal 500'); e.status = 500; throw e; }
    if (pp.getOrderMode === '404') { const e: any = new Error('RESOURCE_NOT_FOUND'); e.status = 404; throw e; }
    return orders.get(id);
  }),
  captureOrder: vi.fn(async (id: string) => {
    const o = orders.get(id);
    if (o.status === 'COMPLETED' && o.purchase_units[0].payments) return o; // PayPal-Request-Id replay: same capture, no new money movement
    if (pp.captureMode === 'lost_response') { completeAtPayPal(o); pp.getOrderFailures = 1; throw new Error('socket hang up'); }
    completeAtPayPal(o);
    if (pp.captureMode === 'webhook_first') pp.onWebhookFirst?.(o);
    return o;
  }),
  // Payments v2 GET capture: the capture as PayPal holds it on the order (with custom_id + order link, like the real API).
  getCapture: vi.fn(async (capId: string) => {
    for (const o of orders.values()) {
      const c = o.purchase_units?.[0]?.payments?.captures?.find((x: any) => x.id === capId);
      if (c) return { ...c, custom_id: o.purchase_units[0].custom_id, supplementary_data: { related_ids: { order_id: o.id } } };
    }
    const e: any = new Error('RESOURCE_NOT_FOUND'); e.status = 404; throw e;
  }),
  refundCapture: vi.fn(async () => ({ status: 'COMPLETED' })),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: (o: any) => o.links[0].href,
}));

import * as pay from '../server/payments/service';
import { reconcile, sweepHousehold, finishApproved, __resetReconcileThrottle } from '../server/payments/reconcile';
import { buildTimeline } from '../server/payments/timeline';
import * as client from '../server/paypal/client';
import { db } from '../server/db/index';
import { createApp } from '../server/app';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
const key = () => 'k' + Math.random().toString(36).slice(2, 14);
const ORIGIN = 'http://localhost';
const captureMock = client.captureOrder as unknown as ReturnType<typeof vi.fn>;

function household(threshold = 7500) {
  const hh = 'hh_' + Math.random().toString(36).slice(2);
  const u = 'usr_' + Math.random().toString(36).slice(2);
  db.prepare("INSERT INTO users (id,name,role) VALUES (?,?,'elder')").run(u, 'Mary');
  db.prepare('INSERT INTO households (id, elder_id) VALUES (?,?)').run(hh, u);
  db.prepare('INSERT INTO spending_policies (household_id, approval_threshold_cents) VALUES (?,?)').run(hh, threshold);
  return { hh, u };
}
const row = (id: string) => db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id) as any;
const stateOf = (id: string) => row(id).state as string;
async function started(product = 'kettle-classic') {
  const { hh, u } = household();
  const { request: r } = await pay.createRequest(hh, u, [{ productId: product, quantity: 1 }], key(), ORIGIN);
  const oid = row(r.id).paypal_order_id as string;
  return { hh, u, id: r.id, oid, order: orders.get(oid) };
}
const capturesFor = (oid: string) => captureMock.mock.calls.filter((c: any[]) => c[0] === oid);
const makeStale = (id: string, minutes = 5) => db.prepare(`UPDATE payment_requests SET updated_at=datetime('now','-${minutes} minutes') WHERE id=?`).run(id);

function webhookEvent(id: string, reqId: string, oid: string, capId: string, value: string, currency = 'EUR') {
  return {
    id, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture', create_time: '2026-11-03T00:10:05Z',
    resource: {
      id: capId, status: 'COMPLETED', custom_id: reqId, amount: { value, currency_code: currency }, create_time: '2026-11-03T00:10:00Z',
      supplementary_data: { related_ids: { order_id: oid } },
      payer: { email_address: 'mary.private@example.com', name: { given_name: 'Mary', surname: 'Private' } },
      shipping: { address: { address_line_1: '1 Secret Street', postal_code: 'V94 XXXX' } },
    },
  };
}

beforeEach(() => {
  pp.getOrderFailures = 0; pp.getOrderMode = 'ok'; pp.captureMode = 'ok'; pp.onWebhookFirst = null;
  __resetReconcileThrottle();
});

describe('reconcile(requestId)', () => {
  it('lost webhook + lost capture response: reconcile records CAPTURED from PayPal, once, and says the signed notice has not arrived', async () => {
    const { hh, u, id, oid, order } = await started();
    order.status = 'APPROVED';
    pp.captureMode = 'lost_response';
    await expect(pay.confirmAndCapture(hh, u, id, oid)).rejects.toThrow(/not answered yet/);
    expect(stateOf(id)).toBe('CAPTURE_PENDING'); // never FAILED on an unknown outcome
    const out = await reconcile(id);
    expect(out).toEqual({ outcome: 'captured', state: 'CAPTURED' });
    expect(capturesFor(oid).length).toBe(1);
    const view = pay.publicView(row(id));
    expect(view.receipt?.amount).toBe('32.00');
    expect(view.receipt?.webhookConfirmed).toBe(false);
    const t = buildTimeline(row(id));
    expect(t.events.find((e) => e.kind === 'capture_completed')?.source).toMatch(/reconcile/);
    expect(t.events.find((e) => e.kind === 'capture_completed')?.paypalTime).toBe('2026-11-03T00:10:00.000Z');
    expect(t.pending).toContain('Signed PayPal notice not received yet');
    expect((await reconcile(id)).outcome).toBe('not_applicable'); // idempotent
  });

  it('lost redirect: APPROVED at PayPal marks buyer-approved but NEVER captures; capture only on explicit finish', async () => {
    const { hh, u, id, oid, order } = await started();
    order.status = 'APPROVED';
    expect(await reconcile(id)).toEqual({ outcome: 'buyer_approved', state: 'PAYER_APPROVED' });
    expect(capturesFor(oid).length).toBe(0);
    expect((await reconcile(id)).outcome).toBe('no_change');
    expect(capturesFor(oid).length).toBe(0);
    const done = await finishApproved(hh, u, id);
    expect(done.state).toBe('CAPTURED');
    expect(capturesFor(oid).length).toBe(1);
    const kinds = buildTimeline(row(id)).events.map((e) => e.kind);
    expect(kinds).toEqual(['order_created', 'buyer_approved', 'capture_completed']);
    expect(buildTimeline(row(id)).events[1].source).toMatch(/reconcile/);
  });

  it('capture timeout then retry does not double capture (same PayPal-Request-Id, replay returns the original capture)', async () => {
    const { hh, u, id, oid, order } = await started();
    order.status = 'APPROVED';
    pp.captureMode = 'lost_response';
    const before = pp.realCaptures;
    await expect(pay.confirmAndCapture(hh, u, id, oid)).rejects.toThrow(/not answered yet/);
    pp.captureMode = 'ok';
    const retried = await finishApproved(hh, u, id);
    expect(retried.state).toBe('CAPTURED');
    expect(pp.realCaptures - before).toBe(1);
    const calls = capturesFor(oid);
    expect(calls.length).toBe(2);
    expect(new Set(calls.map((c: any[]) => c[1])).size).toBe(1); // same request id -> same PayPal-Request-Id
  });

  it('a network error, timeout or PayPal 5xx changes nothing and returns unknown', async () => {
    const { id, order } = await started();
    order.status = 'APPROVED';
    for (const mode of ['net', '500'] as const) {
      pp.getOrderMode = mode;
      expect(await reconcile(id)).toEqual({ outcome: 'unknown', state: 'PAYER_APPROVAL_PENDING' });
    }
    pp.getOrderMode = '404'; // recent order: a 404 is not trusted as "expired"
    expect((await reconcile(id)).outcome).toBe('unknown');
    expect(stateOf(id)).toBe('PAYER_APPROVAL_PENDING');
  });

  it('VOIDED or long-expired orders become CANCELLED; a capture-pending order is never cancelled on a 404', async () => {
    const a = await started();
    a.order.status = 'VOIDED';
    expect(await reconcile(a.id)).toEqual({ outcome: 'cancelled', state: 'CANCELLED' });

    const b = await started();
    db.prepare("UPDATE payment_requests SET created_at=datetime('now','-4 hours') WHERE id=?").run(b.id);
    pp.getOrderMode = '404';
    expect(await reconcile(b.id)).toEqual({ outcome: 'cancelled', state: 'CANCELLED' });

    const c = await started();
    db.prepare("UPDATE payment_requests SET state='CAPTURE_PENDING', created_at=datetime('now','-4 hours') WHERE id=?").run(c.id);
    expect((await reconcile(c.id)).outcome).toBe('unknown');
    expect(stateOf(c.id)).toBe('CAPTURE_PENDING');
    pp.getOrderMode = 'ok';
    c.order.status = 'VOIDED';
    expect(await reconcile(c.id)).toEqual({ outcome: 'cancelled', state: 'CANCELLED' });
  });

  it('a tampered amount or currency at PayPal is never recorded as paid', async () => {
    const a = await started();
    db.prepare("UPDATE payment_requests SET state='CAPTURE_PENDING' WHERE id=?").run(a.id);
    completeAtPayPal(a.order, { value: '1.00' });
    expect(await reconcile(a.id)).toEqual({ outcome: 'mismatch', state: 'CAPTURE_PENDING' });

    const b = await started();
    db.prepare("UPDATE payment_requests SET state='CAPTURE_PENDING' WHERE id=?").run(b.id);
    completeAtPayPal(b.order, { currency: 'USD' });
    expect((await reconcile(b.id)).outcome).toBe('mismatch');

    const c = await started();
    c.order.status = 'APPROVED';
    c.order.purchase_units[0].custom_id = 'pay_someoneelse';
    expect((await reconcile(c.id)).outcome).toBe('mismatch');
    expect(stateOf(c.id)).toBe('PAYER_APPROVAL_PENDING');

    const d = await started();
    d.order.status = 'APPROVED';
    d.order.purchase_units[0].amount.value = '0.01';
    expect((await reconcile(d.id)).outcome).toBe('mismatch');
    expect(capturesFor(d.oid).length).toBe(0);
  });

  it('a PENDING capture stays CAPTURE_PENDING (money in flight, not paid yet)', async () => {
    const { id, order } = await started();
    completeAtPayPal(order, { status: 'PENDING' });
    expect(await reconcile(id)).toEqual({ outcome: 'pending', state: 'CAPTURE_PENDING' });
  });

  it('family approval is re-checked on finish even after reconcile marked the buyer approved', async () => {
    const { hh, u } = household();
    const fam = 'usr_' + Math.random().toString(36).slice(2);
    db.prepare("INSERT INTO users (id,name,role) VALUES (?,?,'family')").run(fam, 'Alex');
    const { request: r } = await pay.createRequest(hh, u, [{ productId: 'microwave', quantity: 1 }], key(), ORIGIN);
    pay.decide(hh, fam, r.id, r.approval!.id, 'approve');
    await pay.startPayPalCheckout(hh, u, r.id, ORIGIN);
    const oid = row(r.id).paypal_order_id;
    orders.get(oid).status = 'APPROVED';
    expect((await reconcile(r.id)).outcome).toBe('buyer_approved');
    db.prepare("UPDATE approvals SET fingerprint='tampered' WHERE request_id=?").run(r.id);
    await expect(finishApproved(hh, u, r.id)).rejects.toThrow(/Family approval is missing/);
    expect(capturesFor(oid).length).toBe(0);
  });

  it('a missing local record never captures: reconcile refuses unknown ids and the read-only status route never captures', async () => {
    await expect(reconcile('pay_doesnotexist')).rejects.toThrow(/not found/);
    const oid = 'ORDERORPHAN12345';
    orders.set(oid, { id: oid, status: 'APPROVED', purchase_units: [{ custom_id: 'pay_orphan1234567', amount: { currency_code: 'EUR', value: '32.00' } }] });
    const res = await request(app).get(`/api/paypal/orders/${oid}/status`).expect(200);
    expect(res.body.localRecord).toBe(false);
    expect(capturesFor(oid).length).toBe(0);
  });
});

describe('webhooks: duplicates, out of order, PII', () => {
  it('webhook arriving before the capture response: no conflict, no regression, one capture', async () => {
    const { hh, u, id, oid, order } = await started();
    order.status = 'APPROVED';
    pp.captureMode = 'webhook_first';
    pp.onWebhookFirst = (o) => {
      const cap = o.purchase_units[0].payments.captures[0];
      expect(pay.reconcileFromWebhook(webhookEvent('WH-early', id, oid, cap.id, cap.amount.value))).toBe('captured');
    };
    const done = await pay.confirmAndCapture(hh, u, id, oid);
    expect(done.state).toBe('CAPTURED');
    expect(row(id).paypal_capture_id).toBe('CAP' + oid);
  });

  it('duplicate signed webhooks are ignored; stored payload keeps no payer email, name or address', async () => {
    const { hh, u, id, oid, order } = await started();
    order.status = 'APPROVED';
    await pay.confirmAndCapture(hh, u, id, oid);
    const ev = webhookEvent('WH-' + id, id, oid, 'CAP' + oid, '32.00');
    const first = await request(app).post('/api/paypal/webhook').set(H).send(JSON.stringify(ev)).expect(200);
    expect(first.body.outcome).toBe('already_captured');
    const dup = await request(app).post('/api/paypal/webhook').set(H).send(JSON.stringify(ev)).expect(200);
    expect(dup.body.duplicate).toBe(true);
    const stored = db.prepare('SELECT payload_json FROM webhook_events WHERE id=?').get(ev.id) as any;
    expect(stored.payload_json).not.toMatch(/mary\.private|Private|Secret Street|V94/);
    expect(JSON.parse(stored.payload_json)).toMatchObject({ id: ev.id, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_id: 'CAP' + oid, amount: '32.00', currency: 'EUR' });
    const t = buildTimeline(row(id));
    expect(t.events.map((e) => e.kind)).toEqual(['order_created', 'buyer_approved', 'capture_completed', 'webhook_received']);
    expect(t.events.filter((e) => e.kind === 'webhook_received').length).toBe(1);
    expect(t.events[3].verification).toMatch(/Signature verified/);
    expect(t.events[0].source).toMatch(/SaySafe server · PayPal order ORDE…/);
    expect(t.events[0].source).not.toContain(oid);
    expect(t.pending).not.toContain('Signed PayPal notice not received yet');
    expect(t.label).toBe('PayPal Sandbox — no real money');
  });

  it('a capture webhook with a different amount or for a not-yet-captured request never skips states', async () => {
    const a = await started();
    a.order.status = 'APPROVED';
    expect(pay.reconcileFromWebhook(webhookEvent('WH-x1', a.id, a.oid, 'CAPX', '32.00'))).toBe('no_change');
    expect(stateOf(a.id)).toBe('PAYER_APPROVAL_PENDING');
    db.prepare("UPDATE payment_requests SET state='CAPTURE_PENDING' WHERE id=?").run(a.id);
    expect(pay.reconcileFromWebhook(webhookEvent('WH-x2', a.id, a.oid, 'CAPX', '1.00'))).toBe('amount_mismatch');
    expect(pay.reconcileFromWebhook(webhookEvent('WH-x3', a.id, a.oid, 'CAPX', '32.00', 'USD'))).toBe('amount_mismatch');
    expect(stateOf(a.id)).toBe('CAPTURE_PENDING');
  });
});

describe('HTTP: order page recovery and lazy sweep', () => {
  async function elder() {
    const a = request.agent(app);
    await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
    return a;
  }
  const buy = (a: any, productId = 'kettle-classic') => a.post('/api/payments').set(H).send({ items: [{ productId, quantity: 1 }], idempotencyKey: key() });

  it('opening /order/:id directly (lost redirect) + Check with PayPal shows the PayPal truth and a timeline; finish captures once', async () => {
    const e = await elder();
    const { body } = await buy(e).expect(200);
    const id = body.request.id; const oid = row(id).paypal_order_id;
    orders.get(oid).status = 'APPROVED';
    const view = await e.get(`/api/payments/${id}`).expect(200);
    expect(view.body.timeline.events.map((x: any) => x.kind)).toEqual(['order_created']);
    const rec = await e.post(`/api/payments/${id}/reconcile`).set(H).send({}).expect(200);
    expect(rec.body.outcome).toBe('buyer_approved');
    expect(rec.body.request.state).toBe('PAYER_APPROVED');
    expect(capturesFor(oid).length).toBe(0);
    const fin = await e.post(`/api/payments/${id}/finish`).set(H).send({}).expect(200);
    expect(fin.body.state).toBe('CAPTURED');
    expect(capturesFor(oid).length).toBe(1);
  });

  it('another household cannot reconcile, finish or read a payment', async () => {
    const a = await elder(); const b = await elder();
    const { body } = await buy(a).expect(200);
    await b.post(`/api/payments/${body.request.id}/reconcile`).set(H).send({}).expect(404);
    await b.post(`/api/payments/${body.request.id}/finish`).set(H).send({}).expect(404);
    await request(app).post(`/api/payments/${body.request.id}/reconcile`).set(H).send({}).expect(401);
  });

  it('elder dashboard lazily reconciles stale pending payments (older than 2 min), rate-limited per household', async () => {
    const e = await elder();
    const stale = (await buy(e).expect(200)).body.request.id;
    const fresh = (await buy(e, 'toaster').expect(200)).body.request.id;
    db.prepare("UPDATE payment_requests SET state='CAPTURE_PENDING' WHERE id IN (?,?)").run(stale, fresh);
    completeAtPayPal(orders.get(row(stale).paypal_order_id));
    completeAtPayPal(orders.get(row(fresh).paypal_order_id));
    makeStale(stale);
    const list = await e.get('/api/payments').expect(200);
    expect(list.body.find((x: any) => x.id === stale).state).toBe('CAPTURED');
    expect(list.body.find((x: any) => x.id === fresh).state).toBe('CAPTURE_PENDING'); // not stale yet
    makeStale(fresh);
    const again = await e.get('/api/payments').expect(200); // within 60 s: sweep skipped
    expect(again.body.find((x: any) => x.id === fresh).state).toBe('CAPTURE_PENDING');
  });

  it('family dashboard also triggers the sweep, for its own household only', async () => {
    const e = await elder();
    const { body: inv } = await e.post('/api/family/invite').set(H).send({}).expect(200);
    const f = request.agent(app);
    await f.post('/api/family/pair').set(H).send({ code: inv.code, name: 'Alex' }).expect(200);
    const id = (await buy(e).expect(200)).body.request.id;
    db.prepare("UPDATE payment_requests SET state='CAPTURE_PENDING' WHERE id=?").run(id);
    completeAtPayPal(orders.get(row(id).paypal_order_id));
    makeStale(id);
    const other = household();
    expect((await sweepHousehold(other.hh)).swept).toBe(0); // someone else's sweep never touches this household
    expect(stateOf(id)).toBe('CAPTURE_PENDING');
    const ov = await f.get('/api/family/overview').expect(200);
    expect(ov.body.requests.find((x: any) => x.id === id).state).toBe('CAPTURED');
    expect((await sweepHousehold(row(id).household_id)).skipped).toBe(true); // rate-limited: once a minute per household
  });
});
