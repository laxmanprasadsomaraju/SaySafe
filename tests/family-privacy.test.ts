/**
 * FAMILY PRIVACY — server-enforced permissions for the trusted family member (Alex).
 *
 *  - Spending approval (always on): Alex sees and decides ONLY the requests routed to him (above Mary's limit),
 *    with exact item / merchant / amount / status and the payment outcome afterwards.
 *  - Under-limit purchases are private by default: never listed, never readable by id, never in Insights or the AI.
 *  - Only Mary changes her limit (Alex → 403) and her two sharing switches (both OFF by default, incl. migrated
 *    households): "Share spending summaries" (totals only) and "Share my individual purchase history".
 *  - Revocation applies on the very next API read and the very next AI call.
 *  - The AI provider (Groq) and PayPal are TEST DOUBLES; the payload sent to the model is captured and asserted on.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';

vi.hoisted(() => {
  process.env.GROQ_API_KEY = 'test-key-not-real';
  process.env.AI_FALLBACK_BASE_URL = '';
  process.env.DEMO_SEED = 'on';
  process.env.API_LIMIT_PER_MIN = '100000'; process.env.COMPANION_LIMIT_PER_MIN = '100000'; process.env.AI_SESSION_LIMIT_PER_MIN = '100000';
});
const st = vi.hoisted(() => ({ orders: new Map<string, any>() }));
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
    if (o.status === 'COMPLETED' && o.purchase_units[0].payments) return o;
    o.status = 'COMPLETED';
    o.purchase_units[0].payments = { captures: [{ id: 'CAP' + id, status: 'COMPLETED', amount: o.purchase_units[0].amount, create_time: new Date().toISOString() }] };
    return o;
  }),
  getCapture: vi.fn(async () => null),
  refundCapture: vi.fn(), getRefund: vi.fn(),
  verifyWebhook: vi.fn(async () => true),
  isUnknownOutcome: (e: any) => !e?.status || e.status >= 500,
  approveLink: (o: any) => o.links[0].href,
  createSubscription: vi.fn(), getSubscription: vi.fn(), cancelSubscription: vi.fn(), subscriptionApproveLink: () => null,
}));

// Model double: records every prompt sent to the provider.
const modelPrompts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url);
  if (url.includes('/chat/completions')) { modelPrompts.push(String(init?.body ?? '')); return new Response(JSON.stringify({ choices: [{ message: { content: 'Here is a short summary.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { openDatabase, resolveDbConfig } from '../server/db/driver';
import { initSchema, SCHEMA_SQL } from '../server/db/schema';
import { getSharing } from '../server/family/permissions';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
let ip = 0;
type Agent = ReturnType<typeof request.agent>;

async function household(): Promise<{ m: Agent; f: Agent; hh: string }> {
  const m = request.agent(app);
  await m.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
  const inv = (await m.post('/api/family/invite').set(H).send({}).expect(200)).body;
  const f = request.agent(app);
  await f.post('/api/family/pair').set(H).set('X-Forwarded-For', `10.77.${++ip % 250}.${ip % 250}`).send({ code: inv.code, name: 'Alex' }).expect(200);
  const hh = (db.prepare("SELECT household_id h FROM family_links WHERE status='active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any).h as string;
  return { m, f, hh };
}
const key = () => 'k' + Math.random().toString(36).slice(2, 14);
const buy = async (m: Agent, productId: string) => (await m.post('/api/payments').set(H).send({ items: [{ productId, quantity: 1 }], idempotencyKey: key() }).expect(200)).body;
/** Mary pays an under-limit item all the way (PayPal approve + capture). */
async function payThrough(m: Agent, id: string, approveUrl?: string | null) {
  const url = approveUrl ?? (await m.post(`/api/payments/${id}/checkout`).set(H).send({}).expect(200)).body.approveUrl;
  const orderId = new URL(url).searchParams.get('token')!;
  st.orders.get(orderId).status = 'APPROVED';
  return m.post(`/api/payments/${id}/confirm`).set(H).send({ orderId }).expect(200);
}
const blobOf = (x: unknown) => JSON.stringify(x);
/** The user message (DATA + QUESTION) of the last prompt sent to the model, as plain text. */
const lastPrompt = () => { const b = JSON.parse(modelPrompts[modelPrompts.length - 1] ?? '{"messages":[]}'); return String(b.messages.find((x: any) => x.role === 'user')?.content ?? ''); };
/** All family read surfaces for one family agent, as one string. */
async function familyEverything(f: Agent) {
  const parts = await Promise.all([
    f.get('/api/family/overview').expect(200), f.get('/api/activity?as=family').expect(200),
    f.get('/api/family/insights').expect(200), f.get('/api/insights/summary?as=family').expect(200),
  ]);
  return parts.map((p) => blobOf(p.body)).join('\n');
}

