/**
 * "Try as Mary" sample data: seeded per visitor, deterministic, isolated, labelled, and never actionable.
 * Also: the Assistant answers the brief's phrasings from that data with AI unavailable (rules only), and a failed
 * query is an error (HTTP 5xx), never "no records". PayPal is a TEST DOUBLE here.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

vi.hoisted(() => { process.env.API_LIMIT_PER_MIN = '5000'; process.env.AI_SESSION_LIMIT_PER_MIN = '1000'; process.env.COMPANION_LIMIT_PER_MIN = '5000'; });

const orders = new Map<string, any>();
const paypalCalls: string[] = [];
vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true,
  createOrder: vi.fn(async (a: any) => {
    paypalCalls.push(`create:${a.requestId}`);
    const id = 'ORDER' + Math.random().toString(36).slice(2, 12).toUpperCase();
    const total = a.items.reduce((s: number, i: any) => s + i.unitAmountCents * i.quantity, 0);
    orders.set(id, { id, status: 'CREATED', purchase_units: [{ custom_id: a.requestId, amount: { currency_code: a.currency, value: (total / 100).toFixed(2) } }], links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    return orders.get(id);
  }),
  getOrder: vi.fn(async (id: string) => { paypalCalls.push(`get:${id}`); return orders.get(id); }),
  captureOrder: vi.fn(async (id: string) => { paypalCalls.push(`capture:${id}`); return orders.get(id); }),
  getCapture: vi.fn(async () => { paypalCalls.push('getCapture'); return null; }),
  refundCapture: vi.fn(async () => { paypalCalls.push('refund'); return { status: 'COMPLETED' }; }),
  getRefund: vi.fn(), verifyWebhook: vi.fn(async () => true), isUnknownOutcome: () => false, approveLink: (o: any) => o.links[0].href,
  createSubscription: vi.fn(), getSubscription: vi.fn(), cancelSubscription: vi.fn(), subscriptionApproveLink: () => null,
}));

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { seedDemoHousehold, sampleId } from '../server/demo/seed';
import { transition, PaymentError } from '../server/payments/service';
import { routeCompanion } from '../server/companion/router';
import { migrateSchema } from '../server/db/schema';
import { openDatabase } from '../server/db/driver';
import { SAMPLE_CONTACTS, SAMPLE_RECORDS, SAMPLE_SHOP, SAMPLE_SUBS, TRAINING_EXAMPLES, WELCOME_PROMPTS } from '../shared/demoData';
import { CompanionCard, PAYPAL_SEND_MONEY_URL } from '../shared/companion';
import { scanMessage } from '../server/scam/guardian';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
beforeAll(() => { process.env.DEMO_SEED = 'on'; });

async function mary() { const a = request.agent(app); const r = await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200); return { a, seeded: r.body.seeded }; }
const hhOf = (agent: any) => agent.get('/api/activity?limit=50').then((r: any) => r.body.items.find((i: any) => i.type === 'payment')?.id).then((id: string) => (db.prepare('SELECT household_id h FROM payment_requests WHERE id=?').get(id) as any).h as string);
const ask = async (a: any, text: string) => (await a.post('/api/assistant').set(H).send({ text }).expect(200)).body;

describe('seed on Try as Mary', () => {
  it('every new visitor gets the full labelled sample set, stored in the database', async () => {
    const { a, seeded } = await mary();
    expect(seeded).toEqual({ transactions: SAMPLE_SHOP.length, records: SAMPLE_RECORDS.length, subscriptions: SAMPLE_SUBS.length, contacts: SAMPLE_CONTACTS.length, familyReviews: 4 });
    const act = (await a.get('/api/activity?limit=50').expect(200)).body;
    expect(act.total).toBeGreaterThanOrEqual(8);
    const samples = act.items.filter((i: any) => i.example);
    expect(samples.length).toBe(SAMPLE_SHOP.length + SAMPLE_RECORDS.length);
    for (const i of samples) { expect(i.sourceLabel).toBe('Sample data'); expect(i.evidence).toBe('Illustrative — no PayPal record'); }
    const states = new Set(samples.filter((i: any) => i.type === 'payment').map((i: any) => i.state));
    for (const s of ['CAPTURED', 'PAYER_APPROVAL_PENDING', 'CANCELLED', 'CAPTURE_PENDING', 'REFUNDED', 'FAMILY_APPROVAL_PENDING']) expect(states.has(s)).toBe(true);
    const approvals = samples.filter((i: any) => i.approval).map((i: any) => i.approval.status).sort();
    expect(approvals).toEqual(['approved', 'declined', 'expired', 'pending']);
    // Dates spread over the last ~60 days.
    const ages = samples.map((i: any) => (Date.now() - Date.parse(i.at)) / 86_400_000);
    expect(Math.max(...ages)).toBeGreaterThan(40); expect(Math.max(...ages)).toBeLessThan(61);
    // No PayPal ids, no webhook events, for any sample row.
    const hh = await hhOf(a);
    expect(db.prepare('SELECT COUNT(*) n FROM payment_requests WHERE household_id=? AND example=1 AND (paypal_order_id IS NOT NULL OR paypal_capture_id IS NOT NULL)').get(hh)).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM refunds WHERE household_id=?').get(hh)).toMatchObject({ n: 0 });
  });

  it('is deterministic: same household -> same ids and content; another household -> same content, different ids', async () => {
    const { a } = await mary(); const { a: b } = await mary();
    const ha = await hhOf(a); const hb = await hhOf(b);
    const owner = (h: string) => (db.prepare('SELECT elder_id e FROM households WHERE id=?').get(h) as any).e;
    const now = new Date('2026-11-03T12:00:00Z');
    seedDemoHousehold(ha, owner(ha), now); seedDemoHousehold(hb, owner(hb), now);
    const dump = (h: string) => ({
      pay: db.prepare('SELECT state, items_json, amount_cents, created_at FROM payment_requests WHERE household_id=? AND example=1 ORDER BY created_at, amount_cents').all(h),
      rec: db.prepare('SELECT recipient, amount_cents, paid_on, pay_method, memo FROM companion_payments WHERE household_id=? AND example=1 ORDER BY paid_on, recipient').all(h),
      sub: db.prepare('SELECT merchant, amount_cents, billing_cycle, next_on FROM companion_subscriptions WHERE household_id=? AND example=1 ORDER BY merchant').all(h),
      ctc: db.prepare('SELECT display_name, relation, phone, email FROM companion_contacts WHERE household_id=? AND example=1 ORDER BY display_name').all(h),
    });
    expect(dump(ha)).toEqual(dump(hb));
    const idsA = (db.prepare('SELECT id FROM payment_requests WHERE household_id=? AND example=1 ORDER BY id').all(ha) as any[]).map((r) => r.id);
    seedDemoHousehold(ha, owner(ha), now); // reset
    expect((db.prepare('SELECT id FROM payment_requests WHERE household_id=? AND example=1 ORDER BY id').all(ha) as any[]).map((r) => r.id)).toEqual(idsA);
    expect(idsA).toContain(sampleId('pay', ha, 'kettle'));
    expect(sampleId('pay', ha, 'kettle')).not.toBe(sampleId('pay', hb, 'kettle'));
    // Contacts are non-routable: Ofcom drama ranges and example.com.
    for (const c of dump(ha).ctc as any[]) { expect(c.phone).toMatch(/^\+44 (7700 900\d{3}|20 7946 0\d{3})$/); if (c.email) expect(c.email).toMatch(/example\.com$/); }
  });

  it('reset replaces sample rows only; records the visitor typed are kept', async () => {
    const { a } = await mary();
    await a.post('/api/companion/payments').set(H).send({ recipient: 'Window cleaner', amountCents: 2500, currency: 'EUR', paidOn: '2026-10-30', method: 'cash' }).expect(201);
    const subs = (await a.get('/api/companion/subscriptions').expect(200)).body.subscriptions;
    const netflix = subs.find((s: any) => s.merchant === 'Netflix');
    await a.post(`/api/companion/subscriptions/${netflix.id}/status`).set(H).send({ to: 'instructions_opened' }).expect(200);
    await a.post('/api/demo/reset').set(H).send({}).expect(200);
    const after = (await a.get('/api/companion/subscriptions').expect(200)).body.subscriptions;
    expect(after.find((s: any) => s.merchant === 'Netflix').status).toBe('tracking');
    const recs = (await a.get('/api/companion/payments').expect(200)).body.payments;
    expect(recs.some((p: any) => p.recipient === 'Window cleaner' && !p.sample)).toBe(true);
    expect(recs.filter((p: any) => p.sample).length).toBe(SAMPLE_RECORDS.length);
  });
});

describe('isolation between visitors', () => {
  it('visitor A never sees or touches visitor B\'s sample or private data', async () => {
    const { a } = await mary(); const { a: b } = await mary();
    const aIds = new Set([
      ...(await a.get('/api/activity?limit=50')).body.items.map((i: any) => i.id),
      ...(await a.get('/api/companion/contacts')).body.contacts.map((c: any) => c.id),
      ...(await a.get('/api/companion/subscriptions')).body.subscriptions.map((s: any) => s.id),
    ]);
    const bItems = [
      ...(await b.get('/api/activity?limit=50')).body.items, ...(await b.get('/api/companion/contacts')).body.contacts, ...(await b.get('/api/companion/subscriptions')).body.subscriptions,
    ];
    expect(bItems.length).toBeGreaterThan(10);
    for (const x of bItems) expect(aIds.has(x.id)).toBe(false);
    const bPay = (await b.get('/api/activity?limit=50')).body.items.find((i: any) => i.type === 'payment');
    const bCtc = (await b.get('/api/companion/contacts')).body.contacts[0];
    await a.get(`/api/payments/${bPay.id}`).expect(404);
    await a.get(`/api/companion/contacts/${bCtc.id}`).expect(404);
    await a.delete(`/api/companion/contacts/${bCtc.id}`).set(H).expect(404);
    // Family of A sees A's household only, and never A's private records.
    await a.post('/api/demo/alex').set(H).send({}).expect(200);
    const famAct = (await a.get('/api/activity?as=family&limit=50').expect(200)).body;
    expect(famAct.role).toBe('family');
    expect(famAct.items.some((i: any) => i.type === 'record')).toBe(false);
    for (const i of famAct.items) expect(aIds.has(i.id)).toBe(true);
  });
});

describe('sample rows are never actionable', () => {
  it('checkout, confirm, cancel, finish, reconcile, refund request and family decisions are refused (409) and PayPal is never called', async () => {
    const { a } = await mary();
    const hh = await hhOf(a);
    const id = (k: string) => sampleId('pay', hh, k);
    paypalCalls.length = 0;
    const no = async (p: any) => { const r = await p; expect(r.status).toBe(409); expect(r.body.error).toBe('sample_not_actionable'); };
    await no(a.post(`/api/payments/${id('radio')}/checkout`).set(H).send({}));
    await no(a.post(`/api/payments/${id('radio')}/confirm`).set(H).send({ orderId: 'ORDERABCDEFGHIJ' }));
    await no(a.post(`/api/payments/${id('radio')}/cancel`).set(H).send({}));
    await no(a.post(`/api/payments/${id('lamp')}/finish`).set(H).send({}));
    await no(a.post(`/api/payments/${id('lamp')}/reconcile`).set(H).send({}));
    await no(a.post(`/api/payments/${id('kettle')}/refund-request`).set(H).send({ reason: 'x' }));
    const view = (await a.get(`/api/payments/${id('kettle')}`).expect(200)).body;
    expect(view.sample).toEqual({ label: 'Sample data', evidence: 'Illustrative — no PayPal record' });
    expect(view.receipt).toBeNull();
    expect(view.refund?.canRequest ?? false).toBe(false);
    // Alex can't approve a sample pending review either.
    await a.post('/api/demo/alex').set(H).send({}).expect(200);
    const pend = (await a.get(`/api/payments/${id('throw')}`).expect(200)).body;
    await no(a.post(`/api/family/requests/${id('throw')}/decision`).set(H).send({ decision: 'approve', approvalId: pend.approval.id }));
    expect(paypalCalls).toEqual([]);
    expect(() => transition(db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id('radio')), 'CANCELLED', 'test')).toThrow(PaymentError);
  });

  it('Try as Alex too: Alex approves a REAL request; Mary can never approve her own', async () => {
    const { a } = await mary();
    const r = (await a.post('/api/payments').set(H).send({ items: [{ productId: 'microwave', quantity: 1 }], idempotencyKey: 'k' + Math.random().toString(36).slice(2, 14) }).expect(200)).body.request;
    expect(r.state).toBe('FAMILY_APPROVAL_PENDING');
    // Mary (elder session only) cannot decide.
    const m2 = request.agent(app); // a separate browser with only an elder cookie for another household
    await m2.post('/api/demo/start').set(H).send({}).expect(200);
    await m2.post(`/api/family/requests/${r.id}/decision`).set(H).send({ decision: 'approve', approvalId: r.approval.id }).expect(401);
    const elderOnly = request.agent(app); await elderOnly.post('/api/demo/start').set(H).send({}).expect(200);
    // Mary's own browser before pairing: no family cookie -> 401.
    await a.post(`/api/family/requests/${r.id}/decision`).set(H).send({ decision: 'approve', approvalId: r.approval.id }).expect(401);
    await a.post('/api/demo/alex').set(H).send({}).expect(200);
    const again = (await a.post('/api/demo/alex').set(H).send({}).expect(200)).body;
    expect(again.reused).toBe(true);
    const out = (await a.post(`/api/family/requests/${r.id}/decision`).set(H).send({ decision: 'approve', approvalId: r.approval.id }).expect(200)).body;
    expect(out.state).toBe('FAMILY_APPROVED');
    expect(out.sample).toBeNull();
    // Family can't use the elder-only demo routes.
    const fam = request.agent(app);
    await fam.post('/api/demo/alex').set(H).send({}).expect(401);
  });
});

describe('Assistant answers from the data (AI unavailable: rules only), typed and spoken use the same endpoint', () => {
  it('every brief phrasing returns the right card, with sample labels and no fabricated claims', async () => {
    const { a } = await mary();
    const t = async (text: string, kind: string) => { const r = await ask(a, text); expect(r.companion?.kind, text).toBe(kind); expect(CompanionCard.safeParse(r.companion).success, text).toBe(true); expect(r.reply.replace(/Nothing is sent by SaySafe/g, '')).not.toMatch(/\b(sent|marked as paid|cancelled for you)\b/i); return r; };
    const last = await t('Show my last payment', 'last_payment');
    expect(last.companion.payment.sample).toBe(true); expect(last.companion.guidance).toMatch(/Sample data/);
    const mw = await t('Did I already pay for the microwave?', 'payment_matches');
    expect(mw.companion.result.matches.map((m: any) => m.recipient).sort()).toEqual(['Currys', 'SaySafe Demo Shop']);
    expect(mw.companion.result.notes.join(' ')).toMatch(/separate purchases/);
    const john = await t('Did I already pay John €80?', 'payment_matches');
    expect(john.companion.result.matches).toHaveLength(2);
    expect(john.companion.result.matches.flatMap((m: any) => m.caveats).join(' ')).toMatch(/Possible duplicate/);
    expect(john.companion.result.matches.every((m: any) => m.recipient === 'John Smith')).toBe(true); // never a Demo Shop payment for a person
    const subs = await t('Show my subscriptions', 'subscriptions_list');
    expect(subs.companion.subscriptions.map((s: any) => s.merchant)).toEqual(['Netflix', 'Spotify Premium', 'The Irish Times digital', 'Amazon Prime']);
    expect(subs.companion.subscriptions.every((s: any) => s.sample && s.managementMethod)).toBe(true);
    expect(subs.companion.demoOffer).toBe(true);
    const most = await t('Which costs the most?', 'subscriptions_list');
    expect(most.reply).toMatch(/Netflix costs the most/); expect(most.reply).toMatch(/Amazon Prime/);
    const next = await t("What's coming out next?", 'subscriptions_list');
    expect(next.reply).toMatch(/Next to come out is Netflix/);
    const cancel = await t('Cancel my streaming subscription', 'subscription_help');
    expect(cancel.companion.subscription.merchant).toBe('Netflix');
    expect(cancel.companion.guide.url).toBe('https://help.netflix.com/en/node/407');
    expect(cancel.reply).toMatch(/can't cancel/);
    const demoM = await t('Cancel my demo membership', 'subscriptions_list');
    expect(demoM.reply).toMatch(/nothing to cancel/);
    const alex = await t('Find Alex', 'contact_card');
    expect(alex.companion.contacts.map((c: any) => c.name)).toEqual(['Alex Byrne']);
    expect((await t('Find Alex in my contacts', 'contact_card')).companion.contacts).toHaveLength(1);
    expect((await t('Show my contacts', 'contact_card')).companion.contacts).toHaveLength(5);
    const gardener = await t('Who is my gardener?', 'contact_card');
    expect(gardener.companion.contacts[0].name).toBe('Pat Doyle'); expect(gardener.reply).toMatch(/Your gardener is Pat Doyle/);
    const daughter = await t('I want to pay my daughter', 'send_money');
    expect(daughter.companion.contacts[0].name).toBe('Sarah'); expect(daughter.companion.amountCents).toBeNull();
    const send = await t('Send Alex €50', 'send_money');
    expect(send.companion).toMatchObject({ amountCents: 5000, currency: 'EUR', paypalSendUrl: PAYPAL_SEND_MONEY_URL });
    expect(send.companion.contacts[0].name).toBe('Alex Byrne');
    expect(send.reply).toMatch(/Nothing is sent by SaySafe/); expect(send.reply).not.toMatch(/€50 sent/);
    const nobody = await t('Send Bartholomew €20', 'send_money');
    expect(nobody.companion.contacts).toEqual([]);
    // Demo item prompt lists real Demo Shop products.
    const buy = await ask(a, 'Help me buy a demo item');
    expect(buy.products.length).toBe(3);
  });

  it('welcome prompts all route somewhere useful', () => {
    expect(routeCompanion(WELCOME_PROMPTS[1])?.action).toBe('last_payment');
    expect(routeCompanion(WELCOME_PROMPTS[2])?.action).toBe('payment_search');
    expect(routeCompanion(WELCOME_PROMPTS[3])?.action).toBe('subscription_list');
    expect(routeCompanion(WELCOME_PROMPTS[4])).toMatchObject({ action: 'contact_lookup', contact_name: 'Alex' });
    expect(routeCompanion('find a kettle')).toBeNull();
    expect(routeCompanion('Check this suspicious message')).toBeNull();
  });

  it('a failing query is a 5xx error, never "no records"', async () => {
    const { a } = await mary();
    db.exec('ALTER TABLE companion_contacts RENAME TO companion_contacts_off');
    try {
      const r = await a.post('/api/assistant').set(H).send({ text: 'Show my contacts' });
      expect(r.status).toBe(500);
      expect(r.body.companion).toBeUndefined();
      expect(JSON.stringify(r.body)).not.toMatch(/no (saved )?contact|haven't saved/i);
      const g = await a.get('/api/companion/contacts');
      expect(g.status).toBe(500);
    } finally { db.exec('ALTER TABLE companion_contacts_off RENAME TO companion_contacts'); }
    expect((await ask(a, 'Show my contacts')).companion.contacts).toHaveLength(5);
  });
});

describe('training examples', () => {
  it('fake invoice -> suspicious; "Hi Mum" -> contact mismatch with Sarah; order notice -> no obvious warning signs', async () => {
    const contacts = SAMPLE_CONTACTS.map((c) => ({ name: c.name, relation: c.relation, phone: c.phone, email: c.email }));
    const [inv, mum, order] = await Promise.all(TRAINING_EXAMPLES.map((t) => scanMessage(t.text, { userName: 'Mary', contacts })));
    expect(inv.verdict).toBe('suspicious');
    expect(mum.signals.some((s: any) => s.code === 'contact_mismatch')).toBe(true);
    expect(order.verdict).toBe('no_obvious_warning_signs');
  });
});

describe('schema migration', () => {
  it('adds the example column to an existing pre-demo table without losing rows', () => {
    const d = openDatabase({ mode: 'local', file: ':memory:', syncPeriodSeconds: 0 });
    d.exec("CREATE TABLE payment_requests (id TEXT PRIMARY KEY, household_id TEXT); INSERT INTO payment_requests VALUES ('pay_old1','hh'); CREATE TABLE companion_payments (id TEXT PRIMARY KEY); CREATE TABLE companion_subscriptions (id TEXT PRIMARY KEY); CREATE TABLE companion_contacts (id TEXT PRIMARY KEY);");
    migrateSchema(d); migrateSchema(d); // idempotent
    expect(d.prepare("SELECT example FROM payment_requests WHERE id='pay_old1'").get()).toEqual({ example: 0 });
  });
});

describe('small fixes', () => {
  it('"Compare real shops for X" searches for X, not for "compare"', async () => {
    const { parseRequest } = await import('../shared/shopping');
    const { parseFollowup } = await import('../web/src/assistant/followups');
    expect(parseRequest('Compare real shops for a toaster').productQuery).toBe('toaster');
    expect(parseFollowup('Compare real shops for a toaster', true).kind).not.toBe('compare');
    expect(parseFollowup('compare them', true).kind).toBe('compare');
  });
});
