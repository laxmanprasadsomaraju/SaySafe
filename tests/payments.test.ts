/**
 * Payment policy tests. PayPal is replaced by a TEST DOUBLE here only (vi.mock);
 * the real sandbox flow is exercised by scripts/paypal-smoke.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const orders = new Map<string, any>();
let captureMode: 'ok' | 'fail' | 'already' = 'ok';
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => orders.get(id)),
  captureOrder: vi.fn(async (id: string) => {
    const o = orders.get(id);
    if (captureMode === 'fail') { const e: any = new Error('fail'); e.data = { details: [{ issue: 'X' }] }; throw e; }
    if (captureMode === 'already' && o.status === 'COMPLETED') { const e: any = new Error('already'); e.data = { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }; throw e; }
    o.status = 'COMPLETED';
    o.purchase_units[0].payments = { captures: [{ id: 'CAP' + id, status: 'COMPLETED', amount: o.purchase_units[0].amount }] };
    return o;
  }),
  refundCapture: vi.fn(async () => ({ status: 'COMPLETED' })),
  verifyWebhook: vi.fn(async () => true),
  approveLink: (o: any) => o.links[0].href,
}));

import * as pay from '../server/payments/service';
import { db } from '../server/db/index';
import { assertTransition, TransitionError } from '../server/payments/stateMachine';

function household(threshold = 7500) {
  const hh = 'hh_' + Math.random().toString(36).slice(2);
  const u = 'usr_' + Math.random().toString(36).slice(2);
  db.prepare("INSERT INTO users (id,name,role) VALUES (?,?,'elder')").run(u, 'Mary');
  db.prepare('INSERT INTO households (id, elder_id) VALUES (?,?)').run(hh, u);
  db.prepare('INSERT INTO spending_policies (household_id, approval_threshold_cents) VALUES (?,?)').run(hh, threshold);
  const fam = 'usr_' + Math.random().toString(36).slice(2);
  db.prepare("INSERT INTO users (id,name,role) VALUES (?,?,'family')").run(fam, 'Alex');
  return { hh, u, fam };
}
const key = () => 'k' + Math.random().toString(36).slice(2, 14);
const approve = (o: string) => { orders.get(o).status = 'APPROVED'; };
const ORIGIN = 'http://localhost';

beforeEach(() => { captureMode = 'ok'; });

describe('state machine', () => {
  it('rejects illegal transitions', () => {
    expect(() => assertTransition('BLOCKED', 'CAPTURE_PENDING')).toThrow(TransitionError);
    expect(() => assertTransition('FAMILY_APPROVED', 'CAPTURED')).toThrow(TransitionError);
    expect(() => assertTransition('FAMILY_APPROVED', 'PAYER_APPROVED')).toThrow(TransitionError);
  });
});

describe('happy path under threshold', () => {
  it('kettle €32: payer approves at PayPal, server verifies and captures', async () => {
    const { hh, u } = household();
    const { request, approveUrl } = await pay.createRequest(hh, u, [{ productId: 'kettle-classic', quantity: 1 }], key(), ORIGIN);
    expect(request.state).toBe('PAYER_APPROVAL_PENDING');
    expect(approveUrl).toMatch(/sandbox\.paypal\.com/);
    const orderId = db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(request.id) as any;
    // redirect without payer approval must not capture
    await expect(pay.confirmAndCapture(hh, u, request.id, orderId.o)).rejects.toThrow(/not confirmed/);
    approve(orderId.o);
    const done = await pay.confirmAndCapture(hh, u, request.id, orderId.o);
    expect(done.state).toBe('CAPTURED');
    expect(done.receipt?.amount).toBe('32.00');
    // duplicate confirm is idempotent
    expect((await pay.confirmAndCapture(hh, u, request.id, orderId.o)).state).toBe('CAPTURED');
    // A different PayPal order id must never unlock an already-captured receipt.
    await expect(pay.confirmAndCapture(hh, u, request.id, 'OTHERORDER999')).rejects.toThrow(/does not belong/);
  });

  it('idempotency key returns the same request', async () => {
    const { hh, u } = household();
    const k = key();
    const a = await pay.createRequest(hh, u, [{ productId: 'toaster', quantity: 1 }], k, ORIGIN);
    const b = await pay.createRequest(hh, u, [{ productId: 'toaster', quantity: 1 }], k, ORIGIN);
    expect(a.request.id).toBe(b.request.id);
  });

  it('client cannot set prices or unknown products', async () => {
    const { hh, u } = household();
    await expect(pay.createRequest(hh, u, [{ productId: 'nope', quantity: 1 }], key(), ORIGIN)).rejects.toThrow(/not in the shop/);
    const r = await pay.createRequest(hh, u, [{ productId: 'kettle-classic', quantity: 1, priceCents: 1 } as any], key(), ORIGIN);
    expect(r.request.amountCents).toBe(3200);
  });

  it('rejects a mismatched order id from the redirect', async () => {
    const { hh, u } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'radio', quantity: 1 }], key(), ORIGIN);
    await expect(pay.confirmAndCapture(hh, u, request.id, 'FAKEORDER12345')).rejects.toThrow(/does not belong/);
  });

  it('detects a tampered PayPal amount and fails safely', async () => {
    const { hh, u } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'radio', quantity: 1 }], key(), ORIGIN);
    const o = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(request.id) as any).o;
    orders.get(o).purchase_units[0].amount.value = '1.00';
    approve(o);
    await expect(pay.confirmAndCapture(hh, u, request.id, o)).rejects.toThrow(/does not match/);
    expect((db.prepare('SELECT state FROM payment_requests WHERE id=?').get(request.id) as any).state).toBe('FAILED');
  });

  it('wrong currency from PayPal is rejected', async () => {
    const { hh, u } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'lamp-x', quantity: 1 }].map(() => ({ productId: 'reading-lamp', quantity: 1 })), key(), ORIGIN);
    const o = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(request.id) as any).o;
    orders.get(o).purchase_units[0].amount.currency_code = 'USD';
    approve(o);
    await expect(pay.confirmAndCapture(hh, u, request.id, o)).rejects.toThrow();
  });

  it('capture failure ends FAILED and says no money taken', async () => {
    const { hh, u } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'toaster', quantity: 1 }], key(), ORIGIN);
    const o = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(request.id) as any).o;
    approve(o);
    captureMode = 'fail';
    await expect(pay.confirmAndCapture(hh, u, request.id, o)).rejects.toThrow(/No money was taken/);
  });
});

describe('family approval', () => {
  it('microwave €120 above €75 needs family; approval does not skip payer approval', async () => {
    const { hh, u, fam } = household();
    const { request, approveUrl } = await pay.createRequest(hh, u, [{ productId: 'microwave', quantity: 1 }], key(), ORIGIN);
    expect(request.state).toBe('FAMILY_APPROVAL_PENDING');
    expect(approveUrl).toBeNull();
    // cannot start checkout before approval
    await expect(pay.startPayPalCheckout(hh, u, request.id, ORIGIN)).rejects.toThrow(/Cannot start checkout/);
    const decided = pay.decide(hh, fam, request.id, request.approval!.id, 'approve');
    expect(decided.state).toBe('FAMILY_APPROVED');
    // replay of the same decision is rejected
    expect(() => pay.decide(hh, fam, request.id, request.approval!.id, 'approve')).toThrow(/already decided/);
    const url = await pay.startPayPalCheckout(hh, u, request.id, ORIGIN);
    expect(url).toMatch(/paypal/);
    const o = (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(request.id) as any).o;
    await expect(pay.confirmAndCapture(hh, u, request.id, o)).rejects.toThrow(/not confirmed/); // payer must still approve
    approve(o);
    expect((await pay.confirmAndCapture(hh, u, request.id, o)).state).toBe('CAPTURED');
  });

  it('declined request cannot proceed', async () => {
    const { hh, u, fam } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'microwave', quantity: 1 }], key(), ORIGIN);
    expect(pay.decide(hh, fam, request.id, request.approval!.id, 'decline').state).toBe('CANCELLED');
    await expect(pay.startPayPalCheckout(hh, u, request.id, ORIGIN)).rejects.toThrow();
  });

  it('expired approval cannot be used', async () => {
    const { hh, u, fam } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'microwave', quantity: 1 }], key(), ORIGIN);
    db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(Date.now() - 1, request.approval!.id);
    expect(() => pay.decide(hh, fam, request.id, request.approval!.id, 'approve')).toThrow(/expired/);
  });

  it('changed basket invalidates approval (fingerprint binding)', async () => {
    const { hh, u, fam } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'microwave', quantity: 1 }], key(), ORIGIN);
    pay.decide(hh, fam, request.id, request.approval!.id, 'approve');
    // attacker edits the basket after approval
    db.prepare('UPDATE payment_requests SET items_json=?, fingerprint=? WHERE id=?').run(JSON.stringify([{ productId: 'microwave', name: 'x', unitCents: 12000, quantity: 3, lineCents: 36000, image: '' }]), 'tampered', request.id);
    await expect(pay.startPayPalCheckout(hh, u, request.id, ORIGIN)).rejects.toThrow(/no longer matches/);
  });

  it('forged approval from another household is rejected', async () => {
    const a = household();
    const b = household();
    const { request } = await pay.createRequest(a.hh, a.u, [{ productId: 'microwave', quantity: 1 }], key(), ORIGIN);
    expect(() => pay.decide(b.hh, b.fam, request.id, request.approval!.id, 'approve')).toThrow(/not found/);
  });
});

describe('blocking', () => {
  it('above €500 hard cap is BLOCKED and can never be captured', async () => {
    const { hh, u } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'microwave', quantity: 5 }], key(), ORIGIN);
    expect(request.state).toBe('BLOCKED');
    await expect(pay.startPayPalCheckout(hh, u, request.id, ORIGIN)).rejects.toThrow();
  });
});

describe('webhooks', () => {
  it('reconciles a pending capture and ignores repeats', async () => {
    const { hh, u } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'pill-organiser', quantity: 1 }], key(), ORIGIN);
    db.prepare("UPDATE payment_requests SET state='CAPTURE_PENDING' WHERE id=?").run(request.id);
    const ev = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPX', custom_id: request.id, amount: { value: '19.00', currency_code: 'EUR' } } };
    expect(pay.reconcileFromWebhook(ev)).toBe('captured');
    expect(pay.reconcileFromWebhook(ev)).toBe('no_change');
  });
  it('rejects webhook with wrong amount', async () => {
    const { hh, u } = household();
    const { request } = await pay.createRequest(hh, u, [{ productId: 'pill-organiser', quantity: 1 }], key(), ORIGIN);
    db.prepare("UPDATE payment_requests SET state='CAPTURE_PENDING' WHERE id=?").run(request.id);
    expect(pay.reconcileFromWebhook({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C', custom_id: request.id, amount: { value: '1.00', currency_code: 'EUR' } } })).toBe('amount_mismatch');
  });
});