describe('spending approval: Alex reviews only what is routed to him, end to end', () => {
  it('Alex approves an above-limit purchase, Mary pays at PayPal, receipt verified — without reading anything else', async () => {
    const { m, f, hh } = await household();
    const kettle = await buy(m, 'kettle-classic'); // €32: under the €75 limit -> straight to PayPal, private
    await payThrough(m, kettle.request.id, kettle.approveUrl);
    const micro = await buy(m, 'microwave'); // €120: above the limit -> Alex's review
    expect(micro.request.state).toBe('FAMILY_APPROVAL_PENDING');

    // Alex: the review request with exact item, merchant, amount, status.
    const ov = (await f.get('/api/family/overview').expect(200)).body;
    const real = ov.requests.filter((r: any) => !r.sample); // labelled sample reviews from "Try as Mary" stay listed, not actionable
    expect(real.map((r: any) => r.id)).toEqual([micro.request.id]);
    expect(real[0]).toMatchObject({ merchant: 'SaySafe Demo Shop (sandbox)', amountCents: 12000, currency: 'EUR', state: 'FAMILY_APPROVAL_PENDING' });
    expect(real[0].items[0].name).toMatch(/Microwave/);
    const one = (await f.get(`/api/family/requests/${micro.request.id}`).expect(200)).body;
    await f.post(`/api/family/requests/${micro.request.id}/decision`).set(H).send({ decision: 'approve', approvalId: one.approval.id }).expect(200);

    // Mary still authorises at PayPal herself; capture; receipt.
    await payThrough(m, micro.request.id);
    const receipt = (await m.get(`/api/payments/${micro.request.id}`).expect(200)).body;
    expect(receipt.state).toBe('CAPTURED');

    // Alex sees the outcome of the request he reviewed (paid, receipt present)…
    const after = (await f.get(`/api/family/requests/${micro.request.id}`).expect(200)).body;
    expect(after.state).toBe('CAPTURED');
    expect(after.receipt).toBeTruthy();
    // …but never the under-limit purchase, by list or by id, nor Mary's private records.
    await f.get(`/api/family/requests/${kettle.request.id}`).expect(404);
    const all = await familyEverything(f);
    expect(all).not.toContain(kettle.request.id);
    expect(all).not.toMatch(/Easy-Pour Electric Kettle/);
    expect(all).not.toMatch(/John Smith|Shannon Boiler|StreamBox|TuneWave|Riverside Pharmacy|Pat Doyle|Hearthside|Fence repair/); // seeded contacts, payment records, subscriptions
    for (const path of ['/api/companion/payments', '/api/companion/subscriptions', '/api/companion/contacts', '/api/preferences', '/api/payments', `/api/payments/${kettle.request.id}`]) {
      const r = await f.get(path);
      expect([401, 403, 404]).toContain(r.status);
      expect(blobOf(r.body)).not.toContain(kettle.request.id);
    }
    // The Assistant has no family access to Mary's records (no elder session -> nothing of hers is searched).
    const asked = await f.post('/api/assistant').set(H).send({ text: 'Did I already pay John €80?' });
    expect(blobOf(asked.body)).not.toMatch(/John Smith|Shannon Boiler/);
    expect(stateOf(kettle.request.id)).toBe('CAPTURED');
    expect(hh).toMatch(/^hh_|./);
  });

  it('direct API access by Alex to an under-limit purchase: 404 on read and on decision', async () => {
    const { m, f } = await household();
    const k = await buy(m, 'kettle-classic');
    await f.get(`/api/family/requests/${k.request.id}`).expect(404);
    const d = await f.post(`/api/family/requests/${k.request.id}/decision`).set(H).send({ decision: 'approve', approvalId: 'apr_forged123' });
    expect(d.status).toBe(404);
    expect(stateOf(k.request.id)).toBe(k.request.state);
  });

  it('Alex list (overview, activity, insights, summary) excludes under-limit purchases, including seeded sample ones', async () => {
    const { m, f, hh } = await household();
    const k = await buy(m, 'kettle-classic');
    const underSample = (db.prepare('SELECT id FROM payment_requests p WHERE household_id=? AND example=1 AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.request_id=p.id)').all(hh) as any[]).map((r) => r.id);
    expect(underSample.length).toBeGreaterThan(0);
    const all = await familyEverything(f);
    for (const id of [k.request.id, ...underSample]) expect(all).not.toContain(id);
  });
});

