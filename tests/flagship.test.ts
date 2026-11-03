/**
 * FLAGSHIP JOURNEY — integration suite over HTTP (supertest), fresh isolated households.
 * PayPal is a TEST DOUBLE here (orders/capture/webhook verification mocked, clearly labelled); Channel3 is not called
 * (no key: the real-listing step is checked by scripts/channel3-live-check.mjs and the browser e2e separately).
 * The AI is OFF (no GROQ key): every flagship question must be answered by the rules router.
 * Numbers in test names refer to the 22 items in the flagship brief (see docs/TEST-EVIDENCE.md § Flagship).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

vi.hoisted(() => { process.env.API_LIMIT_PER_MIN = '5000'; process.env.AI_SESSION_LIMIT_PER_MIN = '1000'; process.env.COMPANION_LIMIT_PER_MIN = '5000'; });
const st = vi.hoisted(() => ({ orders: new Map<string, any>(), captureCalls: 0, verify: true }));
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    st.orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return st.orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => JSON.parse(JSON.stringify(st.orders.get(id)))),
  captureOrder: vi.fn(async (id: string) => {
    const o = st.orders.get(id);
    if (o.status === 'COMPLETED' && o.purchase_units[0].payments) return o; // PayPal-Request-Id replay
    st.captureCalls++;
    o.status = 'COMPLETED';
    o.purchase_units[0].payments = { captures: [{ id: 'CAP' + id, status: 'COMPLETED', amount: o.purchase_units[0].amount, create_time: new Date().toISOString() }] };
    return o;
  }),
  getCapture: vi.fn(async () => null),
  refundCapture: vi.fn(), getRefund: vi.fn(),
  verifyWebhook: vi.fn(async () => st.verify),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: (o: any) => o.links[0].href,
  createSubscription: vi.fn(), getSubscription: vi.fn(), cancelSubscription: vi.fn(), subscriptionApproveLink: () => null,
}));

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { routeCompanion } from '../server/companion/router';
import { InsightsSummary } from '../shared/insightsSummary';
import { CompanionCard } from '../shared/companion';
import { parseFollowup } from '../web/src/assistant/followups';
import { conversationPaymentId } from '../web/src/assistant/thread';
import { totalsByCurrency } from '../server/insights/summary';
import { TRAINING_EXAMPLES } from '../shared/demoData';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
beforeAll(() => { process.env.DEMO_SEED = 'on'; });

const ask = async (a: any, text: string) => (await a.post('/api/assistant').set(H).send({ text }).expect(200)).body;
const stateOf = (id: string) => (db.prepare('SELECT state FROM payment_requests WHERE id=?').get(id) as any)?.state;
async function household(withFamily = false) {
  const m = request.agent(app);
  await m.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
  if (!withFamily) return { m, f: null as any };
  const inv = (await m.post('/api/family/invite').set(H).send({}).expect(200)).body;
  const f = request.agent(app);
  await f.post('/api/family/pair').set(H).send({ code: inv.code, name: 'Alex' }).expect(200);
  return { m, f };
}
/** "Let's buy the demo microwave" → purchase card → Allow (the client calls /api/quote then /api/payments). */
async function buyDemoMicrowave(m: any) {
  const r = await ask(m, "Let's buy the demo microwave.");
  expect(r.buyNow).toBe(true);
  const productId = r.products[0].id;
  const q = (await m.post('/api/quote').set(H).send({ items: [{ productId, quantity: 1 }] }).expect(200)).body;
  const created = (await m.post('/api/payments').set(H).send({ items: [{ productId, quantity: 1 }], idempotencyKey: 'k' + Math.random().toString(36).slice(2, 14) }).expect(200)).body;
  return { r, q, id: created.request.id as string, created };
}
async function approveAsAlex(f: any, id: string) {
  const req = (await f.get(`/api/family/requests/${id}`).expect(200)).body;
  return f.post(`/api/family/requests/${id}/decision`).set(H).send({ decision: 'approve', approvalId: req.approval.id });
}
async function payAtPayPal(m: any, id: string) {
  const co = (await m.post(`/api/payments/${id}/checkout`).set(H).send({}).expect(200)).body;
  const orderId = new URL(co.approveUrl).searchParams.get('token')!;
  st.orders.get(orderId).status = 'APPROVED'; // the buyer approved on PayPal's page (simulated)
  return { orderId, confirm: () => m.post(`/api/payments/${id}/confirm`).set(H).send({ orderId }) };
}

