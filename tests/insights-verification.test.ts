/**
 * Insights verification (local, rules only): Mary's GET /api/insights/summary maths and Alex's family view permissions.
 * Expected numbers are computed here from the sample data definitions (shared/demoData.ts) and the records this test
 * types, never copied from the endpoint.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

vi.hoisted(() => { process.env.API_LIMIT_PER_MIN = '5000'; process.env.AI_SESSION_LIMIT_PER_MIN = '1000'; process.env.COMPANION_LIMIT_PER_MIN = '5000'; });

import { createApp } from '../server/app';
import { getProduct } from '../server/catalogue/products';
import { SAMPLE_RECORDS, SAMPLE_SHOP, SAMPLE_SUBS, SAMPLE_CONTACTS, TRAINING_EXAMPLES } from '../shared/demoData';
import { InsightsSummary } from '../shared/insightsSummary';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
beforeAll(() => { process.env.DEMO_SEED = 'on'; });
const mary = async () => { const a = request.agent(app); await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200); return a; };
const today = new Date().toISOString().slice(0, 10);
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const money = (xs: { currency: string; cents: number }[]) => Object.fromEntries(xs.map((x) => [x.currency, x.cents]));
const annualOf = (s: { amountCents: number; frequency: string }) => (s.frequency === 'weekly' ? s.amountCents * 52 : s.frequency === 'monthly' ? s.amountCents * 12 : s.amountCents);

describe('Mary: /api/insights/summary calculations', () => {
  it('per-kind separation, per-currency totals, yearly/12, duplicates and scam counts', async () => {
    const a = await mary();
    // Records Mary types herself: EUR and GBP, plus an identical pair (same recipient, amount and day).
    for (const r of [
      { recipient: 'Window cleaner', amountCents: 2500, currency: 'EUR', paidOn: today, method: 'cash' },
      { recipient: 'Window cleaner', amountCents: 2500, currency: 'EUR', paidOn: today, method: 'cash' },
      { recipient: 'London plumber', amountCents: 6000, currency: 'GBP', paidOn: today, method: 'bank_transfer' },
    ]) await a.post('/api/companion/payments').set(H).send(r).expect(201);
    // Subscriptions she adds: a yearly GBP one (→ /12) and a weekly EUR one (→ ×52/12).
    await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Garden Club', amountCents: 6000, currency: 'GBP', frequency: 'yearly', nextOn: daysFromNow(10) }).expect(201);
    await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Milk delivery', amountCents: 450, currency: 'EUR', frequency: 'weekly' }).expect(201);
    // Scam checks: one training example (practice, never counted), one suspicious and one ordinary real message.
    await a.post('/api/scan').set(H).send({ text: TRAINING_EXAMPLES[0].text }).expect(200);
    const sus = (await a.post('/api/scan').set(H).send({ text: 'URGENT: your bank account is locked. Verify your card number and PIN now at http://bank-secure-verify.xyz or call +44 20 7946 0888 today.' }).expect(200)).body;
    const fine = (await a.post('/api/scan').set(H).send({ text: 'See you at lunch on Sunday, I will bring the dessert.' }).expect(200)).body;

    const s = (await a.get('/api/insights/summary').expect(200)).body;
    expect(InsightsSummary.safeParse(s).success).toBe(true);
    expect(s.role).toBe('elder'); expect(s.privateRecordsVisible).toBe(true);

    // Demo Shop: sample purchases are their own kind; none counted as a real PayPal Sandbox payment.
    const shop = SAMPLE_SHOP.filter((x) => getProduct(x.productId));
    const capturedSample = shop.filter((x) => x.state === 'CAPTURED');
    expect(s.payments.sample.count).toBe(shop.length);
    expect(s.payments.sample.captured.count).toBe(capturedSample.length);
    expect(money(s.payments.sample.captured.totals)).toEqual({ EUR: capturedSample.reduce((t, x) => t + getProduct(x.productId)!.priceCents, 0) });
    expect(s.payments.sandbox).toMatchObject({ count: 0, captured: { count: 0, totals: [] }, waitingFamily: 0 });
    expect(s.pendingReviews.real).toHaveLength(0);
    expect(s.pendingReviews.sampleWaiting).toBe(shop.filter((x) => x.approval === 'pending').length);

    // Records: user-entered vs sample, each per currency, never added together or converted.
    const sampleRec = SAMPLE_RECORDS.reduce((t, r) => t + r.amountCents, 0);
    expect(s.records.sample).toEqual({ count: SAMPLE_RECORDS.length, totals: [{ currency: 'EUR', cents: sampleRec }] });
    expect(s.records.userEntered).toEqual({ count: 3, totals: [{ currency: 'EUR', cents: 5000 }, { currency: 'GBP', cents: 6000 }] });

    // Subscriptions: monthly = sum(annual)/12 per currency, rounded once; kinds kept apart.
    const sampleAnnual = SAMPLE_SUBS.reduce((t, x) => t + annualOf(x), 0);
    expect(s.subscriptions.sample).toEqual({ count: SAMPLE_SUBS.length, monthly: [{ currency: 'EUR', cents: Math.round(sampleAnnual / 12) }], annual: [{ currency: 'EUR', cents: sampleAnnual }] });
    expect(s.subscriptions.userEntered).toEqual({ count: 2, monthly: [{ currency: 'EUR', cents: Math.round((450 * 52) / 12) }, { currency: 'GBP', cents: 500 }], annual: [{ currency: 'EUR', cents: 450 * 52 }, { currency: 'GBP', cents: 6000 }] });
    expect(s.subscriptions.sandbox.count).toBe(0);
    // Upcoming: next charges within 31 days, each labelled with its kind, soonest first.
    const up = s.subscriptions.upcoming;
    expect(up.map((u: any) => u.inDays)).toEqual([...up.map((u: any) => u.inDays)].sort((x: number, y: number) => x - y));
    expect(up.find((u: any) => u.merchant === SAMPLE_SUBS[0].merchant)?.kind).toBe('sample');
    expect(up.find((u: any) => u.merchant === 'Garden Club')).toMatchObject({ kind: 'user_entered', currency: 'GBP', amountCents: 6000 });
    expect(up.every((u: any) => u.inDays <= 31)).toBe(true);

    // Duplicates: the sample John Smith pair (2 days apart) and her own identical pair, labelled sample / not.
    const john = s.duplicates.find((d: any) => d.recipient === 'John Smith');
    expect(john).toMatchObject({ kind: 'possible_duplicate', amountCents: 8000, currency: 'EUR', daysApart: 2, sample: true });
    const mine = s.duplicates.find((d: any) => d.recipient === 'Window cleaner');
    expect(mine).toMatchObject({ amountCents: 2500, currency: 'EUR', daysApart: 0, sample: false });
    expect(['identical_entries', 'possible_duplicate']).toContain(mine.kind);
    expect(s.duplicates.some((d: any) => d.recipient === 'London plumber')).toBe(false);

    // Scam checks: training examples are counted apart and never as incidents; verdicts add up.
    expect(s.scamChecks.scope).toBe('all');
    expect(s.scamChecks.training).toBe(1);
    expect(s.scamChecks.real.total).toBe(2);
    expect(s.scamChecks.real.suspicious + s.scamChecks.real.needsChecking + s.scamChecks.real.noWarnings).toBe(2);
    expect(s.scamChecks.real.suspicious).toBe(sus.verdict === 'suspicious' ? 1 : 0) ;
    expect(fine.verdict).not.toBe('suspicious');

    // Recent list: every row says which kind it is.
    expect(s.payments.recent.every((r: any) => ['sandbox', 'sample', 'user_entered'].includes(r.kind))).toBe(true);
    expect(s.payments.recent.filter((r: any) => r.kind === 'sandbox')).toHaveLength(0);
  });
});

describe('Alex: family insights never expose Mary’s private records', () => {
  it('/api/family/insights + /api/insights/summary?as=family + private routes', async () => {
    const a = await mary();
    // Mary shares one scam check and keeps one private.
    const shared = (await a.post('/api/scan').set(H).send({ text: 'URGENT: verify your card now at http://bank-secure-verify.xyz or your account closes today.' }).expect(200)).body;
    await a.post('/api/scan').set(H).send({ text: 'Private: my neighbour asked to borrow the ladder.' }).expect(200);
    await a.post(`/api/scan/${shared.scanId}/share`).set(H).send({}).expect(200);
    await a.post('/api/companion/payments').set(H).send({ recipient: 'Secret Recipient', amountCents: 1234, currency: 'EUR', paidOn: today, method: 'cash' }).expect(201);

    // A brand-new agent with only Alex's family session (Mary's elder cookie dropped).
    const res = await a.post('/api/demo/alex').set(H).send({}).expect(200);
    const fam = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ss_family='))!.split(';')[0];
    const alex = request.agent(app);
    const cookies = [fam];
    const fi = await alex.get('/api/family/insights').set('Cookie', cookies.join('; '));
    expect(fi.status).toBe(200);
    const text = JSON.stringify(fi.body);
    const PRIVATE = [...SAMPLE_RECORDS.map((r) => r.recipient), ...SAMPLE_SUBS.map((x) => x.merchant), ...SAMPLE_CONTACTS.map((c) => c.name).filter((n) => n !== 'Alex Byrne'), 'Secret Recipient', 'Fence repair', 'neighbour'];
    for (const p of PRIVATE) expect(text, p).not.toContain(p);

    const fs = (await alex.get('/api/insights/summary?as=family').set('Cookie', cookies.join('; ')).expect(200)).body;
    expect(fs.role).toBe('family');
    expect(fs.privateRecordsVisible).toBe(false);
    expect(fs.records).toBeNull(); expect(fs.subscriptions).toBeNull(); expect(fs.duplicates).toBeNull();
    expect(fs.scamChecks.scope).toBe('shared');
    expect(fs.scamChecks.real.total).toBe(1); // only the one Mary shared
    for (const p of PRIVATE) expect(JSON.stringify(fs), p).not.toContain(p);
    // Sample vs verified labels survive in the family view (Demo Shop rows are shared, labelled sample).
    expect(fs.payments.recent.every((r: any) => r.kind === 'sample' || r.kind === 'sandbox')).toBe(true);
    expect(fs.payments.sandbox.captured.count).toBe(0);

    // Mary's private companion routes refuse a family-only session.
    const familyOnly = fam;
    for (const path of ['/api/companion/payments', '/api/companion/subscriptions', '/api/companion/contacts']) {
      const r = await request(app).get(path).set('Cookie', familyOnly);
      expect([401, 403], path).toContain(r.status);
    }
    // And an anonymous visitor gets nothing.
    expect((await request(app).get('/api/insights/summary')).status).toBe(401);
    expect((await request(app).get('/api/family/insights')).status).toBe(401);
  });
});