describe('only Mary changes her limit', () => {
  it('Alex → 403 and nothing changes; Mary can (elder endpoint)', async () => {
    const { m, f, hh } = await household();
    const before = (db.prepare('SELECT approval_threshold_cents c FROM spending_policies WHERE household_id=?').get(hh) as any).c;
    const r = await f.post('/api/family/policy').set(H).send({ thresholdEur: 500 });
    expect(r.status).toBe(403);
    expect((db.prepare('SELECT approval_threshold_cents c FROM spending_policies WHERE household_id=?').get(hh) as any).c).toBe(before);
    // Alex cannot use Mary's endpoint either (no elder session), even with forged role / household fields.
    const forged = await f.post('/api/policy').set(H).send({ thresholdEur: 500, role: 'elder', householdId: hh });
    expect(forged.status).toBe(401);
    expect((db.prepare('SELECT approval_threshold_cents c FROM spending_policies WHERE household_id=?').get(hh) as any).c).toBe(before);
    const ok = (await m.post('/api/policy').set(H).send({ thresholdEur: 50 }).expect(200)).body;
    expect(ok.thresholdCents).toBe(5000);
  });
});

describe('privilege escalation and cross-household', () => {
  it('Alex session cannot call Mary-only endpoints, forge role/body fields, or tamper with the household id', async () => {
    const { f, hh } = await household();
    const other = await household();
    const otherMicro = await buy(other.m, 'microwave');
    // Mary-only endpoints
    expect((await f.post('/api/family/sharing').set(H).send({ shareHistory: true })).status).toBe(401);
    expect(getSharing(hh).shareHistory).toBe(false);
    expect((await f.post('/api/payments').set(H).send({ items: [{ productId: 'kettle-classic', quantity: 1 }], idempotencyKey: key() })).status).toBe(401);
    expect((await f.get('/api/family/status')).status).toBe(401);
    // Body / query tampering is ignored: data always comes from the session's household.
    const ins = (await f.get(`/api/family/insights?householdId=${other.hh}&role=elder`).expect(200)).body;
    expect(blobOf(ins)).not.toContain(otherMicro.request.id);
    const ag = (await f.post('/api/family/insights/agent').set(H).send({ question: 'Which purchases are waiting for my approval?', householdId: other.hh, role: 'elder' }).expect(200)).body;
    expect(ag.answer).not.toMatch(/Microwave/);
    // Cross-household by id: 404 on read and decision.
    await f.get(`/api/family/requests/${otherMicro.request.id}`).expect(404);
    const apr = (await other.f.get(`/api/family/requests/${otherMicro.request.id}`).expect(200)).body.approval.id;
    expect((await f.post(`/api/family/requests/${otherMicro.request.id}/decision`).set(H).send({ decision: 'approve', approvalId: apr })).status).toBe(404);
    expect(stateOf(otherMicro.request.id)).toBe('FAMILY_APPROVAL_PENDING');
    // Sharing on in the OTHER household never opens this one.
    await other.m.post('/api/family/sharing').set(H).send({ shareHistory: true, shareSummaries: true }).expect(200);
    expect(blobOf((await f.get('/api/family/insights').expect(200)).body)).not.toContain(otherMicro.request.id);
  });

  it('sharing endpoint rejects unknown fields (no smuggled household or role)', async () => {
    const { m, hh } = await household();
    const r = await m.post('/api/family/sharing').set(H).send({ shareHistory: true, householdId: 'hh_other' });
    expect(r.status).toBe(400);
    expect(getSharing(hh).shareHistory).toBe(false);
  });

  it('sample rows are still never actionable, even when history is shared', async () => {
    const { m, f, hh } = await household();
    await m.post('/api/family/sharing').set(H).send({ shareHistory: true }).expect(200);
    const sample = db.prepare("SELECT p.id, a.id aid FROM payment_requests p JOIN approvals a ON a.request_id=p.id WHERE p.household_id=? AND p.example=1 AND a.status='pending' LIMIT 1").get(hh) as any;
    expect(sample).toBeTruthy();
    const r = await f.post(`/api/family/requests/${sample.id}/decision`).set(H).send({ decision: 'approve', approvalId: sample.aid });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('sample_not_actionable');
  });
});

