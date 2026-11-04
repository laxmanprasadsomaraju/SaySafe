/**
 * Assistant repair (focused): intent routing for natural phrasing, the read-only tools (preferences, memory,
 * conversation, transactions, duplicate charges, approval limit, "can I transfer", payment evidence, trusted contacts),
 * the Channel3 adapter (structured filters, brand lookup, error handling), shopping follow-ups, the clarify fallback,
 * family privacy, and that read-only questions never create or capture anything.
 * Channel3 = RECORDED real responses (tests/fixtures/channel3-*.json); the AI provider = a TEST DOUBLE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import microwave from './fixtures/channel3-microwave.json';
import kettle from './fixtures/channel3-kettle.json';
import womenTee from './fixtures/channel3-nike-women-tshirt.json';
import ps5 from './fixtures/channel3-ps5.json';

vi.hoisted(() => {
  process.env.CHANNEL3_API_KEY = 'test-key-fixture';
  process.env.GROQ_API_KEY = 'test-key-not-real';
  process.env.AI_FALLBACK_BASE_URL = '';
  process.env.COMPANION_LIMIT_PER_MIN = '5000'; process.env.API_LIMIT_PER_MIN = '5000'; process.env.AI_LIMIT_PER_MIN = '5000'; process.env.AI_SESSION_LIMIT_PER_MIN = '5000';
});

const c3: { url: string; body: any }[] = [];
let c3Mode: 'ok' | 'malformed' | '401' | '403' | '429' | 'timeout' | '500' = 'ok';
let modelIntent: Record<string, unknown> = { action: 'chat', reply: 'Hello.' };
let aiCalls = 0;
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (url: any, init: any) => {
  const u = String(url);
  if (u.includes('trychannel3.com')) {
    if (u.includes('/v1/brands/search')) {
      const q = new URL(u).searchParams.get('query') ?? '';
      c3.push({ url: u, body: null });
      return new Response(JSON.stringify({ brands: /^nike$/i.test(q) ? [{ id: 'MpZS', name: 'Nike' }, { id: 'QcbK', name: 'Nike SB' }] : [] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    c3.push({ url: u, body });
    if (c3Mode === 'malformed') return new Response('<html>not json</html>', { status: 200 });
    if (c3Mode === '401' || c3Mode === '403') return new Response('{}', { status: Number(c3Mode) });
    if (c3Mode === '429') return new Response('{}', { status: 429, headers: { 'retry-after': '7' } });
    if (c3Mode === '500') return new Response('{}', { status: 500 });
    if (c3Mode === 'timeout') { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
    const q = String(body.query ?? '');
    const fx = /t-?shirt/i.test(q) ? womenTee : /kettle/i.test(q) ? kettle : /ps5|playstation/i.test(q) ? ps5 : microwave;
    return new Response(JSON.stringify(fx), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/chat/completions')) {
    aiCalls++;
    const b = JSON.parse(String(init?.body ?? '{}'));
    const system = String(b.messages?.find((m: any) => m.role === 'system')?.content ?? '');
    const content = /why a product listing was picked/.test(system) ? 'It is listed at the shop.' : JSON.stringify(modelIntent);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
});

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { routeAssistant } from '../server/assistant/route';
import { parseShopping, channel3Query, channel3Filters, refineSpec, looksLikeProductSearch } from '../server/assistant/shopping';
import { searchChannel3 } from '../server/catalogue/channel3';
import { isPaymentStatusQuestion } from '../shared/paymentStatus';
import { setMemoryClock } from '../server/memory/store';
import { fallbackIntent } from '../server/ai/agent';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
type Agent = ReturnType<typeof request.agent>;
async function elder(seed: 'on' | 'off' = 'on') {
  const prev = process.env.DEMO_SEED; process.env.DEMO_SEED = seed;
  try {
    const a = request.agent(app);
    await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
    const row = db.prepare('SELECT household_id, user_id FROM sessions ORDER BY rowid DESC LIMIT 1').get() as any;
    return { a, hh: row.household_id as string, uid: row.user_id as string };
  } finally { process.env.DEMO_SEED = prev; }
}
const say = (a: Agent, text: string) => a.post('/api/assistant').set(H).send({ text });
let off = 0;
const realNow = Date.now.bind(Date);
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + off);
const discover = (a: Agent, text: string, extra: Record<string, unknown> = {}) => { off += 11 * 60_000; return a.post('/api/discover').set(H).send({ text, ...extra }); };
const payRows = (hh: string) => Number((db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE household_id=?').get(hh) as any).n);
function insertCaptured(hh: string, id: string, item: string, cents: number, createdAt: string, capture: string) {
  db.prepare(`INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, paypal_order_id, paypal_capture_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, hh, 'CAPTURED', JSON.stringify([{ productId: 'kettle-basic', name: item, quantity: 1, lineCents: cents, image: 'x.png' }]), 'SaySafe Demo Shop', cents, 'EUR', `fp_${id}`, `ORD${id.toUpperCase()}`.slice(0, 20), capture, createdAt, createdAt);
}

beforeEach(() => { c3.length = 0; c3Mode = 'ok'; modelIntent = { action: 'chat', reply: 'Hello.' }; aiCalls = 0; });

describe('routing: natural phrasing -> the right read-only tool (deterministic, no AI call)', () => {
  const cases: [string, string, Record<string, unknown>?][] = [
    ['What are my preferences?', 'preferences', { aspect: 'all' }], ['what do i like', 'preferences'], ['What colour do I like?', 'preferences', { aspect: 'colour' }],
    ['Why are you showing me black kettles?', 'preferences', { aspect: 'why' }], ['What do you remember about me?', 'memory_recall'],
    ['What did we discuss yesterday?', 'conversation_recall', { when: 'yesterday' }], ['Show me all my transactions', 'transactions', { mode: 'list' }],
    ['show me all my transacitons', 'transactions'], ['What did I pay last week?', 'transactions', { period: 'last_week' }], ['Show purchases above €50', 'transactions', { min: 50 }],
    ['How much have I spent this month?', 'transactions', { mode: 'total', period: 'this_month' }], ['Show my latest receipt', 'transactions', { mode: 'latest_receipt' }],
    ['Show me pending payments', 'transactions', { status: 'pending' }], ['Was I charged twice?', 'duplicate_check'], ['Have I been double charged?', 'duplicate_check'],
    ['What is my spending approval limit?', 'spending_limit'], ['how much can I spend', 'spending_limit'], ['Can I transfer money to my grandson?', 'transfer_check', { relation: 'grandson' }],
    ['can i send money to anyone', 'transfer_check'], ['Is it safe to pay Pat Doyle €500?', 'payment_check', { person: 'Pat Doyle', amount: 500 }],
    ['I trust Margaret', 'trust_contact', { person: 'Margaret' }], ['What can you do?', 'capabilities'],
  ];
  for (const [q, tool, params] of cases) it(`"${q}" -> ${tool}`, () => { const r = routeAssistant(q); expect(r?.tool).toBe(tool); if (params) expect(r?.params).toMatchObject(params); });
  it('does not steal shopping, scam checks, record searches or subscriptions', () => {
    for (const q of ['Find a kettle', "Show me women's Nike T-shirts", 'I want to buy a PS5 for my grandson', 'Did I pay for the microwave?', 'Show my subscriptions', 'Did I pay John twice?', 'Is this message a scam?']) expect(routeAssistant(q), q).toBeNull();
  });
  it('"Was I charged twice?" is no longer the single-receipt status question', () => {
    expect(isPaymentStatusQuestion('Was I charged twice?')).toBe(false);
    expect(isPaymentStatusQuestion('Was I charged?')).toBe(true);
  });
});

describe('shopping understanding -> structured Channel3 request', () => {
  it('black women\'s Nike T-shirts under €40', () => {
    const s = parseShopping("Find black women's Nike T-shirts under €40");
    expect(s).toMatchObject({ product: 't-shirt', brand: 'Nike', gender: 'female', age: 'adult', colour: 'black', maxPrice: 40 });
    expect(channel3Filters(s)).toMatchObject({ gender: 'female', age: ['adult'], brand: 'Nike' });
  });
  it('PS5 for my grandson: product kept (model number intact), recipient noted but NOT in the query', () => {
    const s = parseShopping('I want to buy a PS5 for my grandson');
    expect(s).toMatchObject({ product: 'ps5', recipient: 'grandson', brand: null });
    expect(channel3Query(s)).toBe('ps5');
    expect(looksLikeProductSearch('I want to buy a PS5 for my grandson')).toBe(true);
  });
  it('size and retailer', () => {
    expect(parseShopping('Do you have running shoes size 9 from Argos?')).toMatchObject({ product: 'running shoes', size: '9', retailer: 'argos.ie' });
  });
  it('refinements of the last search vs a new search', () => {
    const last = parseShopping("Find women's Nike T-shirts");
    expect(refineSpec('Only Adidas', last)?.spec.brand).toBe('Adidas');
    expect(refineSpec('Under €30', last)?.spec.maxPrice).toBe(30);
    expect(refineSpec('Do you have a red version?', last)?.spec.colour).toBe('red');
    expect(refineSpec('What about size medium?', last)?.spec.size).toBe('M');
    expect(refineSpec("I want a men's version instead", last)?.spec.gender).toBe('male');
    expect(refineSpec('Find me a microwave under €150', last)).toBeNull();
    expect(refineSpec('Find a kettle', last)).toBeNull();
  });
});

describe('Channel3 adapter', () => {
  it('sends documented filters only (gender, age, brand_ids via brand lookup, price), locale in config, no colors palette', async () => {
    const r = await searchChannel3("black women's Nike t-shirt", { maxPrice: 40, relevanceQuery: 't-shirt', filters: channel3Filters(parseShopping("black women's Nike T-shirts under €40")), fetchImpl: fetch as any });
    const search = c3.find((x) => x.body);
    expect(search!.body).toMatchObject({ query: "black women's Nike t-shirt", config: { country: 'IE', currency: 'EUR', language: 'en' }, filters: { gender: 'female', age: ['adult'], brand_ids: ['MpZS'], price: { max_price: 40 } } });
    expect(search!.body.filters.colors).toBeUndefined();
    expect(search!.body.locale).toBeUndefined();
    expect(r.products.length).toBeGreaterThan(0);
    expect(r.products.every((p) => p.offers[0].price <= 40 && p.offers[0].currency === 'EUR')).toBe(true);
    expect(r.request?.filters).toMatchObject({ brand: 'Nike', gender: 'female' });
  });
  it('malformed data, 401, 403, 429, 500 and timeouts are distinct errors, never "no results"', async () => {
    for (const [mode, code] of [['malformed', 'malformed'], ['401', 'unauthorized'], ['403', 'unauthorized'], ['429', 'rate_limited'], ['500', 'upstream'], ['timeout', 'timeout']] as const) {
      c3Mode = mode;
      await expect(searchChannel3(`x ${mode}`, { fetchImpl: fetch as any })).rejects.toMatchObject({ code });
    }
  });
  it('the HTTP answer for a failure is actionable and contains no products', async () => {
    const { a } = await elder();
    c3Mode = '429';
    const r = await discover(a, 'find a kettle').expect(429);
    expect(r.body.products).toEqual([]);
    expect(r.body.message).toMatch(/try again in 7 seconds/i);
    expect(r.body.message).toMatch(/haven't shown any made-up products/i);
    expect(r.body.message).not.toMatch(/ps5|grandson/i);
  });
});

describe('shopping through /api/assistant + /api/discover', () => {
  it('"Find a kettle" -> Channel3 (not just the Demo Shop); Demo Shop offered separately; no AI call', async () => {
    const { a } = await elder();
    const r = (await say(a, 'Find a kettle').expect(200)).body;
    expect(r).toMatchObject({ tool: 'channel3_search', ai: false, discover: { query: 'kettle' } });
    expect(r.demoOffer?.length).toBe(1);
    expect(aiCalls).toBe(0);
    const d = (await discover(a, r.discover.query).expect(200)).body;
    expect(d.products.length).toBeGreaterThanOrEqual(3);
    expect(d.request.query).toBe('kettle'); // a remembered colour is NOT added to the query text
  });
  it('women\'s Nike T-shirts: structured filters reach Channel3 and cards explain why', async () => {
    const { a } = await elder('off');
    const r = (await say(a, "Show me women's Nike T-shirts").expect(200)).body;
    expect(r.tool).toBe('channel3_search');
    const d = (await discover(a, r.discover.query).expect(200)).body;
    expect(d.request.filters).toMatchObject({ gender: 'female', brand_ids: ['MpZS'] });
    expect(d.products.length).toBeGreaterThan(0);
    expect(d.products[0].why.join(' ')).toMatch(/Nike, as you asked|Listed for women/);
  });
  it('PS5 for my grandson -> real listings (console first, accessories after), Demo Shop chips, recipient never sent', async () => {
    const { a } = await elder();
    const r = (await say(a, 'I want to buy a PS5 for my grandson').expect(200)).body;
    expect(r).toMatchObject({ tool: 'channel3_search', discover: { query: 'ps5', suggested: true } });
    expect(r.discover.lead).toMatch(/for your grandson/);
    expect(r.catalogue.length).toBeGreaterThan(0);
    const d = (await discover(a, r.discover.query).expect(200)).body;
    expect(JSON.stringify(c3.map((x) => x.body))).not.toMatch(/grandson/i);
    expect(d.products[0].title).toMatch(/PlayStation 5/i);
    expect(d.products[0].title).not.toMatch(/controller/i);
  });
  it('follow-up "Only Philips" refines the last real-shop search; a new product is a new search', async () => {
    const { a } = await elder('off');
    const r1 = (await say(a, 'Find me a microwave under €150').expect(200)).body;
    await discover(a, r1.discover.query, { maxPrice: r1.discover.maxPrice }).expect(200);
    const r2 = (await say(a, 'Only Philips').expect(200)).body;
    expect(r2.discover.query).toMatch(/Philips microwave under €150/);
    const r3 = (await say(a, 'Find a kettle').expect(200)).body;
    expect(r3.discover.query).toBe('kettle');
  });
});

describe('preferences and memory answers (from saved memory + Profile)', () => {
  it('"I prefer red" then "What are my preferences?" -> red + Profile values; family can\'t see it', async () => {
    const { a } = await elder('off');
    await a.put('/api/preferences').set(H).send({ profile: { brands: ['Philips'], budgetMax: 90 } }).expect(200);
    await say(a, 'I like red, blue').expect(200);
    const r = (await say(a, 'What are my preferences?').expect(200)).body;
    expect(r.tool).toBe('preferences');
    expect(r.reply).toMatch(/red and blue/);
    expect(r.reply).toMatch(/Philips/);
    expect(r.reply).toMatch(/€90/);
    expect(r.companion.kind).toBe('assistant_facts');
    const c = (await say(a, 'What colour do I like?').expect(200)).body;
    expect(c.reply).toMatch(/red and blue/);
  });
  it('memory off -> says so accurately (no guessing)', async () => {
    const { a } = await elder('off');
    await a.put('/api/memory/settings').set(H).send({ enabled: false }).expect(200);
    const r = (await say(a, 'What are my preferences?').expect(200)).body;
    expect(r.reply).toMatch(/Memory is off/);
  });
  it('"What do you remember about me?" lists the actual saved memories', async () => {
    const { a } = await elder('on');
    const r = (await say(a, 'What do you remember about me?').expect(200)).body;
    expect(r.tool).toBe('memory_recall');
    expect(r.reply).toMatch(/black \(sample\)/);
    expect(r.reply).toMatch(/€150/);
    expect(r.reply).toMatch(/never proof of payment/);
  });
  it('"Why are you showing me black kettles?" names the saved preference used', async () => {
    const { a } = await elder('on');
    const r1 = (await say(a, 'Find a kettle').expect(200)).body;
    await discover(a, r1.discover.query).expect(200);
    const r = (await say(a, 'Why are you showing me black kettles?').expect(200)).body;
    expect(r.reply).toMatch(/Prefers the colour black/);
    expect(r.reply).toMatch(/ignore my preferences/);
  });
  it('"What did we discuss yesterday?" uses the stored turns of that day only', async () => {
    const { a } = await elder('off');
    const yesterday = new Date(Date.now() - 86_400_000);
    setMemoryClock(() => yesterday);
    try { await say(a, 'Find me a microwave under €150').expect(200); } finally { setMemoryClock(null); }
    const r = (await say(a, 'What did we discuss yesterday?').expect(200)).body;
    expect(r.tool).toBe('conversation_recall');
    expect(r.reply).toMatch(/microwave under €150/);
    expect(r.reply).toMatch(/not proof of any payment/);
  });
});

describe('money questions (read-only, from authoritative records)', () => {
  it('"Show me all my transactions" counts EVERY record by kind (not the first page)', async () => {
    const { a, hh } = await elder('on');
    insertCaptured(hh, 'pay_realkettle01', 'Easy-Pour Electric Kettle 1.5L', 3200, '2026-11-01 10:00:00', 'CAPREAL0001');
    const r = (await say(a, 'Show me all my transactions').expect(200)).body;
    expect(r.tool).toBe('transactions');
    expect(r.toolRead).toMatchObject({ total: 16, captured: 1, sample: 15 });
    expect(r.reply).toMatch(/1 real PayPal Sandbox purchase paid \(€32\.00\)/);
    expect(r.reply).toMatch(/sample/);
    expect(r.companion).toMatchObject({ kind: 'payment_history', total: 16 });
    expect(r.companion.items.length).toBe(10);
  });
  it('filters: above €50, this month total, pending', async () => {
    const { a } = await elder('on');
    const over = (await say(a, 'Show purchases above €50').expect(200)).body;
    expect(over.companion.items.every((i: any) => i.amountCents >= 5000)).toBe(true);
    const tot = (await say(a, 'How much have I spent this month?').expect(200)).body;
    expect(tot.reply).toMatch(/don’t add them together/);
    const pend = (await say(a, 'Show me pending payments').expect(200)).body;
    expect(pend.toolRead.total).toBeGreaterThan(0);
  });
  it('"Was I charged twice?" inspects captures and their PayPal capture ids', async () => {
    const { a, hh } = await elder('off');
    expect((await say(a, 'Was I charged twice?').expect(200)).body.reply).toMatch(/no captured PayPal Sandbox payments/);
    insertCaptured(hh, 'pay_dupa000001', 'Wide-Slot Toaster', 2900, '2026-11-02 10:00:00', 'CAPDUPA00001');
    insertCaptured(hh, 'pay_dupb000002', 'Wide-Slot Toaster', 2900, '2026-11-02 12:00:00', 'CAPDUPB00002');
    const r = (await say(a, 'Was I charged twice?').expect(200)).body;
    expect(r.tool).toBe('duplicate_check');
    expect(r.toolRead).toMatchObject({ captured: 2, pairs: 1 });
    expect(r.reply).toMatch(/Possibly/);
    expect(r.reply).toMatch(/own PayPal capture ID/);
  });
  it('approval limit: the configured €75, no invented remaining amount, shopping budget kept separate', async () => {
    const { a } = await elder('on');
    const r = (await say(a, 'What is my spending approval limit?').expect(200)).body;
    expect(r.tool).toBe('spending_limit');
    expect(r.reply).toMatch(/€75\.00 per purchase/);
    expect(r.reply).toMatch(/no amount “left”/);
    expect(r.reply).toMatch(/only sorts search results/);
  });
  it('"Can I transfer money to my grandson?" -> hand-off only, limit facts, evidence from records', async () => {
    const { a } = await elder('on');
    const r = (await say(a, 'Can I transfer money to my grandson?').expect(200)).body;
    expect(r.tool).toBe('transfer_check');
    expect(r.reply).toMatch(/SaySafe never sends money/);
    expect(r.reply).toMatch(/not in your trusted contacts/);
    expect(r.reply).toMatch(/no previous payments/);
    expect(r.companion.link.href).toMatch(/^https:\/\/www\.paypal\.com\//);
  });
  it('payment evidence: first time vs history, unusually high vs usual, contact or not; never "safe"', async () => {
    const { a } = await elder('off');
    await a.post('/api/companion/payments').set(H).send({ recipient: 'Pat Doyle', amountCents: 4000, paidOn: '2026-10-01', method: 'cash' }).expect(201);
    await a.post('/api/companion/payments').set(H).send({ recipient: 'Pat Doyle', amountCents: 4500, paidOn: '2026-10-15', method: 'cash' }).expect(201);
    const known = (await say(a, 'Is it safe to pay Pat Doyle €45?').expect(200)).body;
    expect(known.reply).toMatch(/2 records of paying Pat Doyle/i);
    expect(known.reply).toMatch(/within what you usually pay/);
    expect(known.reply).toMatch(/not in your trusted contacts/);
    const high = (await say(a, 'Is it safe to pay Pat Doyle €900?').expect(200)).body;
    expect(high.reply).toMatch(/unusually high for you/);
    const stranger = (await say(a, 'Should I pay Bob Smith €200?').expect(200)).body;
    expect(stranger.reply).toMatch(/no previous payments to Bob Smith/i);
    for (const x of [known, high, stranger]) expect(x.reply).not.toMatch(/\b(is|looks) safe\b|safe to pay\b/i);
  });
  it('"I trust Margaret" only suggests (confirm card); contacts unchanged until the tap', async () => {
    const { a, hh } = await elder('off');
    const before = Number((db.prepare('SELECT COUNT(*) AS n FROM companion_contacts WHERE household_id=?').get(hh) as any).n);
    const r = (await say(a, 'I trust Margaret').expect(200)).body;
    expect(r.companion).toMatchObject({ kind: 'contact_suggest', name: 'Margaret', state: 'ask' });
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM companion_contacts WHERE household_id=?').get(hh) as any).n)).toBe(before);
    // "I like Alex" (a saved contact) is never saved as a brand preference.
    await a.post('/api/companion/contacts').set(H).send({ name: 'Alex Byrne', relation: 'son' }).expect(201);
    const m = (await say(a, 'I like Alex').expect(200)).body;
    expect(m.memory?.saved).not.toBe(true);
    expect((await a.get('/api/memory')).body.items.some((i: any) => /alex/i.test(i.value))).toBe(false);
  });
  it('read-only financial questions never create or capture an order', async () => {
    const { a, hh } = await elder('on');
    const n0 = payRows(hh);
    for (const q of ['Show me all my transactions', 'Did I pay for the microwave?', 'Was I charged twice?', 'How much have I spent this month?', 'Show my latest receipt', 'What is my spending approval limit?', 'Can I transfer money to my grandson?', 'Show me pending payments']) await say(a, q).expect(200);
    expect(payRows(hh)).toBe(n0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE household_id=? AND paypal_capture_id IS NOT NULL AND example=0").get(hh)).toMatchObject({ n: 0 });
  });
});

describe('family privacy', () => {
  it('Alex (family session only) gets a privacy answer and none of Mary\'s memory, preferences or transactions', async () => {
    const { a } = await elder('on');
    await say(a, 'I prefer purple').expect(200);
    await a.post('/api/demo/alex').set(H).send({}).expect(200);
    const cookies = (a as any).jar.getCookies({ domain: '127.0.0.1', path: '/', script: false, secure: false }).map((c: any) => c.toString()) as string[];
    const fam = cookies.find((c) => c.startsWith('ss_family='));
    expect(fam).toBeTruthy();
    for (const q of ['What do you remember about me?', 'What are my preferences?', 'Show me all my transactions', 'Was I charged twice?']) {
      const r = (await request(app).post('/api/assistant').set(H).set('Cookie', fam!.split(';')[0]).send({ text: q }).expect(200)).body;
      expect(r.reply).toMatch(/private/);
      expect(JSON.stringify(r)).not.toMatch(/purple|black|€150|Hearthside|payment_history/);
    }
    await request(app).get('/api/memory').set('Cookie', fam!.split(';')[0]).expect(404);
  });
});

describe('understanding fallback: model first, then ONE specific question (no generic starters)', () => {
  it('the model can choose a read-only tool; the server still answers from records', async () => {
    const { a } = await elder('on');
    modelIntent = { action: 'transactions', mode: 'list', period: 'all', reply: 'Here they are.' };
    const r = (await say(a, 'umm the money things i did, all of them').expect(200)).body;
    expect(r).toMatchObject({ tool: 'transactions', ai: true });
    expect(r.reply).toMatch(/payment records/);
  });
  it('"I didn\'t catch that" from the model becomes a question about the user\'s words', async () => {
    const { a } = await elder('on');
    modelIntent = { action: 'chat', reply: "I didn't catch that." };
    const r = (await say(a, 'blorp the wizzle sprocket').expect(200)).body;
    expect(r.tool).toBe('clarify');
    expect(r.reply).toMatch(/“blorp the wizzle sprocket”/);
    expect(r.reply).not.toMatch(/ps5|grandson|kettle|Did I already pay/i);
  });
  it('the model saying "chat" for an obvious product request still searches', async () => {
    const { a } = await elder('on');
    modelIntent = { action: 'chat', reply: 'Okay.' };
    const r = (await say(a, 'could you possibly look up some garden chairs for me').expect(200)).body;
    expect(r.tool).toBe('channel3_search');
  });
  it('without AI the rules still search for products and ask instead of a generic menu', () => {
    expect(fallbackIntent('I want to buy a PS5 for my grandson')).toMatchObject({ action: 'shop', query: 'ps5' });
    const c = fallbackIntent('wibble wobble');
    expect(c.action).toBe('clarify');
    expect(c.reply).not.toMatch(/I can help you shop, check a message, or find trusted help/);
  });
});
