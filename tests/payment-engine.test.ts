/**
 * Payment engine: explicit state-transition matrix (every allowed and forbidden edge, at the pure and the database
 * level) and failure injection (PayPal timeout / 5xx / 4xx / unknown body on create and capture, concurrent capture
 * x10, callback retry, reload, restart mid-capture, sample rows, durable idempotency).
 *
 * PayPal is a TEST DOUBLE that mirrors PayPal's documented idempotency: the same PayPal-Request-Id replays the
 * original result. `paypalCaptures` counts captures PayPal actually performed (money moved); `captureCalls` counts
 * HTTP capture calls SaySafe made. Both are asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Mode = 'ok' | 'timeout' | '5xx' | '4xx' | 'weird' | 'pending' | 'wrong_amount';
const st = vi.hoisted(() => ({
  orders: new Map<string, any>(),
  ordersByKey: new Map<string, string>(), // PayPal-Request-Id -> order id
  paypalCaptures: new Map<string, any>(), // capture PayPal-Request-Id -> capture
  createMode: 'ok' as string,
  captureMode: 'ok' as string,
  createCalls: [] as string[],
  captureCalls: [] as string[],
  captureDelayMs: 0,
}));
const fail = (status?: number, issue = 'X') => { const e: any = new Error(status ? `PayPal ${status}` : 'TimeoutError'); if (status) e.status = status; else e.name = 'TimeoutError'; e.data = { details: [{ issue }] }; return e; };

vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    const key = `create-${a.requestId}`;
    st.createCalls.push(key);
    if (st.createMode === 'timeout') throw fail();
    if (st.createMode === '5xx') throw fail(503);
    if (st.createMode === '4xx') throw fail(422, 'INVALID_PARAMETER_VALUE');
    const existing = st.ordersByKey.get(key);
    if (existing) return st.orders.get(existing); // idempotent replay
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    const links = st.createMode === 'weird' ? [] : [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }];
    st.orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links });
    st.ordersByKey.set(key, id);
    return st.orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => { const o = st.orders.get(id); if (!o) throw fail(404, 'RESOURCE_NOT_FOUND'); return JSON.parse(JSON.stringify(o)); }),
  captureOrder: vi.fn(async (orderId: string, requestId: string) => {
    const key = `capture-${requestId}`;
    st.captureCalls.push(key);
    if (st.captureDelayMs) await new Promise((r) => setTimeout(r, st.captureDelayMs));
    const o = st.orders.get(orderId);
    const replay = st.paypalCaptures.get(key);
    if (replay) return JSON.parse(JSON.stringify(o));
    const mode = st.captureMode;
    if (mode === 'timeout_nocapture') throw fail(); // request lost before PayPal acted: outcome unknown to SaySafe
    if (mode === '4xx') throw fail(422, 'INSTRUMENT_DECLINED_NOT');
    if (mode === 'declined') throw fail(422, 'INSTRUMENT_DECLINED');
    if (mode === '5xx') throw fail(500);
    const amount = mode === 'wrong_amount' ? { currency_code: 'EUR', value: '0.01' } : o.purchase_units[0].amount;
    const cap = { id: 'CAP' + orderId, status: mode === 'pending' ? 'PENDING' : 'COMPLETED', amount, create_time: new Date().toISOString() };
    if (mode === 'weird') return { id: orderId, status: 'SOMETHING_NEW' }; // 200 with a body we do not understand
    st.paypalCaptures.set(key, cap); // PayPal performed the capture (money moved)...
    o.status = 'COMPLETED';
    o.purchase_units[0].payments = { captures: [cap] };
    if (mode === 'timeout') throw fail(); // ...but the response never reached SaySafe
    return JSON.parse(JSON.stringify(o));
  }),
  getCapture: vi.fn(async () => { throw fail(); }),
  refundCapture: vi.fn(async () => { throw new Error('refund must never be called here'); }),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: (o: any) => (o?.links ?? [])[0]?.href ?? null,
}));

import * as pay from '../server/payments/service';
import { db } from '../server/db/index';
import { STATES, TRANSITIONS, assertTransition, TransitionError, type PaymentState } from '../server/payments/stateMachine';
import { reconcileForUser, finishApproved, __resetReconcileThrottle } from '../server/payments/reconcile';
import { requestRefund } from '../server/payments/refund';
import { seedDemoHousehold } from '../server/demo/seed';

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
const ORIGIN = 'http://localhost';
const orderOf = (id: string) => (db.prepare('SELECT paypal_order_id o FROM payment_requests WHERE id=?').get(id) as any)?.o as string;
const stateOf = (id: string) => (db.prepare('SELECT state FROM payment_requests WHERE id=?').get(id) as any)?.state as string;
const kettle = [{ productId: 'kettle-classic', quantity: 1 }];

async function approvedAtPayPal() {
  const h = household();
  const { request } = await pay.createRequest(h.hh, h.u, kettle, key(), ORIGIN);
  const orderId = orderOf(request.id);
  st.orders.get(orderId).status = 'APPROVED';
  return { ...h, id: request.id, orderId };
}

beforeEach(() => {
  st.createMode = 'ok'; st.captureMode = 'ok'; st.captureDelayMs = 0;
  st.createCalls.length = 0; st.captureCalls.length = 0;
  __resetReconcileThrottle();
});

// ---------------------------------------------------------------------------------------------------------------
describe('state-transition matrix (every edge)', () => {
  const pairs: [PaymentState, PaymentState, boolean][] = [];
  for (const from of STATES) for (const to of STATES) pairs.push([from, to, TRANSITIONS[from].includes(to)]);

  it(`covers all ${STATES.length * STATES.length} ordered pairs; allowed edges are exactly the documented ones`, () => {
    const allowed = pairs.filter((p) => p[2]).map(([a, b]) => `${a}->${b}`).sort();
    expect(allowed).toEqual([
      'DRAFT->RISK_REVIEW', 'DRAFT->CANCELLED',
      'RISK_REVIEW->BLOCKED', 'RISK_REVIEW->FAMILY_APPROVAL_PENDING', 'RISK_REVIEW->PAYER_APPROVAL_PENDING', 'RISK_REVIEW->CANCELLED',
      'FAMILY_APPROVAL_PENDING->FAMILY_APPROVED', 'FAMILY_APPROVAL_PENDING->CANCELLED',
      'FAMILY_APPROVED->PAYER_APPROVAL_PENDING', 'FAMILY_APPROVED->CANCELLED',
      'PAYER_APPROVAL_PENDING->PAYER_APPROVED', 'PAYER_APPROVAL_PENDING->CANCELLED', 'PAYER_APPROVAL_PENDING->FAILED',
      'PAYER_APPROVED->CAPTURE_PENDING', 'PAYER_APPROVED->CANCELLED',
      'CAPTURE_PENDING->CAPTURED', 'CAPTURE_PENDING->FAILED', 'CAPTURE_PENDING->CANCELLED',
      'CAPTURED->REFUND_PENDING', 'CAPTURED->REFUNDED',
      'REFUND_PENDING->REFUNDED', 'REFUND_PENDING->CAPTURED',
    ].sort());
    // Terminal states have no way out; nothing ever goes back to DRAFT; CAPTURED is reachable only from CAPTURE_PENDING
    // (or back from a refused refund).
    for (const t of ['BLOCKED', 'FAILED', 'CANCELLED', 'REFUNDED'] as PaymentState[]) expect(TRANSITIONS[t]).toEqual([]);
    expect(pairs.filter(([, to, ok]) => ok && to === 'DRAFT')).toEqual([]);
    expect(pairs.filter(([, to, ok]) => ok && to === 'CAPTURED').map(([f]) => f).sort()).toEqual(['CAPTURE_PENDING', 'REFUND_PENDING']);
  });

  it.each(pairs)('pure: %s -> %s (allowed=%s)', (from, to, ok) => {
    if (ok) expect(() => assertTransition(from, to)).not.toThrow();
    else expect(() => assertTransition(from, to)).toThrow(TransitionError);
  });

  it('database: every edge through transition(): allowed edges commit with version+1 and an audit row; forbidden edges change nothing', () => {
    const { hh } = household();
    let checked = 0;
    for (const [from, to, ok] of pairs) {
      const id = `pay_mx${checked}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare("INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint) VALUES (?,?,?,'[]','SaySafe Demo Shop (sandbox)',3200,'EUR','fp')").run(id, hh, from);
      const row = pay.load(id, hh);
      if (ok) {
        const out = pay.transition(row, to, 'matrix-test');
        expect(out.state).toBe(to);
        const now = pay.load(id, hh);
        expect([now.state, now.version]).toEqual([to, row.version + 1]);
        expect(db.prepare('SELECT COUNT(*) n FROM audit_log WHERE target=? AND action=?').get(id, `payment.${from}->${to}`)).toMatchObject({ n: 1 });
      } else {
        expect(() => pay.transition(row, to, 'matrix-test')).toThrow(TransitionError);
        const now = pay.load(id, hh);
        expect([now.state, now.version]).toEqual([from, row.version]);
      }
      checked++;
    }
    expect(checked).toBe(169);
  });

  it('optimistic lock: a stale copy of the row can never transition (replay / double click)', () => {
    const { hh } = household();
    db.prepare("INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint) VALUES ('pay_stale1',?, 'PAYER_APPROVED','[]','m',3200,'EUR','fp')").run(hh);
    const stale = pay.load('pay_stale1', hh);
    pay.transition(stale, 'CAPTURE_PENDING', 't');
    expect(() => pay.transition(stale, 'CAPTURE_PENDING', 't')).toThrow(/changed while we were working/);
    expect(() => pay.transition(stale, 'CANCELLED', 't')).toThrow(/changed while we were working/);
    expect(stateOf('pay_stale1')).toBe('CAPTURE_PENDING');
  });

  it('sample rows: every transition is refused before the state machine is even consulted', () => {
    const { hh, u } = household();
    seedDemoHousehold(hh, u);
    const samples = db.prepare('SELECT * FROM payment_requests WHERE household_id=? AND example=1').all(hh) as any[];
    expect(samples.length).toBeGreaterThan(5);
    for (const r of samples) for (const to of STATES) expect(() => pay.transition(r, to, 't')).toThrow(/sample data/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('failure injection: order create', () => {
  it('timeout: 503 paypal_unavailable, nothing recorded as failed, retry re-uses the SAME PayPal-Request-Id and creates one order', async () => {
    const { hh, u } = household();
    st.createMode = 'timeout';
    await expect(pay.createRequest(hh, u, kettle, key(), ORIGIN)).rejects.toMatchObject({ code: 'paypal_unavailable', status: 503 });
    const r = db.prepare('SELECT * FROM payment_requests WHERE household_id=?').get(hh) as any;
    expect(r.state).toBe('RISK_REVIEW');
    expect(r.paypal_order_id).toBeNull();
    st.createMode = 'ok';
    const url = await pay.startPayPalCheckout(hh, u, r.id, ORIGIN);
    expect(url).toMatch(/sandbox\.paypal\.com/);
    expect(st.createCalls).toEqual([`create-${r.id}`, `create-${r.id}`]);
    expect(stateOf(r.id)).toBe('PAYER_APPROVAL_PENDING');
  });
  it('5xx -> paypal_unavailable (unknown); 4xx -> paypal_rejected; neither moves state', async () => {
    for (const [mode, code] of [['5xx', 'paypal_unavailable'], ['4xx', 'paypal_rejected']] as const) {
      const { hh, u } = household();
      st.createMode = mode;
      await expect(pay.createRequest(hh, u, kettle, key(), ORIGIN)).rejects.toMatchObject({ code });
      expect((db.prepare('SELECT state FROM payment_requests WHERE household_id=?').get(hh) as any).state).toBe('RISK_REVIEW');
    }
  });
  it('unknown/odd body (no approval link): 502 paypal_no_link, never a redirect anywhere else, never a capture', async () => {
    const { hh, u } = household();
    st.createMode = 'weird';
    await expect(pay.createRequest(hh, u, kettle, key(), ORIGIN)).rejects.toMatchObject({ code: 'paypal_no_link' });
    expect(st.captureCalls).toEqual([]);
  });
});

describe('failure injection: capture', () => {
  it('timeout after PayPal captured: SaySafe re-reads the order, records CAPTURED from PayPal\'s answer; PayPal captured once', async () => {
    const p = await approvedAtPayPal();
    st.captureMode = 'timeout';
    expect((await pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)).state).toBe('CAPTURED');
    expect(st.captureCalls).toEqual([`capture-${p.id}`]);
    expect([...st.paypalCaptures.keys()].filter((k) => k === `capture-${p.id}`)).toHaveLength(1);
  });
  it('timeout where PayPal had not acted: outcome_unknown (503), stays CAPTURE_PENDING; retry re-sends the SAME id; one capture', async () => {
    const p = await approvedAtPayPal();
    st.captureMode = 'timeout_nocapture';
    await expect(pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)).rejects.toMatchObject({ code: 'outcome_unknown', status: 503 });
    expect(stateOf(p.id)).toBe('CAPTURE_PENDING');
    st.captureMode = 'ok';
    expect((await pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)).state).toBe('CAPTURED');
    expect(st.captureCalls).toEqual([`capture-${p.id}`, `capture-${p.id}`]);
    expect([...st.paypalCaptures.keys()].filter((k) => k === `capture-${p.id}`)).toHaveLength(1);
  });
  it('PayPal 5xx: outcome unknown, not failed; 4xx: FAILED with "no money was taken"', async () => {
    const a = await approvedAtPayPal();
    st.captureMode = '5xx';
    await expect(pay.confirmAndCapture(a.hh, a.u, a.id, a.orderId)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(stateOf(a.id)).toBe('CAPTURE_PENDING');
    const b = await approvedAtPayPal();
    st.captureMode = '4xx';
    await expect(pay.confirmAndCapture(b.hh, b.u, b.id, b.orderId)).rejects.toMatchObject({ code: 'capture_failed' });
    expect(stateOf(b.id)).toBe('FAILED');
  });
  it('INSTRUMENT_DECLINED: terminal FAILED (never stuck CAPTURE_PENDING), "nothing charged, start again"; no money moved; a retry does not capture', async () => {
    const p = await approvedAtPayPal();
    st.captureMode = 'declined';
    await expect(pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)).rejects.toMatchObject({ code: 'declined', status: 402, message: pay.DECLINED_MESSAGE });
    expect(pay.DECLINED_MESSAGE).toMatch(/Nothing was charged/);
    expect(pay.DECLINED_MESSAGE).toMatch(/start again/i);
    expect(stateOf(p.id)).toBe('FAILED');
    expect(st.paypalCaptures.has(`capture-${p.id}`)).toBe(false);
    st.captureMode = 'ok';
    await expect(pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)).rejects.toBeTruthy();
    expect(stateOf(p.id)).toBe('FAILED');
    expect(st.captureCalls).toEqual([`capture-${p.id}`]);
  });
  it('200 with an unknown body or a PENDING capture: never recorded as CAPTURED', async () => {
    const a = await approvedAtPayPal();
    st.captureMode = 'weird';
    expect((await pay.confirmAndCapture(a.hh, a.u, a.id, a.orderId)).state).toBe('CAPTURE_PENDING');
    const b = await approvedAtPayPal();
    st.captureMode = 'pending';
    expect((await pay.confirmAndCapture(b.hh, b.u, b.id, b.orderId)).state).toBe('CAPTURE_PENDING');
  });
  it('captured amount differs from the approved amount: refused, never CAPTURED', async () => {
    const a = await approvedAtPayPal();
    st.captureMode = 'wrong_amount';
    await expect(pay.confirmAndCapture(a.hh, a.u, a.id, a.orderId)).rejects.toMatchObject({ code: 'amount_mismatch' });
    expect(stateOf(a.id)).not.toBe('CAPTURED');
  });
  it('getOrder failing during confirm is a structured 503, not a generic 500', async () => {
    const a = await approvedAtPayPal();
    st.orders.delete(a.orderId);
    await expect(pay.confirmAndCapture(a.hh, a.u, a.id, a.orderId)).rejects.toMatchObject({ code: 'paypal_rejected' });
  });
});

describe('concurrency, callback retry, reload, restart', () => {
  it('10 concurrent confirms after buyer approval -> exactly ONE PayPal capture call, one CAPTURED', async () => {
    const p = await approvedAtPayPal();
    st.captureDelayMs = 40;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)));
    expect(st.captureCalls).toEqual([`capture-${p.id}`]);
    expect(stateOf(p.id)).toBe('CAPTURED');
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === 'rejected') expect(['conflict', 'capture_in_progress']).toContain((r.reason as any).code);
  });
  it('10 concurrent confirms on a CAPTURE_PENDING (unknown-outcome) payment -> exactly ONE capture call (lease)', async () => {
    const p = await approvedAtPayPal();
    st.captureMode = 'timeout_nocapture';
    await expect(pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)).rejects.toMatchObject({ code: 'outcome_unknown' });
    st.captureMode = 'ok'; st.captureCalls.length = 0; st.captureDelayMs = 40;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)));
    expect(st.captureCalls).toHaveLength(1);
    expect(stateOf(p.id)).toBe('CAPTURED');
    expect(results.filter((r) => r.status === 'rejected').every((r: any) => r.reason.code === 'capture_in_progress')).toBe(true);
  });
  it('callback retry (PayPal return URL opened twice) and later reloads never capture again', async () => {
    const p = await approvedAtPayPal();
    await pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId);
    await pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId);
    await finishApproved(p.hh, p.u, p.id).catch(() => null);
    await reconcileForUser(p.hh, p.id); // "reload" of the order page
    expect(st.captureCalls).toHaveLength(1);
    expect(stateOf(p.id)).toBe('CAPTURED');
  });
  it('reload while PayPal approval is pending only reads (reconcile never captures)', async () => {
    const h = household();
    const { request } = await pay.createRequest(h.hh, h.u, kettle, key(), ORIGIN);
    st.orders.get(orderOf(request.id)).status = 'APPROVED';
    const out = await reconcileForUser(h.hh, request.id);
    expect(out.outcome).toBe('buyer_approved');
    expect(st.captureCalls).toHaveLength(0);
  });
  it('restart mid-capture: the lease of the dead process blocks a second call until it expires; then the SAME id is re-sent and PayPal replays', async () => {
    const p = await approvedAtPayPal();
    // Process A: moved to CAPTURE_PENDING, won the lease, sent the capture (PayPal performed it), then died.
    let r = pay.load(p.id, p.hh);
    r = pay.transition(r, 'PAYER_APPROVED', 't');
    r = pay.transition(r, 'CAPTURE_PENDING', 't');
    expect(pay.claimCaptureLease(r)).toBe(true);
    st.captureMode = 'timeout';
    const cap = await import('../server/paypal/client');
    await (cap.captureOrder as any)(p.orderId, p.id).catch(() => null);
    st.captureMode = 'ok'; st.captureCalls.length = 0;
    // Process B (after restart), inside the lease window: refuses to call PayPal.
    await expect(pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)).rejects.toMatchObject({ code: 'capture_in_progress' });
    expect(st.captureCalls).toHaveLength(0);
    // Lease expired: retry re-sends capture-<id>; PayPal replays the original capture (one capture in total).
    db.prepare('UPDATE payment_requests SET capture_lease_until=? WHERE id=?').run(Date.now() - 1, p.id);
    expect((await pay.confirmAndCapture(p.hh, p.u, p.id, p.orderId)).state).toBe('CAPTURED');
    expect(st.captureCalls).toEqual([`capture-${p.id}`]);
    expect(st.paypalCaptures.has(`capture-${p.id}`)).toBe(true);
    expect((db.prepare('SELECT capture_lease_until l FROM payment_requests WHERE id=?').get(p.id) as any).l).toBeNull();
  });
});

describe('durable idempotency', () => {
  it('same key + same basket replays; same key + different basket is refused; another household cannot reuse a key', async () => {
    const a = household(); const b = household();
    const k = key();
    const first = await pay.createRequest(a.hh, a.u, kettle, k, ORIGIN);
    const again = await pay.createRequest(a.hh, a.u, kettle, k, ORIGIN);
    expect(again.request.id).toBe(first.request.id);
    await expect(pay.createRequest(a.hh, a.u, [{ productId: 'kettle-classic', quantity: 2 }], k, ORIGIN)).rejects.toMatchObject({ code: 'idempotency_key_reused', status: 409 });
    await expect(pay.createRequest(b.hh, b.u, kettle, k, ORIGIN)).rejects.toMatchObject({ code: 'conflict' });
    expect(st.createCalls.filter((c) => c === `create-${first.request.id}`)).toHaveLength(1);
  });
});

describe('sample rows can never trigger PayPal or money movement', () => {
  it('checkout, confirm, finish, cancel, family decision, reconcile and refund request are all refused; PayPal is never called', async () => {
    const { hh, u, fam } = household();
    seedDemoHousehold(hh, u);
    const rows = db.prepare('SELECT * FROM payment_requests WHERE household_id=? AND example=1').all(hh) as any[];
    const client = await import('../server/paypal/client');
    for (const r of rows) {
      await expect(pay.startPayPalCheckout(hh, u, r.id, ORIGIN)).rejects.toMatchObject({ code: 'sample_not_actionable' });
      await expect(pay.confirmAndCapture(hh, u, r.id, 'ORDERSAMPLE0001')).rejects.toMatchObject({ code: 'sample_not_actionable' });
      await expect(finishApproved(hh, u, r.id)).rejects.toMatchObject({ code: 'sample_not_actionable' });
      expect(() => pay.cancelRequest(hh, u, r.id)).toThrow(/sample data/);
      await expect(reconcileForUser(hh, r.id)).rejects.toMatchObject({ code: 'sample_not_actionable' });
      expect(() => requestRefund(hh, u, r.id, 'x')).toThrow();
      const a = db.prepare('SELECT id FROM approvals WHERE request_id=?').get(r.id) as any;
      if (a) expect(() => pay.decide(hh, fam, r.id, a.id, 'approve')).toThrow(/sample data/);
    }
    expect((client.getOrder as any).mock.calls.filter((c: any[]) => String(c[0]).includes('SAMPLE'))).toHaveLength(0);
    expect(st.captureCalls).toHaveLength(0);
    // States are exactly as seeded.
    for (const r of rows) expect(stateOf(r.id)).toBe(r.state);
  });
  it('a (forged) PayPal webhook naming a sample row is ignored, not retried forever', () => {
    const { hh, u } = household();
    seedDemoHousehold(hh, u);
    const r = db.prepare("SELECT * FROM payment_requests WHERE household_id=? AND example=1 AND state='CAPTURE_PENDING'").get(hh) as any;
    expect(pay.reconcileFromWebhook({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPX', custom_id: r.id, amount: { value: '1.00', currency_code: 'EUR' } } })).toBe('sample_ignored');
    expect(stateOf(r.id)).toBe('CAPTURE_PENDING');
  });
});