describe('flagship: "I received a message saying I owe €120" (rules only, AI off)', () => {
  it('1 searches Mary’s records and returns a possible-match card with every field', async () => {
    const { m } = await household();
    const r = await ask(m, 'I received a message saying I owe €120. Can you check whether I already paid?');
    expect(r.ai).toBe(false);
    expect(r.intent.action).toBe('payment_search');
    const card = CompanionCard.parse(r.companion);
    expect(card.kind).toBe('payment_matches');
    const top = (card as any).result.matches[0];
    expect(top).toMatchObject({ recipient: 'Shannon Boiler Services', amountCents: 12000, currency: 'EUR', description: 'Annual boiler service', source: 'manual', sample: true });
    expect(top.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(top.evidence.kind).toBe('sample');
    expect(top.matchReasons.join(' ')).toMatch(/Same amount/);
  });
  it('2 never invents a match or claims the debt is paid; a matching amount is not proof', async () => {
    const { m } = await household();
    const r = await ask(m, 'I received a message saying I owe €120. Can you check whether I already paid?');
    expect(r.reply).toMatch(/doesn't prove this bill is paid/);
    expect(r.reply).not.toMatch(/you (have )?(already )?paid/i);
    expect(r.companion.result.guidance).toMatch(/not proof/);
    // An amount nobody recorded: no match at all, and still no claim either way.
    const none = await ask(m, 'A text says I owe €133. Did I already pay?');
    expect(none.companion.result.matches).toHaveLength(0);
    expect(none.reply).toMatch(/couldn't find any record of €133/);
    expect(none.reply).toMatch(/doesn't prove you haven't paid/);
  });
  it('3 labels sample vs real PayPal Sandbox honestly', async () => {
    const { m } = await household();
    const r = await ask(m, 'I received a message saying I owe €120. Can you check whether I already paid?');
    for (const x of r.companion.result.matches) { expect(x.sample).toBe(true); expect(x.evidence.kind).toBe('sample'); }
    expect(r.reply).toMatch(/illustrative sample data/);
  });
});

describe('flagship: shopping and the Demo Shop', () => {
  it('5/4 "help me buy a microwave instead": real listings (Channel3) + a SEPARATE Demo Shop offer; Demo Shop fallback without Channel3', async () => {
    expect(routeCompanion('Can you help me buy a microwave instead?')).toBeNull();
    const { m } = await household();
    const saved = process.env.CHANNEL3_API_KEY;
    try {
      process.env.CHANNEL3_API_KEY = 'test-key-not-called';
      const r = await ask(m, 'Can you help me buy a microwave instead?');
      expect(r.ai).toBe(false); // rules: no AI needed for this phrasing
      expect(r.discover).toEqual({ query: 'microwave', suggested: false });
      expect(r.products).toEqual([]); // listings come from /api/discover, never mixed with Demo Shop items
      expect(r.demoOffer.map((p: any) => p.id)).toEqual(['microwave']);
      expect(r.reply).toMatch(/retailer's own website/);
      delete process.env.CHANNEL3_API_KEY;
      const f = await ask(m, 'Can you help me buy a microwave instead?');
      expect(f.discover).toBeNull();
      expect(f.products.map((p: any) => p.id)).toContain('microwave');
    } finally { if (saved === undefined) delete process.env.CHANNEL3_API_KEY; else process.env.CHANNEL3_API_KEY = saved; }
  });
  it('6 "let’s buy the demo microwave": one server-catalogue product, €120.00, family check above €75', async () => {
    const { m } = await household();
    const { r, q } = await buyDemoMicrowave(m);
    expect(r.products).toHaveLength(1);
    expect(r.products[0]).toMatchObject({ id: 'microwave', priceCents: 12000, currency: 'EUR' });
    expect(q).toMatchObject({ totalCents: 12000, currency: 'EUR', needsFamily: true, thresholdCents: 7500 });
  });
  it('6 the client cannot change the price: quote/payment ignore any amount sent', async () => {
    const { m } = await household();
    const q = (await m.post('/api/quote').set(H).send({ items: [{ productId: 'microwave', quantity: 1, unitAmountCents: 100 }], totalCents: 100 }).expect(200)).body;
    expect(q.totalCents).toBe(12000);
  });
});

describe('flagship: family review → PayPal → receipt (PayPal mocked)', () => {
  it('7–19, 21 the whole journey, server-enforced at every step', async () => {
    const { m, f } = await household(true);
    const { id, created } = await buyDemoMicrowave(m);
    // 7 threshold enforced: family review, no PayPal order yet
    expect(stateOf(id)).toBe('FAMILY_APPROVAL_PENDING');
    expect(created.approveUrl ?? null).toBeNull();
    // 12 unapproved purchase cannot check out or capture
    expect((await m.post(`/api/payments/${id}/checkout`).set(H).send({})).status).toBe(409);
    expect((await m.post(`/api/payments/${id}/confirm`).set(H).send({ orderId: 'FAKEORDER12345' })).status).toBe(409);
    // 9 Mary cannot approve her own request (family-only route)
    expect((await m.post(`/api/family/requests/${id}/decision`).set(H).send({ decision: 'approve', approvalId: 'apr_x1234' })).status).toBe(401);
    // 8 Alex sees product, exact amount, requester and expiry
    const view = (await f.get(`/api/family/requests/${id}`).expect(200)).body;
    expect(view).toMatchObject({ amountCents: 12000, currency: 'EUR', state: 'FAMILY_APPROVAL_PENDING' });
    expect(view.items[0].name).toBe('Simple Dial Microwave 20L');
    expect(view.approval.expiresAt).toBeGreaterThan(Date.now());
    // 11 two approve clicks race: one approval, one transition
    const [a1, a2] = await Promise.all([approveAsAlex(f, id), approveAsAlex(f, id)]);
    expect([a1.status, a2.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target=? AND action='approval.approved'").get(id)).toMatchObject({ n: 1 });
    expect(stateOf(id)).toBe('FAMILY_APPROVED');
    // Mary's card refresh = GET by id
    expect((await m.get(`/api/payments/${id}`).expect(200)).body.approval.status).toBe('approved');
    // 13 buyer approval required: PayPal order exists but not approved yet → capture refused
    const co = (await m.post(`/api/payments/${id}/checkout`).set(H).send({}).expect(200)).body;
    const orderId = new URL(co.approveUrl).searchParams.get('token')!;
    expect((await m.post(`/api/payments/${id}/confirm`).set(H).send({ orderId })).status).toBe(409);
    // 14/15 buyer approves → protected capture → authoritative status
    st.orders.get(orderId).status = 'APPROVED';
    const before = st.captureCalls;
    const c1 = (await m.post(`/api/payments/${id}/confirm`).set(H).send({ orderId }).expect(200)).body;
    expect(c1.state).toBe('CAPTURED');
    expect(c1.receipt).toMatchObject({ amount: '120.00', currency: 'EUR', webhookConfirmed: false });
    expect(st.captureCalls).toBe(before + 1);
    // 16 webhook: forged signature refused and not stored; verified one recorded once (17 duplicate ignored)
    st.verify = false;
    const capId = c1.receipt.captureId;
    const ev = { id: `WH-FLAG-${Date.now()}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_type: 'capture', create_time: new Date().toISOString(), resource: { id: capId, status: 'COMPLETED', custom_id: id, amount: { value: '120.00', currency_code: 'EUR' }, supplementary_data: { related_ids: { order_id: orderId } } } };
    expect((await request(app).post('/api/paypal/webhook').set(H).send(JSON.stringify(ev))).status).toBe(400);
    expect(db.prepare('SELECT 1 FROM webhook_events WHERE id=?').get(ev.id)).toBeUndefined();
    st.verify = true;
    await request(app).post('/api/paypal/webhook').set(H).send(JSON.stringify(ev)).expect(200);
    expect((await request(app).post('/api/paypal/webhook').set(H).send(JSON.stringify(ev)).expect(200)).body).toMatchObject({ duplicate: true });
    expect(db.prepare('SELECT COUNT(*) n FROM webhook_events WHERE id=?').get(ev.id)).toMatchObject({ n: 1 });
    // 19 "Did my payment go through?" asked twice + re-reads: same receipt, never a second capture
    for (let i = 0; i < 2; i++) {
      const r = await ask(m, 'Did my payment go through?');
      expect(r.intent.action).toBe('payment_status');
      expect(r.ai).toBe(false);
    }
    for (let i = 0; i < 3; i++) {
      const g = (await m.get(`/api/payments/${id}`).expect(200)).body; // what the receipt card reads (also on reload)
      expect(g).toMatchObject({ state: 'CAPTURED', receipt: { captureId: capId, amount: '120.00', webhookConfirmed: true } });
    }
    await m.get('/api/payments').expect(200); // list (lazy reconcile sweep) never captures either
    expect(st.captureCalls).toBe(before + 1);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target=? AND action LIKE '%->CAPTURED'").get(id)).toMatchObject({ n: 1 });
    // 21 Activity: one row, labelled Real PayPal Sandbox, verified by webhook, apart from the sample microwave
    const act = (await m.get('/api/activity?q=Microwave&limit=20').expect(200)).body.items.filter((i: any) => i.type === 'payment');
    const real = act.filter((i: any) => i.id === id);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ source: 'paypal_sandbox', verification: 'paypal_webhook_verified', example: false });
    expect(act.some((i: any) => i.example && i.source === 'sample')).toBe(true);
    // Insights after the journey: €120.00 sandbox paid, sample €120 counted separately (never €240)
    const s = InsightsSummary.parse((await m.get('/api/insights/summary').expect(200)).body);
    expect(s.payments.sandbox.captured).toEqual({ count: 1, totals: [{ currency: 'EUR', cents: 12000 }] });
    expect(s.payments.sandbox.webhookVerified).toBe(1);
    expect(s.payments.sample.captured.totals).toEqual([{ currency: 'EUR', cents: 12000 + 3200 }]); // kettle €32 + microwave €120 samples
  });
  it('10 declined and expired approvals cannot proceed', async () => {
    const { m, f } = await household(true);
    const d = await buyDemoMicrowave(m);
    const req = (await f.get(`/api/family/requests/${d.id}`).expect(200)).body;
    await f.post(`/api/family/requests/${d.id}/decision`).set(H).send({ decision: 'decline', approvalId: req.approval.id }).expect(200);
    expect(stateOf(d.id)).toBe('CANCELLED');
    expect((await m.post(`/api/payments/${d.id}/checkout`).set(H).send({})).status).toBe(409);
    const e = await buyDemoMicrowave(m);
    db.prepare('UPDATE approvals SET expires_at=? WHERE request_id=?').run(Date.now() - 1000, e.id);
    expect((await approveAsAlex(f, e.id)).status).toBe(410);
    expect((await m.post(`/api/payments/${e.id}/checkout`).set(H).send({})).status).toBe(409);
  });
  it('8 an approval authorises only its own purchase', async () => {
    const { m, f } = await household(true);
    const a = await buyDemoMicrowave(m);
    const b = await buyDemoMicrowave(m);
    const ra = (await f.get(`/api/family/requests/${a.id}`).expect(200)).body;
    // Using A's approval id on B is refused; B stays pending.
    expect((await f.post(`/api/family/requests/${b.id}/decision`).set(H).send({ decision: 'approve', approvalId: ra.approval.id })).status).toBeGreaterThanOrEqual(400);
    expect(stateOf(b.id)).toBe('FAMILY_APPROVAL_PENDING');
  });
  it('20 transaction isolation between households (read, decide, confirm, insights)', async () => {
    const A = await household(); const B = await household(true);
    const { id } = await buyDemoMicrowave(A.m);
    await B.m.get(`/api/payments/${id}`).expect(404);
    expect((await B.m.post(`/api/payments/${id}/confirm`).set(H).send({ orderId: 'FAKEORDER12345' })).status).toBe(404);
    expect((await B.f.get(`/api/family/requests/${id}`)).status).toBe(404);
    const sb = (await B.m.get('/api/insights/summary').expect(200)).body;
    expect(JSON.stringify(sb)).not.toContain(id);
    expect(sb.pendingReviews.real).toHaveLength(0);
    const sa = (await A.m.get('/api/insights/summary').expect(200)).body;
    expect(sa.pendingReviews.real.map((x: any) => x.id)).toEqual([id]);
  });
});

describe('payment-status routing (hosted d630e97 finding: it went to the scam checker / a list)', () => {
  it.each(['Did my payment go through?', 'did it go through', 'Has the payment gone through?', 'Is my payment complete?', 'Did my purchase work?'])('rules router: %s → payment_status', (t) => {
    expect(routeCompanion(t)?.action).toBe('payment_status');
    expect(parseFollowup(t, false).kind).toBe('payment_status');
  });
  it.each(['Did I already pay John €80?', 'Did I pay the plumber?', 'I received a message saying I owe €120. Can you check whether I already paid?', 'Show my last payment'])('not a status question: %s', (t) => {
    expect(routeCompanion(t)?.action).not.toBe('payment_status');
    expect(parseFollowup(t, false).kind).not.toBe('payment_status');
  });
  it('picks the purchase this conversation is about, never a sample', () => {
    const t: any = { v: 1, mode: 'chat', focusId: null, messages: [
      { id: '1', role: 'assistant', text: '', blocks: [{ kind: 'family_status', requestId: 'pay_REALONE1234' }] },
      { id: '2', role: 'assistant', text: '', blocks: [{ kind: 'receipt', requestId: 'pay_smpSAMPLE1234' }] },
    ] };
    expect(conversationPaymentId(t)).toBe('pay_REALONE1234');
    expect(conversationPaymentId({ ...t, messages: [] })).toBeNull();
  });
});

describe('Insights: calculations, roles, privacy', () => {
  it('routes the six natural-language requests without AI', () => {
    expect(routeCompanion('Show my spending.')).toMatchObject({ action: 'insights', insight_focus: 'spending' });
    expect(routeCompanion('What subscriptions am I paying for?')).toMatchObject({ action: 'subscription_list', focus: 'all' });
    expect(routeCompanion("What's coming out next?")).toMatchObject({ action: 'subscription_list', focus: 'next' });
    expect(routeCompanion('Do I have anything waiting for approval?')).toMatchObject({ action: 'insights', insight_focus: 'pending' });
    expect(routeCompanion('Have I paid the same person twice?')).toMatchObject({ action: 'insights', insight_focus: 'duplicates' });
    expect(routeCompanion('Show my safety insights.')).toMatchObject({ action: 'insights', insight_focus: 'safety' });
    expect(routeCompanion('Did I pay John twice?')?.action).toBe('payment_search'); // a named person stays a record search
  });
  it('subscriptions: monthly = yearly ÷ 12, annual = monthly × 12; sample and user-entered never added together', async () => {
    const { m } = await household();
    await m.post('/api/companion/subscriptions').set(H).send({ merchant: 'Local Paper', amountCents: 12000, currency: 'EUR', frequency: 'yearly' }).expect(201);
    await m.post('/api/companion/subscriptions').set(H).send({ merchant: 'Gym', amountCents: 2500, currency: 'EUR', frequency: 'monthly' }).expect(201);
    await m.post('/api/companion/subscriptions').set(H).send({ merchant: 'UK Radio', amountCents: 500, currency: 'GBP', frequency: 'weekly' }).expect(201);
    const s = InsightsSummary.parse((await m.get('/api/insights/summary').expect(200)).body);
    // user-entered: EUR 120/12 + 25 = €35.00/month, €420/year; GBP 5×52 = £260/year, £21.67/month (each currency apart)
    expect(s.subscriptions!.userEntered.monthly).toEqual([{ currency: 'EUR', cents: 3500 }, { currency: 'GBP', cents: 2167 }]);
    expect(s.subscriptions!.userEntered.annual).toEqual([{ currency: 'EUR', cents: 42000 }, { currency: 'GBP', cents: 26000 }]);
    // sample: 12.99 + 11.99 + 9.99 + 95/12 = €42.89/month; 155.88+143.88+119.88+95 = €514.64/year
    expect(s.subscriptions!.sample).toEqual({ count: 4, monthly: [{ currency: 'EUR', cents: 4289 }], annual: [{ currency: 'EUR', cents: 51464 }] });
  });
  it('duplicates reuse the John €80 classifier; separate payments are not flagged', async () => {
    const { m } = await household();
    const s = InsightsSummary.parse((await m.get('/api/insights/summary').expect(200)).body);
    expect(s.duplicates).toHaveLength(1);
    expect(s.duplicates![0]).toMatchObject({ kind: 'possible_duplicate', recipient: 'John Smith', amountCents: 8000, daysApart: 2, sample: true });
    const r = await ask(m, 'Have I paid the same person twice?');
    expect(r.companion.kind).toBe('insights_summary');
    expect(r.reply).toMatch(/€80 to John Smith, 2 days apart \(sample data\)/);
  });
  it('records: user-entered and sample totalled apart, per currency', async () => {
    const { m } = await household();
    await m.post('/api/companion/payments').set(H).send({ recipient: 'Dentist', amountCents: 6000, currency: 'EUR', paidOn: '2026-10-01', method: 'card' }).expect(201);
    const s = InsightsSummary.parse((await m.get('/api/insights/summary').expect(200)).body);
    expect(s.records!.userEntered).toEqual({ count: 1, totals: [{ currency: 'EUR', cents: 6000 }] });
    expect(s.records!.sample.count).toBe(6);
    expect(s.records!.sample.totals).toEqual([{ currency: 'EUR', cents: 8000 + 8000 + 8900 + 4000 + 1850 + 12000 }]);
    expect(totalsByCurrency([{ amountCents: 100, currency: 'GBP' }, { amountCents: 250, currency: 'EUR' }, { amountCents: 50, currency: 'GBP' }])).toEqual([{ currency: 'EUR', cents: 250 }, { currency: 'GBP', cents: 150 }]);
  });
  it('scam checks: training examples are counted apart, never as incidents', async () => {
    const { m } = await household();
    await m.post('/api/scan').set(H).send({ text: TRAINING_EXAMPLES[0].text }).expect(200);
    await m.post('/api/scan').set(H).send({ text: 'URGENT: your PayPal is locked. Call +44 20 7946 0999 now and read us the code we text you.' }).expect(200);
    const s = InsightsSummary.parse((await m.get('/api/insights/summary').expect(200)).body);
    expect(s.scamChecks.training).toBe(1);
    expect(s.scamChecks.real.total).toBe(1);
    const act = (await m.get('/api/activity?type=scan').expect(200)).body.items;
    expect(act.filter((i: any) => i.example).length).toBe(1);
  });
  it('pending: sample requests are never "waiting"; only real ones, with expiry', async () => {
    const { m } = await household();
    let s = InsightsSummary.parse((await m.get('/api/insights/summary').expect(200)).body);
    expect(s.pendingReviews.real).toHaveLength(0);
    expect(s.pendingReviews.sampleWaiting).toBe(1);
    const { id } = await buyDemoMicrowave(m);
    s = InsightsSummary.parse((await m.get('/api/insights/summary').expect(200)).body);
    expect(s.pendingReviews.real).toEqual([expect.objectContaining({ id, amountCents: 12000, currency: 'EUR', item: 'Simple Dial Microwave 20L' })]);
  });
  it('Alex (family) gets no private records, subscriptions, duplicates or unshared checks', async () => {
    const { m, f } = await household(true);
    await m.post('/api/scan').set(H).send({ text: 'Your parcel is held, pay €2 at http://parcel-fee.example.top now' }).expect(200);
    const s = InsightsSummary.parse((await f.get('/api/insights/summary?as=family').expect(200)).body);
    expect(s.role).toBe('family');
    expect(s.privateRecordsVisible).toBe(false);
    expect(s.records).toBeNull(); expect(s.subscriptions).toBeNull(); expect(s.duplicates).toBeNull();
    expect(s.scamChecks.scope).toBe('shared');
    expect(s.scamChecks.real.total).toBe(0);
    expect(JSON.stringify(s)).not.toMatch(/John Smith|Shannon Boiler|Netflix/);
    // Family insights stay gated by the session: no session → 401
    await request(app).get('/api/insights/summary').expect(401);
  });
  it('FEATURE_INSIGHTS=off hides the summary endpoint', async () => {
    const { m } = await household();
    process.env.FEATURE_INSIGHTS = 'off';
    try { await m.get('/api/insights/summary').expect(404); } finally { delete process.env.FEATURE_INSIGHTS; }
  });
  it('AG Studio stays off publicly: the server never advertises it by default', async () => {
    const c = (await request(app).get('/api/config').expect(200)).body;
    expect(c.insightsDashboard).toBe('native');
  });
});

describe('what Mary can shop (server catalogue, never a blank result)', () => {
  it('an unmatched request says so and lists the Demo Shop catalogue', async () => {
    const { m } = await household();
    const saved = process.env.CHANNEL3_API_KEY; delete process.env.CHANNEL3_API_KEY;
    try {
      const r = await ask(m, 'I want to buy a garden hose');
      expect(r.products).toEqual([]);
      expect(r.reply).toMatch(/^I can't find that in the Demo Shop\. You can buy: /);
      expect(r.catalogue.length).toBeGreaterThanOrEqual(10);
      expect(r.catalogue.find((c: any) => c.productId === 'microwave')).toMatchObject({ name: 'Simple Dial Microwave 20L', priceCents: 12000, currency: 'EUR' });
    } finally { if (saved !== undefined) process.env.CHANNEL3_API_KEY = saved; }
  });
  it('with Channel3 available it also searches real shops (and still lists the catalogue)', async () => {
    const { m } = await household();
    const saved = process.env.CHANNEL3_API_KEY; process.env.CHANNEL3_API_KEY = 'test-key-not-called';
    try {
      const r = await ask(m, 'I want to buy a garden hose');
      expect(r.catalogue.length).toBeGreaterThan(0);
      expect(r.discover).toMatchObject({ suggested: true });
      expect(r.reply).toMatch(/Channel3/);
    } finally { if (saved === undefined) delete process.env.CHANNEL3_API_KEY; else process.env.CHANNEL3_API_KEY = saved; }
  });
  it('a catalogue chip ("Let’s buy the demo <full name>") opens that exact product’s purchase card', async () => {
    const { m } = await household();
    const r = await ask(m, "Let's buy the demo Easy-Pour Electric Kettle 1.5L");
    expect(r.buyNow).toBe(true);
    expect(r.products[0]).toMatchObject({ id: 'kettle-classic', priceCents: 3200 });
  });
});

describe('family dashboard counts (live finding: sample request shown as "waiting for you")', () => {
  it('sample requests are never "waiting for you" and sample decisions are not counted', async () => {
    const { f } = await household(true);
    const d = (await f.get('/api/family/insights').expect(200)).body;
    expect(d.kpis.pendingApprovals).toBe(0);
    expect(d.kpis.approved).toBe(0);
    expect(d.kpis.declined).toBe(0);
    expect(d.payments.some((p: any) => p.source === 'seeded' && p.state === 'FAMILY_APPROVAL_PENDING')).toBe(true); // still listed, labelled
    expect(d.kpis.seededCaptured.count).toBe(2);
    expect(d.kpis.sandboxCaptured.count).toBe(0);
  });
  it('scam reviews count only checks Mary shared, never training examples', async () => {
    const { m, f } = await household(true);
    const t = (await m.post('/api/scan').set(H).send({ text: TRAINING_EXAMPLES[0].text }).expect(200)).body;
    const r = (await m.post('/api/scan').set(H).send({ text: 'URGENT: your PayPal is locked. Call +44 20 7946 0999 now and read us the code we text you.' }).expect(200)).body;
    let d = (await f.get('/api/family/insights').expect(200)).body;
    expect(d.kpis.scamReviews).toBe(0); // nothing shared yet: private to Mary
    await m.post(`/api/scan/${t.scanId}/share`).set(H).send({}).expect(200);
    await m.post(`/api/scan/${r.scanId}/share`).set(H).send({}).expect(200);
    d = (await f.get('/api/family/insights').expect(200)).body;
    expect(d.kpis.scamReviews).toBe(1); // the shared real check; the shared training example is practice
  });
});

describe('desktop header stays visible on normal heights', () => {
  it('the short-viewport rule only applies below 26rem (416 CSS px)', async () => {
    const css = (await import('node:fs')).readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media \(max-height: 26rem\) \{\s*header\.sticky \{ position: static; \}/);
    expect(css).not.toMatch(/max-height: 30rem/);
  });
});

describe('"What can I buy?" and the judges’ PayPal login note', () => {
  it('"What can I buy?" lists the server catalogue without AI', async () => {
    const { m } = await household();
    const r = await ask(m, 'What can I buy?');
    expect(r.ai).toBe(false);
    expect(r.catalogue.map((c: any) => c.productId)).toContain('microwave');
    expect(r.reply).toMatch(/Demo Shop sells/);
  });
  it('no PayPal credentials anywhere in the app source; the judge note points to Devpost', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const src = ['server', 'shared', 'web/src'].flatMap((d) => walk(path.resolve(d))).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(src).not.toMatch(/sb-[a-z0-9]{6,}@personal\.example\.com/i);
    expect(src).not.toMatch(/business\.example\.com/i);
    expect(src).toMatch(/test buyer login is in the Devpost testing instructions/);
  });
});
