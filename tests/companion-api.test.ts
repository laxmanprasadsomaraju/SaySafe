/**
 * Payment companion HTTP API: elder-only, household-scoped, family 403, deletion, search, subscriptions, contacts,
 * the scam contact check over HTTP, and the SaySafe Demo Membership (PayPal sandbox subscription) with PayPal as a
 * TEST DOUBLE. AI is off here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.hoisted(() => { process.env.PAYPAL_DEMO_PLAN_ID = 'P-TESTPLAN'; process.env.COMPANION_LIMIT_PER_MIN = '1000'; process.env.API_LIMIT_PER_MIN = '5000'; });

const subs = new Map<string, any>();
let cancelMode: 'ok' | '500' | 'timeout' | '422' = 'ok';
let getFails = false;
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(), getOrder: vi.fn(), captureOrder: vi.fn(), getCapture: vi.fn(), refundCapture: vi.fn(), getRefund: vi.fn(),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: () => null,
  createSubscription: vi.fn(async (a: any) => {
    const id = 'I-' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const s = { id, status: 'APPROVAL_PENDING', custom_id: a.customId, plan_id: a.planId, links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${id}` }] };
    subs.set(id, s);
    return s;
  }),
  getSubscription: vi.fn(async (id: string) => { if (getFails) throw Object.assign(new Error('timeout'), {}); const s = subs.get(id); if (!s) throw Object.assign(new Error('404'), { status: 404 }); return { ...s }; }),
  cancelSubscription: vi.fn(async (id: string) => {
    const s = subs.get(id);
    if (cancelMode === '500') throw Object.assign(new Error('500'), { status: 500, data: { name: 'INTERNAL_SERVER_ERROR' } });
    if (cancelMode === 'timeout') throw new Error('The operation was aborted due to timeout');
    if (cancelMode === '422' || s.status === 'CANCELLED') throw Object.assign(new Error('422'), { status: 422, data: { details: [{ issue: 'SUBSCRIPTION_STATUS_INVALID' }] } });
    s.status = 'CANCELLED'; s.status_update_time = '2026-11-03T10:30:00Z';
    return null; // 204
  }),
  subscriptionApproveLink: (s: any) => s?.links?.find((l: any) => l.rel === 'approve')?.href ?? null,
}));

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import * as client from '../server/paypal/client';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
async function elder(name = 'Mary') {
  const a = request.agent(app);
  await a.post('/api/demo/start').set(H).send({ name }).expect(200);
  const hh = (db.prepare('SELECT household_id FROM sessions ORDER BY rowid DESC LIMIT 1').get() as any).household_id as string;
  return { a, hh };
}
async function familyFor(e: ReturnType<typeof request.agent>) {
  const { body } = await e.post('/api/family/invite').set(H).send({}).expect(200);
  const f = request.agent(app);
  await f.post('/api/family/pair').set(H).send({ code: body.code, name: 'Alex' }).expect(200);
  return f;
}
const addShopPayment = (hh: string, cents: number, items = 'Classic Kettle') => {
  const id = 'pay_' + Math.random().toString(36).slice(2, 12);
  db.prepare("INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, paypal_capture_id) VALUES (?,?,'CAPTURED',?,'SaySafe Demo Shop',?,'EUR','fp',?)")
    .run(id, hh, JSON.stringify([{ productId: 'kettle-classic', name: items, quantity: 1 }]), cents, 'CAP' + id.toUpperCase());
  return id;
};
beforeEach(() => { cancelMode = 'ok'; getFails = false; vi.mocked(client.cancelSubscription).mockClear(); });

describe('access: elder-only, household-scoped', () => {
  it('no session -> 401; family session -> 403 on every companion route', async () => {
    await request(app).get('/api/companion/payments').expect(401);
    const { a } = await elder();
    const f = await familyFor(a);
    for (const [m, p] of [['get', '/api/companion/payments'], ['get', '/api/companion/payments/search?q=John'], ['get', '/api/companion/contacts'], ['get', '/api/companion/subscriptions'], ['get', '/api/companion/subscriptions/summary'], ['post', '/api/companion/contacts'], ['delete', '/api/companion/all'], ['post', '/api/companion/subscriptions/demo/cancel']] as const) {
      const r = await (f as any)[m](p).set(H).send({});
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.error).toBe('elder_only');
    }
  });
  it('one household can never read, change or delete another household\'s records', async () => {
    const A = await elder('Mary'); const B = await elder('Nora');
    const p = (await A.a.post('/api/companion/payments').set(H).send({ recipient: 'John Murphy', amountCents: 8000, paidOn: '2026-10-01', method: 'bank_transfer' }).expect(201)).body;
    const c = (await A.a.post('/api/companion/contacts').set(H).send({ name: 'Tom', relation: 'son', phone: '087 123 4567' }).expect(201)).body;
    const s = (await A.a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Netflix', amountCents: 1399, frequency: 'monthly' }).expect(201)).body;
    await B.a.get(`/api/companion/payments/${p.id}`).expect(404);
    await B.a.patch(`/api/companion/payments/${p.id}`).set(H).send({ amountCents: 1 }).expect(404);
    await B.a.delete(`/api/companion/payments/${p.id}`).expect(404);
    await B.a.get(`/api/companion/contacts/${c.id}`).expect(404);
    await B.a.post(`/api/companion/subscriptions/${s.id}/status`).set(H).send({ to: 'instructions_opened' }).expect(404);
    expect((await B.a.get('/api/companion/payments/search?q=John').expect(200)).body.matches).toEqual([]);
    expect((await B.a.get('/api/companion/contacts').expect(200)).body.contacts).toEqual([]);
    await B.a.delete('/api/companion/all').set(H).send({ confirm: true }).expect(200);
    expect((await A.a.get('/api/companion/payments').expect(200)).body.payments).toHaveLength(1); // B's delete-all did not touch A
  });
  it('family overview, insights and activity never include companion records', async () => {
    const { a } = await elder();
    await a.post('/api/companion/payments').set(H).send({ recipient: 'Secret Recipient Xyz', amountCents: 4242, paidOn: '2026-10-01' }).expect(201);
    await a.post('/api/companion/contacts').set(H).send({ name: 'Hidden Contact Qq', phone: '0870000000' }).expect(201);
    const f = await familyFor(a);
    const dump = JSON.stringify([(await f.get('/api/family/overview')).body, (await f.get('/api/activity?as=family')).body, (await f.get('/api/family/insights')).body]);
    expect(dump).not.toMatch(/Secret Recipient|Hidden Contact|4242/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'companion%'").get()).toEqual({ n: 0 });
  });
});

describe('manual payment records + search', () => {
  it('CRUD with validation', async () => {
    const { a } = await elder();
    await a.post('/api/companion/payments').set(H).send({ recipient: '', amountCents: 8000, paidOn: '2026-10-01' }).expect(400);
    await a.post('/api/companion/payments').set(H).send({ recipient: 'John', amountCents: -5, paidOn: '2026-10-01' }).expect(400);
    await a.post('/api/companion/payments').set(H).send({ recipient: 'John', amountCents: 8000, paidOn: '2026-02-30' }).expect(400);
    await a.post('/api/companion/payments').set(H).send({ recipient: 'John', amountCents: 8000, paidOn: '2026-10-01', householdId: 'hh_other' }).expect(400); // strict: no smuggled fields
    const p = (await a.post('/api/companion/payments').set(H).send({ recipient: 'John Murphy', amountCents: 8000, paidOn: '2026-10-01', method: 'bank_transfer', note: 'hedge' }).expect(201)).body;
    expect(p.label).toBe('Recorded by you, not verified');
    expect((await a.patch(`/api/companion/payments/${p.id}`).set(H).send({ amountCents: 8500 }).expect(200)).body.amountCents).toBe(8500);
    await a.delete(`/api/companion/payments/${p.id}`).expect(200);
    await a.get(`/api/companion/payments/${p.id}`).expect(404);
  });
  it('search returns Demo Shop payments with evidence and manual records labelled unverified; "John" never gets the shop payment', async () => {
    const { a, hh } = await elder();
    addShopPayment(hh, 8000);
    await a.post('/api/companion/payments').set(H).send({ recipient: 'Jon Murphy', amountCents: 8000, paidOn: '2026-10-01', method: 'bank_transfer' }).expect(201);
    const r = (await a.get('/api/companion/payments/search?q=John&amount=80&from=2026-10-01&to=2026-10-01').expect(200)).body;
    expect(r.matches.map((m: any) => m.source)).toEqual(['manual']);
    expect(r.matches[0].caveats.join(' ')).toMatch(/Spelled differently/);
    expect(r.matches[0].caveats.join(' ')).toMatch(/more than one payment of €80/);
    expect(r.notes.join(' ')).toMatch(/not payments to John/);
    const k = (await a.get('/api/companion/payments/search?q=kettle').expect(200)).body;
    expect(k.matches[0]).toMatchObject({ source: 'paypal_sandbox', recipient: 'SaySafe Demo Shop', evidence: { kind: 'paypal_sandbox', captureStatus: 'COMPLETED', webhookVerified: false } });
    await a.get('/api/companion/payments/search?from=2026-10-05&to=2026-10-01').expect(400);
    await a.get('/api/companion/payments/search?amount=abc').expect(400);
  });
});

describe('subscriptions (manual = external merchants)', () => {
  it('summary normalises monthly/annual per currency without converting', async () => {
    const { a } = await elder();
    await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Netflix', amountCents: 1200, frequency: 'monthly' }).expect(201);
    await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Paper', amountCents: 300, frequency: 'weekly' }).expect(201);
    await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Amazon Prime', amountCents: 9500, currency: 'GBP', frequency: 'yearly' }).expect(201);
    const s = (await a.get('/api/companion/subscriptions/summary').expect(200)).body;
    expect(s.totals).toEqual([
      { currency: 'EUR', count: 2, monthlyCents: 1200 + 1300, annualCents: 14400 + 15600 },
      { currency: 'GBP', count: 1, monthlyCents: 792, annualCents: 9500 },
    ]);
    expect(s.label).toMatch(/Prototype/);
  });
  it('help-me-cancel gives the official link + PayPal autopay page; statuses stop at user_reported_cancelled', async () => {
    const { a } = await elder();
    const sub = (await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Netflix', amountCents: 1399, frequency: 'monthly', nextOn: '2026-11-10' }).expect(201)).body;
    expect(sub.guide.url).toBe('https://help.netflix.com/en/node/407');
    await a.post(`/api/companion/subscriptions/${sub.id}/status`).set(H).send({ to: 'user_reported_cancelled' }).expect(409); // must open instructions first
    const help = (await a.post(`/api/companion/subscriptions/${sub.id}/cancel-help`).set(H).send({}).expect(200)).body;
    expect(help.subscription.status).toBe('instructions_opened');
    expect(help.paypalAutopay.url).toBe('https://www.paypal.com/myaccount/autopay/');
    expect(help.cancellationScope.serviceContract).toMatch(/between you and the company/);
    for (const to of ['provider_confirmed', 'cancellation_requested', 'cancelled']) await a.post(`/api/companion/subscriptions/${sub.id}/status`).set(H).send({ to, evidenceNote: 'email', confirmedOn: '2026-11-03' }).expect(400);
    const done = (await a.post(`/api/companion/subscriptions/${sub.id}/status`).set(H).send({ to: 'user_reported_cancelled', note: 'Got Netflix email' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'user_reported_cancelled', statusLabel: 'You told SaySafe this is cancelled — not confirmed by the provider', confirmedBy: 'user', source: 'manual' });
    expect(() => db.prepare("UPDATE companion_subscriptions SET sub_state='provider_confirmed' WHERE id=?").run(sub.id)).toThrow(/CHECK/); // DB backstop
    const sum = (await a.get('/api/companion/subscriptions/summary').expect(200)).body;
    expect(sum.excluded.userReportedCancelled).toBe(1);
    // Stop tracking is separate from cancelling
    const sub2 = (await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Spotify', amountCents: 1199, frequency: 'monthly' }).expect(201)).body;
    const st = (await a.post(`/api/companion/subscriptions/${sub2.id}/stop-tracking`).set(H).send({}).expect(200)).body;
    expect(st.status).toBe('tracking'); expect(st.stoppedTrackingAt).toBeTruthy();
  });
});

describe('trusted contacts + delete all', () => {
  it('CRUD, max 50, labelled not verified', async () => {
    const { a } = await elder();
    const c = (await a.post('/api/companion/contacts').set(H).send({ name: 'Tom', relation: 'son', phone: '087 123 4567', email: 'tom@example.ie' }).expect(201)).body;
    expect(c.label).toBe('Saved by you — not verified');
    await a.post('/api/companion/contacts').set(H).send({ name: 'X', phone: 'call me' }).expect(400);
    expect((await a.patch(`/api/companion/contacts/${c.id}`).set(H).send({ phone: '+353 87 999 0000' }).expect(200)).body.phone).toBe('+353 87 999 0000');
    for (let i = 0; i < 49; i++) await a.post('/api/companion/contacts').set(H).send({ name: `P${i}` }).expect(201);
    expect((await a.post('/api/companion/contacts').set(H).send({ name: 'One too many' }).expect(409)).body.error).toBe('limit_reached');
    await a.delete(`/api/companion/contacts/${c.id}`).expect(200);
  });
  it('delete all needs confirm and removes every companion record, but not Demo Shop payments', async () => {
    const { a, hh } = await elder();
    addShopPayment(hh, 3200);
    await a.post('/api/companion/payments').set(H).send({ recipient: 'John', amountCents: 8000, paidOn: '2026-10-01' }).expect(201);
    await a.post('/api/companion/contacts').set(H).send({ name: 'Tom' }).expect(201);
    await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Netflix', amountCents: 1399, frequency: 'monthly' }).expect(201);
    await a.delete('/api/companion/all').set(H).send({}).expect(400);
    expect((await a.delete('/api/companion/all').set(H).send({ confirm: true }).expect(200)).body.deleted).toEqual({ payments: 1, subscriptions: 1, contacts: 1 });
    for (const t of ['companion_payments', 'companion_subscriptions', 'companion_contacts']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE household_id=?`).get(hh)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE household_id=?').get(hh)).toEqual({ n: 1 });
  });
});

describe('scan uses the signed-in elder\'s contacts (server-side only)', () => {
  it('contact_mismatch over HTTP; another household\'s contacts are never used', async () => {
    const A = await elder(); const B = await elder('Nora');
    await A.a.post('/api/companion/contacts').set(H).send({ name: 'Tom', relation: 'son', phone: '087 123 4567' }).expect(201);
    const text = "Hi Mum it's me, new number 089 765 4321. Can you send €300 today?";
    const ra = (await A.a.post('/api/scan').set(H).send({ text }).expect(200)).body;
    expect(ra.signals[0].title).toBe("This says it's from Tom, but the number isn't the one you saved");
    expect(ra.contactCheck.advice).toMatch(/Call Tom on the number you saved/);
    const rb = (await B.a.post('/api/scan').set(H).send({ text }).expect(200)).body;
    expect(rb.signals.some((s: any) => s.code === 'contact_mismatch')).toBe(false);
    const stored = db.prepare('SELECT summary FROM security_scans WHERE id=?').get(ra.scanId) as any;
    expect(stored.summary).not.toMatch(/Tom|4567/);
  });
});

describe('SaySafe Demo Membership (PayPal sandbox subscription, test double)', () => {
  const activate = (id: string) => { subs.get(id).status = 'ACTIVE'; };
  it('start returns PayPal\'s approve link, custom_id = household; start again reuses it', async () => {
    const { a, hh } = await elder();
    const s = (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    expect(s.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(s.subscription).toMatchObject({ source: 'paypal_sandbox_subscription', merchant: 'SaySafe Demo Membership', amountCents: 299, currency: 'EUR', status: 'tracking' });
    const call = vi.mocked(client.createSubscription).mock.calls.at(-1)![0];
    expect(call).toMatchObject({ planId: 'P-TESTPLAN', customId: hh });
    expect(call.requestId).toBe(`saysafe-demo-sub-${s.subscription.id}`);
    expect(call.returnUrl).toMatch(/\/api\/companion\/subscriptions\/demo\/return$/);
    const again = (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    expect(again.reused).toBe(true);
    expect(again.subscription.paypal.subscriptionId).toBe(s.subscription.paypal.subscriptionId);
  });
  it('return route reads PayPal and redirects into the app; status shows PayPal\'s status', async () => {
    const { a } = await elder();
    const s = (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    activate(s.subscription.paypal.subscriptionId);
    const r = await a.get('/api/companion/subscriptions/demo/return?subscription_id=x&ba_token=y').expect(303);
    expect(r.headers.location).toBe('/assistant?membership=active');
    const st = (await a.get('/api/companion/subscriptions/demo/status').expect(200)).body.subscription;
    expect(st.paypal).toMatchObject({ status: 'ACTIVE', approveUrl: null, webhookVerified: false });
    const sum = (await a.get('/api/companion/subscriptions/summary').expect(200)).body;
    expect(sum.totals).toEqual([{ currency: 'EUR', count: 1, monthlyCents: 299, annualCents: 3588 }]);
  });
  it('cancel needs the tapped token: intent -> cancel -> PayPal 204 -> GET CANCELLED -> provider_confirmed (paypal_api)', async () => {
    const { a } = await elder();
    const s = (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    await a.post('/api/companion/subscriptions/demo/cancel-intent').set(H).send({}).expect(409); // not approved yet
    activate(s.subscription.paypal.subscriptionId);
    await a.get('/api/companion/subscriptions/demo/return').expect(303);
    await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({}).expect(400); // no token
    await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: 'x'.repeat(32) }).expect(403); // made-up token
    const i = (await a.post('/api/companion/subscriptions/demo/cancel-intent').set(H).send({}).expect(200)).body;
    expect(i.confirmText).toBe('Cancel SaySafe Demo Membership billing via PayPal');
    expect(Date.parse(i.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(client.cancelSubscription).not.toHaveBeenCalled();
    const c = (await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(200)).body;
    expect(c.outcome).toBe('confirmed');
    expect(c.subscription).toMatchObject({ status: 'provider_confirmed', confirmedBy: 'paypal_api', paypal: { status: 'CANCELLED', cancel: { state: 'confirmed' } } });
    expect(c.subscription.cancellationScope.billingAuthorisation).toMatch(/PayPal billing authorisation/);
    expect(client.cancelSubscription).toHaveBeenCalledTimes(1);
    expect((await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(409)).body.error).toBe('token_used'); // single use
  });
  it('a token is bound to its household and expires', async () => {
    const A = await elder(); const B = await elder('Nora');
    const s = (await A.a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    activate(s.subscription.paypal.subscriptionId);
    await A.a.get('/api/companion/subscriptions/demo/return').expect(303);
    const i = (await A.a.post('/api/companion/subscriptions/demo/cancel-intent').set(H).send({}).expect(200)).body;
    await B.a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(403);
    const f = await familyFor(A.a);
    await f.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(403);
    db.prepare('UPDATE companion_cancel_tokens SET expires_at=?').run(Date.now() - 1);
    await A.a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(410);
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });
  it('PayPal 5xx or timeout -> retry_needed (202), nothing confirmed; a new tap retries and succeeds', async () => {
    const { a } = await elder();
    const s = (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    activate(s.subscription.paypal.subscriptionId);
    await a.get('/api/companion/subscriptions/demo/return').expect(303);
    for (const mode of ['500', 'timeout'] as const) {
      cancelMode = mode;
      const i = (await a.post('/api/companion/subscriptions/demo/cancel-intent').set(H).send({}).expect(200)).body;
      const r = await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(202);
      expect(r.body.outcome).toBe('retry_needed');
      expect(r.body.subscription.status).toBe('cancellation_requested');
      expect(r.body.subscription.paypal.cancel.state).toBe('retry_needed');
      expect(r.body.message).toMatch(/Not cancelled yet/);
    }
    cancelMode = 'ok';
    const i = (await a.post('/api/companion/subscriptions/demo/cancel-intent').set(H).send({}).expect(200)).body;
    expect((await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(200)).body.subscription.status).toBe('provider_confirmed');
  });
  it('cancel answered 4xx but GET shows CANCELLED -> idempotent success; GET failing -> retry_needed', async () => {
    const { a } = await elder();
    const s = (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    const pid = s.subscription.paypal.subscriptionId;
    activate(pid);
    await a.get('/api/companion/subscriptions/demo/return').expect(303);
    cancelMode = '422'; getFails = true;
    let i = (await a.post('/api/companion/subscriptions/demo/cancel-intent').set(H).send({}).expect(200)).body;
    expect((await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(202)).body.message).toMatch(/PayPal answered 422 SUBSCRIPTION_STATUS_INVALID/);
    getFails = false; subs.get(pid).status = 'CANCELLED'; // cancelled elsewhere (e.g. in the PayPal account)
    i = (await a.post('/api/companion/subscriptions/demo/cancel-intent').set(H).send({}).expect(200)).body;
    const r = (await a.post('/api/companion/subscriptions/demo/cancel').set(H).send({ token: i.token }).expect(200)).body;
    expect(r.outcome).toBe('already_cancelled');
    expect(r.subscription).toMatchObject({ status: 'provider_confirmed', confirmedBy: 'paypal_api' });
  });
  it('the Demo Membership can\'t be moved by the manual status route, edited, or deleted while billing', async () => {
    const { a } = await elder();
    const s = (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    activate(s.subscription.paypal.subscriptionId);
    await a.get('/api/companion/subscriptions/demo/return').expect(303);
    await a.post(`/api/companion/subscriptions/${s.subscription.id}/status`).set(H).send({ to: 'instructions_opened' }).expect(409);
    await a.patch(`/api/companion/subscriptions/${s.subscription.id}`).set(H).send({ amountCents: 1 }).expect(409);
    await a.delete(`/api/companion/subscriptions/${s.subscription.id}`).expect(409);
    await a.delete('/api/companion/all').set(H).send({ confirm: true }).expect(409);
  });
  it('signed BILLING.SUBSCRIPTION webhooks update status; unverified ones change nothing', async () => {
    const { a, hh } = await elder();
    const s = (await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(201)).body;
    const pid = s.subscription.paypal.subscriptionId;
    const ev = (type: string, status: string, custom = hh) => JSON.stringify({ id: 'WH-' + Math.random().toString(36).slice(2), event_type: type, resource_type: 'subscription', resource: { id: pid, status, custom_id: custom } });
    vi.mocked(client.verifyWebhook).mockResolvedValueOnce(false);
    await request(app).post('/api/paypal/webhook').set('Content-Type', 'application/json').send(ev('BILLING.SUBSCRIPTION.ACTIVATED', 'ACTIVE')).expect(400);
    expect((await a.get('/api/companion/subscriptions').expect(200)).body.subscriptions[0].paypal.status).toBe('APPROVAL_PENDING');
    await request(app).post('/api/paypal/webhook').set('Content-Type', 'application/json').send(ev('BILLING.SUBSCRIPTION.ACTIVATED', 'ACTIVE', 'hh_someone_else')).expect(200);
    expect((await a.get('/api/companion/subscriptions').expect(200)).body.subscriptions[0].paypal.webhookVerified).toBe(false); // custom_id mismatch ignored
    await request(app).post('/api/paypal/webhook').set('Content-Type', 'application/json').send(ev('BILLING.SUBSCRIPTION.ACTIVATED', 'ACTIVE')).expect(200);
    let v = (await a.get('/api/companion/subscriptions').expect(200)).body.subscriptions[0];
    expect(v.paypal).toMatchObject({ status: 'ACTIVE', webhookVerified: true });
    await request(app).post('/api/paypal/webhook').set('Content-Type', 'application/json').send(ev('BILLING.SUBSCRIPTION.CANCELLED', 'CANCELLED')).expect(200);
    v = (await a.get('/api/companion/subscriptions').expect(200)).body.subscriptions[0];
    expect(v).toMatchObject({ status: 'provider_confirmed', confirmedBy: 'paypal_webhook' });
  });
  it('not configured -> 503', async () => {
    const { a } = await elder();
    const old = process.env.PAYPAL_DEMO_PLAN_ID; delete process.env.PAYPAL_DEMO_PLAN_ID;
    try { expect((await a.post('/api/companion/subscriptions/demo/start').set(H).send({}).expect(503)).body.error).toBe('demo_not_configured'); }
    finally { process.env.PAYPAL_DEMO_PLAN_ID = old; }
  });
});
