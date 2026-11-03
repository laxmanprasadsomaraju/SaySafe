/**
 * Restart persistence at the service level: the app "process" is booted twice on the same database file
 * (modules re-imported, DB closed in between). PayPal is a TEST DOUBLE here.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const orders = new Map<string, any>();
const captureCalls: Array<{ orderId: string; requestId: string }> = [];
let captureMode: 'ok' | 'timeout' = 'ok';
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: async (a: any) => {
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return orders.get(id);
  },
  getOrder: async (id: string) => orders.get(id),
  // Mirrors PayPal: the same PayPal-Request-Id (capture-<requestId>) replays the original capture instead of charging again.
  captureOrder: async (orderId: string, requestId: string) => {
    captureCalls.push({ orderId, requestId });
    const o = orders.get(orderId);
    if (captureMode === 'timeout') { captureMode = 'ok'; throw new Error('timeout'); } // no answer: outcome unknown
    if (o.status === 'COMPLETED') return o;
    o.status = 'COMPLETED';
    o.purchase_units[0].payments = { captures: [{ id: 'CAP' + orderId, status: 'COMPLETED', amount: o.purchase_units[0].amount }] };
    return o;
  },
  refundCapture: async () => ({ status: 'COMPLETED' }),
  verifyWebhook: async () => true,
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: (o: any) => o.links[0].href,
}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saysafe-restart-'));
const file = path.join(dir, 'saysafe.db');
const prevFile = process.env.DATABASE_FILE;
afterAll(() => { process.env.DATABASE_FILE = prevFile; fs.rmSync(dir, { recursive: true, force: true }); });

async function boot() {
  process.env.DATABASE_FILE = file;
  vi.resetModules();
  const dbm = await import('../server/db/index');
  const pay = await import('../server/payments/service');
  const { createApp } = await import('../server/app');
  return { db: dbm.db, pay, app: createApp() };
}
const webhook = (eventId: string, requestId: string, orderId: string, captureId: string) => ({
  id: eventId, event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { id: captureId, custom_id: requestId, amount: { value: '32.00', currency_code: 'EUR' }, supplementary_data: { related_ids: { order_id: orderId } } },
});
const postWebhook = (app: any, ev: unknown) => request(app).post('/api/paypal/webhook').set('Content-Type', 'application/json').send(JSON.stringify(ev));

describe('restart persistence', () => {
  it('captures, webhooks and pending captures survive a restart; duplicates stay no-ops; PayPal-Request-Id unchanged', async () => {
    // ---- boot 1 ----
    let { db, pay, app } = await boot();
    db.prepare("INSERT INTO users (id,name,role) VALUES ('u1','Mary','elder')").run();
    db.prepare("INSERT INTO households (id, elder_id) VALUES ('h1','u1')").run();
    db.prepare("INSERT INTO spending_policies (household_id, approval_threshold_cents) VALUES ('h1', 7500)").run();

    // A: captured by the server, confirmed by a signed webhook
    const a = (await pay.createRequest('h1', 'u1', [{ productId: 'kettle-classic', quantity: 1 }], 'restart_key_A', 'http://localhost')).request;
    const orderA = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(a.id) as any).o;
    orders.get(orderA).status = 'APPROVED';
    expect((await pay.confirmAndCapture('h1', 'u1', a.id, orderA)).state).toBe('CAPTURED');
    const capA = 'CAP' + orderA;
    expect((await postWebhook(app, webhook('WH-A', a.id, orderA, capA)).expect(200)).body).toMatchObject({ ok: true, outcome: 'already_captured' });

    // B: PayPal did not answer the capture (outcome unknown) -> stays CAPTURE_PENDING across the restart
    const b = (await pay.createRequest('h1', 'u1', [{ productId: 'kettle-classic', quantity: 1 }], 'restart_key_B', 'http://localhost')).request;
    const orderB = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(b.id) as any).o;
    orders.get(orderB).status = 'APPROVED';
    captureMode = 'timeout';
    await expect(pay.confirmAndCapture('h1', 'u1', b.id, orderB)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect((db.prepare('SELECT state FROM payment_requests WHERE id=?').get(b.id) as any).state).toBe('CAPTURE_PENDING');
    const callsBefore = captureCalls.length;
    db.close();

    // ---- boot 2: same file, fresh modules ----
    ({ db, pay, app } = await boot());
    expect(db.prepare('SELECT state, paypal_order_id, paypal_capture_id, captured_amount FROM payment_requests WHERE id=?').get(a.id))
      .toEqual({ state: 'CAPTURED', paypal_order_id: orderA, paypal_capture_id: capA, captured_amount: '32.00' });
    expect(db.prepare('SELECT id, resource_id, verified FROM webhook_events WHERE id=?').get('WH-A')).toEqual({ id: 'WH-A', resource_id: capA, verified: 1 });
    expect(db.prepare('SELECT state, paypal_order_id FROM payment_requests WHERE id=?').get(b.id)).toEqual({ state: 'CAPTURE_PENDING', paypal_order_id: orderB });

    // duplicate webhook is still ignored (deduped by event id from the persisted table)
    expect((await postWebhook(app, webhook('WH-A', a.id, orderA, capA)).expect(200)).body).toEqual({ ok: true, duplicate: true });
    // repeat confirm of a captured payment never calls PayPal again
    expect((await pay.confirmAndCapture('h1', 'u1', a.id, orderA)).state).toBe('CAPTURED');
    expect(captureCalls.length).toBe(callsBefore);
    // idempotency key still resolves to the same request after restart
    expect((await pay.createRequest('h1', 'u1', [{ productId: 'kettle-classic', quantity: 1 }], 'restart_key_A', 'http://localhost')).request.id).toBe(a.id);

    // retrying the pending capture re-sends the SAME PayPal-Request-Id, so PayPal replays rather than charging twice
    const retried = await pay.confirmAndCapture('h1', 'u1', b.id, orderB);
    expect(retried.state).toBe('CAPTURED');
    const bCalls = captureCalls.filter((c) => c.orderId === orderB);
    expect(bCalls).toHaveLength(2);
    expect(new Set(bCalls.map((c) => c.requestId))).toEqual(new Set([b.id]));
    expect(retried.receipt?.captureId).toBe('CAP' + orderB);
    db.close();
  });
});