describe('sharing switches: default OFF, on, revoke (API and AI payload)', () => {
  it('both switches are OFF for a new household', async () => {
    const { m, f } = await household();
    const st = (await m.get('/api/family/status').expect(200)).body;
    expect(st.sharing).toMatchObject({ shareSummaries: false, shareHistory: false });
    const ins = (await f.get('/api/family/insights').expect(200)).body;
    expect(ins.sharing).toEqual({ shareSummaries: false, shareHistory: false });
    expect(ins.spendingSummary).toBeNull();
  });

  it('migration adds both switches as OFF to an EXISTING household (never silently enabled)', () => {
    const old = openDatabase(resolveDbConfig({ DATABASE_FILE: ':memory:' } as any));
    // The schema before this change: spending_policies without the sharing columns, with a household in it.
    old.exec(SCHEMA_SQL.replace(/,\n  share_summaries_with_family INTEGER NOT NULL DEFAULT 0,\n  share_history_with_family INTEGER NOT NULL DEFAULT 0,\n  sharing_updated_at TEXT\n/, '\n'));
    const cols0 = (old.prepare('PRAGMA table_info(spending_policies)').all() as any[]).map((c) => c.name);
    expect(cols0).not.toContain('share_history_with_family');
    old.prepare("INSERT INTO users (id, name, role) VALUES ('usr_old','Mary','elder')").run();
    old.prepare("INSERT INTO households (id, elder_id) VALUES ('hh_old','usr_old')").run();
    old.prepare("INSERT INTO spending_policies (household_id, approval_threshold_cents) VALUES ('hh_old', 9000)").run();
    initSchema(old); // boot migration
    const row = old.prepare("SELECT approval_threshold_cents t, share_summaries_with_family s, share_history_with_family h FROM spending_policies WHERE household_id='hh_old'").get() as any;
    expect(row).toEqual({ t: 9000, s: 0, h: 0 });
    initSchema(old); // idempotent
  });

  it('history: OFF hides under-limit rows; ON shows them (API + AI payload); revoke hides them on the next read and next AI call', async () => {
    const { m, f } = await household();
    const k = await buy(m, 'kettle-classic');
    await payThrough(m, k.request.id, k.approveUrl);
    const micro = await buy(m, 'microwave');
    const ask = async () => { const n = modelPrompts.length; await f.post('/api/family/insights/agent').set(H).send({ question: 'Tell me something about her shopping' }).expect(200); expect(modelPrompts.length).toBe(n + 1); return lastPrompt(); };

    // OFF (default)
    expect(await familyEverything(f)).not.toContain(k.request.id);
    let p = await ask();
    expect(p).toContain('Simple Dial Microwave');
    expect(p).not.toContain('Easy-Pour Electric Kettle');
    expect(p).toMatch(/only see the purchases Mary asked you to review/);

    // ON
    await m.post('/api/family/sharing').set(H).send({ shareHistory: true }).expect(200);
    expect(blobOf((await f.get('/api/family/overview').expect(200)).body)).toContain(k.request.id);
    expect((await f.get(`/api/family/requests/${k.request.id}`).expect(200)).body.state).toBe('CAPTURED');
    p = await ask();
    expect(p).toContain('Easy-Pour Electric Kettle');

    // REVOKE: the very next read and the very next AI call exclude it.
    await m.post('/api/family/sharing').set(H).send({ shareHistory: false }).expect(200);
    await f.get(`/api/family/requests/${k.request.id}`).expect(404);
    expect(await familyEverything(f)).not.toContain(k.request.id);
    p = await ask();
    expect(p).not.toContain('Easy-Pour Electric Kettle');
    expect(p).toContain('Simple Dial Microwave'); // the request he reviews stays
    expect(micro.request.id).toBeTruthy();
  });

  it('summaries: totals only (no rows, ids or items); ON → in API + AI payload; revoke → gone next read and next AI call', async () => {
    const { m, f } = await household();
    const k = await buy(m, 'kettle-classic');
    await payThrough(m, k.request.id, k.approveUrl);
    const ask = async () => { await f.post('/api/family/insights/agent').set(H).send({ question: 'Tell me something about her shopping' }).expect(200); return lastPrompt(); };

    let ins = (await f.get('/api/family/insights').expect(200)).body;
    expect(ins.spendingSummary).toBeNull();
    expect(await ask()).toMatch(/"spendingTotals":null/);

    await m.post('/api/family/sharing').set(H).send({ shareSummaries: true }).expect(200);
    ins = (await f.get('/api/family/insights').expect(200)).body;
    const real = ins.spendingSummary.months.filter((x: any) => !x.sample);
    expect(real).toEqual([expect.objectContaining({ currency: 'EUR', count: 1, totalCents: 3200 })]);
    expect(ins.spendingSummary.categories.filter((x: any) => !x.sample)).toEqual([expect.objectContaining({ category: 'Kitchen', totalCents: 3200 })]);
    // Aggregates only: the individual purchase is still not listed anywhere.
    expect(blobOf(ins)).not.toContain(k.request.id);
    expect(blobOf(ins)).not.toContain('Easy-Pour Electric Kettle');
    expect(await familyEverything(f)).not.toContain(k.request.id);
    let p = await ask();
    expect(p).toMatch(/"totalCents":3200/);
    expect(p).not.toContain('Easy-Pour Electric Kettle');
    expect(p).not.toContain(k.request.id);
    // Deterministic totals answer uses the shared totals
    const tot = (await f.post('/api/family/insights/agent').set(H).send({ question: 'How much has she spent?' }).expect(200)).body.answer;
    expect(tot).toMatch(/€32/);

    await m.post('/api/family/sharing').set(H).send({ shareSummaries: false }).expect(200);
    expect((await f.get('/api/family/insights').expect(200)).body.spendingSummary).toBeNull();
    p = await ask();
    expect(p).toMatch(/"spendingTotals":null/);
    expect(p).not.toMatch(/"totalCents":3200/);
  });

  it('AI payload by default contains only permitted rows and minimal fields (no ids, PayPal ids, merchants, private records)', async () => {
    const { m, f, hh } = await household();
    const k = await buy(m, 'kettle-classic');
    await payThrough(m, k.request.id, k.approveUrl);
    const micro = await buy(m, 'microwave');
    await f.post('/api/family/insights/agent').set(H).send({ question: 'Give me an overview please' }).expect(200);
    const user = lastPrompt();
    const data = JSON.parse(user.slice('DATA:\n'.length, user.indexOf('\n\nQUESTION:')));
    const permitted = (db.prepare('SELECT COUNT(*) n FROM payment_requests p WHERE household_id=? AND EXISTS (SELECT 1 FROM approvals a WHERE a.request_id=p.id)').get(hh) as any).n;
    expect(data.payments).toHaveLength(permitted);
    expect(data.payments.map((x: any) => x.product)).toContain('Simple Dial Microwave 20L');
    for (const row of data.payments) expect(Object.keys(row).sort()).toEqual(['amount', 'approval', 'currency', 'day', 'demo', 'paid', 'product', 'status', 'waitingForMe', 'webhookConfirmed']);
    expect(user).not.toContain(k.request.id);
    expect(user).not.toContain(micro.request.id);
    expect(user).not.toMatch(/ORDER[A-Z0-9]{6}|CAPORDER|pay_|apr_|hh_|usr_/);
    expect(user).not.toMatch(/John Smith|Shannon Boiler|StreamBox|TuneWave|Riverside Pharmacy|Pat Doyle|Hearthside|Fence repair/);
    expect(data.spendingTotals).toBeNull();
    // Mary's own /insights is unchanged: she still sees everything of hers.
    const mine = (await m.get('/api/insights/summary').expect(200)).body;
    expect(mine.records).not.toBeNull();
    expect(mine.payments.sandbox.count).toBe(2);
  });
});

function stateOf(id: string) { return (db.prepare('SELECT state FROM payment_requests WHERE id=?').get(id) as any)?.state; }
