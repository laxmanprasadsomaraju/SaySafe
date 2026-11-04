/**
 * Memory polish: long-term memory ON by default (new households, fresh demo visitors, after demo reset) while family
 * sharing stays OFF; "off" stops saving immediately; labelled sample memories (demo seed) Mary can correct, remove,
 * clear; remembered budget/colour applied to Channel3 results and labelled; an explicit request overrides memory;
 * "ignore my preferences"; "Clear conversation" clears only the short context; and "keep answers short" really
 * shortens replies (deterministic trim + a shorter instruction to the existing AI explanation call).
 * Channel3 is a RECORDED FIXTURE (tests/fixtures/channel3-microwave.json); the AI provider is a TEST DOUBLE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fixture from './fixtures/channel3-microwave.json';

vi.hoisted(() => {
  process.env.CHANNEL3_API_KEY = 'test-key-fixture';
  process.env.GROQ_API_KEY = 'test-key-not-real';
  process.env.AI_FALLBACK_BASE_URL = '';
  process.env.COMPANION_LIMIT_PER_MIN = '5000'; process.env.API_LIMIT_PER_MIN = '5000'; process.env.AI_LIMIT_PER_MIN = '5000'; process.env.AI_SESSION_LIMIT_PER_MIN = '5000';
});

const c3: { body: any }[] = [];
const prompts: { system: string; user: string; maxTokens?: number }[] = [];
let chatReply = 'Kettles boil water quickly. Many come in several colours. Some have a simple dial.';
const EXPLAIN = 'It is a solo microwave listed at €99.99 at the shop. It matches your search for a microwave.';
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (url: any, init: any) => {
  const u = String(url);
  if (u.includes('trychannel3.com')) {
    c3.push({ body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/chat/completions')) {
    const b = JSON.parse(String(init?.body ?? '{}'));
    const system = String(b.messages?.find((m: any) => m.role === 'system')?.content ?? '');
    prompts.push({ system, user: String(b.messages?.find((m: any) => m.role === 'user')?.content ?? ''), maxTokens: b.max_tokens ?? b.max_completion_tokens });
    const content = /why a product listing was picked/.test(system) ? EXPLAIN : JSON.stringify({ action: 'chat', reply: chatReply });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
});

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { getSharing } from '../server/family/permissions';
import { shortenText, spokenRecommendation, recommend, parseRequest, EMPTY_PROFILE } from '../shared/shopping';
import { SHORT_INSTRUCTION } from '../server/ai/explain';
import { normaliseProducts } from '../server/catalogue/channel3';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
type Agent = ReturnType<typeof request.agent>;
async function elder(seed: 'on' | 'off' = 'on') {
  const prev = process.env.DEMO_SEED;
  process.env.DEMO_SEED = seed;
  try {
    const a = request.agent(app);
    await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
    const row = db.prepare('SELECT household_id, user_id FROM sessions ORDER BY rowid DESC LIMIT 1').get() as any;
    return { a, hh: row.household_id as string, uid: row.user_id as string };
  } finally { process.env.DEMO_SEED = prev; }
}
const say = (a: Agent, text: string) => a.post('/api/assistant').set(H).send({ text });
let offset = 0;
const realNow = Date.now.bind(Date);
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
let n = 0;
const uniq = () => ` ${['please', 'now', 'today', 'for me', 'thanks', 'again'][n++ % 6]}`;
const discover = (a: Agent, text: string, extra: Record<string, unknown> = {}) => { offset += 11 * 60_000; return a.post('/api/discover').set(H).send({ text, ...extra }); };
const priceOf = (p: any) => Number(p.offers?.[0]?.price);

beforeEach(() => { c3.length = 0; prompts.length = 0; chatReply = 'Kettles boil water quickly. Many come in several colours. Some have a simple dial.'; });

describe('1. defaults: memory ON (disclosed), family sharing OFF', () => {
  it('a new household has memory ON with no saved choice; saving works at once; family sharing switches stay OFF', async () => {
    const { a, hh } = await elder('off');
    const m = (await a.get('/api/memory').expect(200)).body;
    expect(m).toMatchObject({ enabled: true, defaultOn: true, items: [] });
    expect(m.why).toMatch(/on unless you turn it off/i);
    expect(db.prepare('SELECT 1 FROM memory_settings WHERE household_id=?').get(hh)).toBeUndefined(); // the default, not a stored choice
    const r = (await say(a, 'I prefer black').expect(200)).body;
    expect(r.memory).toMatchObject({ saved: true });
    expect(getSharing(hh)).toMatchObject({ shareSummaries: false, shareHistory: false });
  });

  it('turning memory off stops saving immediately and stops using saved preferences; turning it back on uses them again', async () => {
    const { a } = await elder('off');
    await say(a, 'I prefer black');
    await a.put('/api/memory/settings').set(H).send({ enabled: false }).expect(200);
    const r = (await say(a, 'I prefer red').expect(200)).body;
    expect(r.memory).toMatchObject({ saved: false, reason: 'memory_off' });
    const m = (await a.get('/api/memory')).body;
    expect(m.enabled).toBe(false);
    expect(m.items.map((i: any) => i.value)).toEqual(['black']);
    const d = (await discover(a, 'find me a microwave' + uniq()).expect(200)).body;
    expect(c3.at(-1)!.body.query).not.toMatch(/black/);
    expect(d.personalisation).toBeNull();
    // Off still keeps the short conversation context (disclosed): the products shown are there.
    expect(m.context.keptDays).toBe(14);
    expect((await a.get('/api/memory')).body.context.products.length).toBeGreaterThan(0);
  });
});

describe('7. sample memories (demo seed)', () => {
  it('a fresh demo visitor gets two labelled samples, marked in the data; Mary can correct, remove and clear them', async () => {
    const { a, hh, uid } = await elder('on');
    const m = (await a.get('/api/memory').expect(200)).body;
    expect(m.enabled).toBe(true);
    expect(m.items).toHaveLength(2);
    expect(m.items.every((i: any) => i.sample === true && /\(sample\)$/.test(i.label) && i.id.startsWith('mem_sample_'))).toBe(true);
    expect(m.items.map((i: any) => i.label).sort()).toEqual(['Prefers the colour black (sample)', 'Usual budget: up to €150 (sample)']);
    const rows = db.prepare('SELECT id FROM user_memory WHERE household_id=? AND user_id=?').all(hh, uid) as any[];
    expect(rows.every((r) => r.id.startsWith('mem_sample_'))).toBe(true);
    // Correct one -> it becomes Mary's own (no longer a sample).
    const colour = m.items.find((i: any) => i.key === 'colour');
    const edited = (await a.patch(`/api/memory/${colour.id}`).set(H).send({ value: 'navy' }).expect(200)).body;
    expect(edited).toMatchObject({ value: 'navy', sample: false, label: 'Prefers the colour navy' });
    // Remove the other.
    const budget = m.items.find((i: any) => i.category === 'budget');
    await a.delete(`/api/memory/${budget.id}`).expect(200);
    expect((await a.get('/api/memory')).body.items.map((i: any) => i.label)).toEqual(['Prefers the colour navy']);
    // Clear all.
    await a.delete('/api/memory').set(H).send({ confirm: true }).expect(200);
    expect((await a.get('/api/memory')).body.items).toEqual([]);
  });

  it('saying a preference herself replaces the sample (no duplicate, no sample label); demo reset brings the samples back, memory ON', async () => {
    const { a } = await elder('on');
    await say(a, 'I prefer red');
    const items = (await a.get('/api/memory')).body.items;
    const colours = items.filter((i: any) => i.key === 'colour');
    expect(colours).toHaveLength(1);
    expect(colours[0]).toMatchObject({ value: 'red', sample: false, label: 'Prefers the colour red' });
    await a.put('/api/memory/settings').set(H).send({ enabled: false }).expect(200);
    await a.post('/api/demo/reset').set(H).send({}).expect(200);
    const after = (await a.get('/api/memory')).body;
    expect(after.enabled).toBe(true);
    expect(after.items.map((i: any) => i.label).sort()).toEqual(['Prefers the colour black (sample)', 'Usual budget: up to €150 (sample)']);
    expect(after.context.products).toEqual([]);
  });
});

describe('5. Channel3 personalisation from remembered budget and colour', () => {
  it('remembered budget filters and ranks (nothing over €150 shown when listings under it exist) and the line says so, marked as sample', async () => {
    const { a } = await elder('on');
    const d = (await discover(a, 'find me a microwave' + uniq()).expect(200)).body;
    expect(c3.at(-1)!.body.query).not.toMatch(/black/); // Assistant repair: remembered colour ranks, never widens/narrows the query
    expect(d.recommendation.usedProfileBudget).toBe(150);
    expect(d.products.length).toBeGreaterThan(0);
    expect(d.products.every((p: any) => priceOf(p) <= 150)).toBe(true);
    const fixtureOver = (fixture as any).products.filter((p: any) => Number(p.offers?.[0]?.price?.price ?? p.offers?.[0]?.price) > 150).length;
    expect(fixtureOver).toBeGreaterThan(0); // the fixture does have dearer listings: they were filtered out
    const best = d.recommendation.picks.find((k: any) => k.role === 'best');
    expect(priceOf(d.products.find((p: any) => p.id === best.id))).toBeLessThanOrEqual(150);
    expect(d.personalisation.line).toMatch(/^Shown first because you prefer black and under €150 \(sample preferences: change or remove them in Profile\)\./);
    expect(d.personalisation.line).toMatch(/ignore my preferences/);
  });

  it('Mary’s own budget (not a sample) is applied and labelled without the sample note', async () => {
    const { a } = await elder('off');
    await say(a, 'keep my budget below €120');
    const d = (await discover(a, 'find me a microwave' + uniq()).expect(200)).body;
    expect(d.recommendation.usedProfileBudget).toBe(120);
    expect(d.products.every((p: any) => priceOf(p) <= 120)).toBe(true);
    expect(d.personalisation.line).toMatch(/under €120/);
    expect(d.personalisation.line).not.toMatch(/sample/);
  });

  it('an explicit new request overrides memory: “red kettle under €40” beats stored black / €150', async () => {
    const { a } = await elder('on');
    const d = (await discover(a, 'find me a red kettle under €40').expect(200)).body;
    const body = c3.at(-1)!.body;
    expect(body.query).toMatch(/red kettle/);
    expect(body.query).not.toMatch(/black/);
    expect(body.filters?.price?.max_price).toBe(40);
    expect(d.recommendation.usedProfileBudget).toBeNull();
    expect(d.products.every((p: any) => priceOf(p) <= 40)).toBe(true);
    expect(JSON.stringify(d.personalisation ?? '')).not.toMatch(/black|€150/);
  });

  it('a remembered colour added to the query never makes an unrelated listing relevant (black microwave ≠ garden gnome)', async () => {
    const { a } = await elder('on');
    const d = (await discover(a, 'find me a garden gnome').expect(200)).body;
    expect(c3.some((c) => /black/.test(c.body.query))).toBe(false); // the remembered colour is not even sent any more
    expect(d.products).toEqual([]);
  });

  it('“ignore my preferences” re-runs the search without memory: no colour added, no budget, no line', async () => {
    const { a } = await elder('on');
    await discover(a, 'find me a microwave' + uniq()).expect(200);
    const ig = (await say(a, 'ignore my preferences').expect(200)).body;
    expect(ig.discover).toMatchObject({ ignoreMemory: true });
    const d = (await discover(a, String(ig.discover.query) + uniq(), { ignoreMemory: true }).expect(200)).body;
    expect(c3.at(-1)!.body.query).not.toMatch(/black/);
    expect(d.recommendation.usedProfileBudget).toBeNull();
    expect(d.personalisation).toBeNull();
    expect(d.products.some((p: any) => priceOf(p) > 150)).toBe(true);
  });
});

describe('2. “Clear conversation” clears only the short-term context', () => {
  it('DELETE /api/memory {scope:"context"} removes turns and products shown; remembered preferences stay', async () => {
    const { a, hh, uid } = await elder('on');
    await discover(a, 'find me a microwave' + uniq()).expect(200);
    await say(a, 'show me that microwave again');
    expect(Number((db.prepare('SELECT COUNT(*) n FROM conversation_turns WHERE household_id=? AND user_id=?').get(hh, uid) as any).n)).toBeGreaterThan(0);
    const r = (await a.delete('/api/memory').set(H).send({ confirm: true, scope: 'context' }).expect(200)).body;
    expect(r.deleted.products).toBeGreaterThan(0);
    const m = (await a.get('/api/memory')).body;
    expect(m.context).toMatchObject({ turns: 0, products: [] });
    expect(m.items).toHaveLength(2);
    await a.delete('/api/memory').set(H).send({ confirm: true, scope: 'everything' }).expect(400);
  });
});

describe('3. “keep answers short” really shortens replies', () => {
  it('shortenText keeps whole sentences only (prices are never cut)', () => {
    expect(shortenText('It costs €119.99 at Currys. It is black. Would you like more?', 1)).toBe('It costs €119.99 at Currys.');
    expect(shortenText('One. Two. Three.', 2)).toBe('One. Two.');
    expect(shortenText('Just one sentence.', 1)).toBe('Just one sentence.');
  });

  it('spoken recommendation: short drops the reasons and the follow-up question', () => {
    const items = (fixture as any).products;
    const list = normaliseProducts(fixture, 'EUR', null);
    const rec = recommend(list, parseRequest('find me a microwave'), EMPTY_PROFILE);
    const long = spokenRecommendation(list, rec, 'microwave');
    const short = spokenRecommendation(list, rec, 'microwave', { short: true });
    expect(items.length).toBeGreaterThan(1);
    expect(long).toMatch(/Would you like/);
    expect(short).not.toMatch(/I picked it because|Would you like/);
    expect(short).toMatch(/^My best match is the .+, €[\d.,]+ at .+\. You'd buy it on the shop's own website\.$/);
    expect(short.length).toBeLessThan(long.length);
  });

  it('with the preference saved: /api/discover reply is short and the AI explanation gets the short instruction (one sentence); without it, unchanged', async () => {
    const { a } = await elder('off');
    const before = (await discover(a, 'find me a microwave' + uniq()).expect(200)).body;
    expect(before.shortReplies).toBe(false);
    expect(prompts.filter((p) => /why a product listing was picked/.test(p.system)).every((p) => !p.system.includes(SHORT_INSTRUCTION))).toBe(true);
    const r = (await say(a, 'keep answers short').expect(200)).body;
    expect(r.memory).toMatchObject({ saved: true });
    prompts.length = 0;
    const after = (await discover(a, 'find me a microwave' + uniq()).expect(200)).body;
    expect(after.shortReplies).toBe(true);
    expect(after.reply.length).toBeLessThan(before.reply.length);
    expect(after.reply).not.toMatch(/Would you like|I picked it because/);
    const ex = prompts.filter((p) => /why a product listing was picked/.test(p.system));
    expect(ex.length).toBeGreaterThan(0);
    expect(ex.every((p) => p.system.includes(SHORT_INSTRUCTION))).toBe(true);
    if (after.explanation) expect(after.explanation.split(/(?<=[.!?])\s+/).length).toBe(1);
  });

  it('Assistant conversational replies keep their first two sentences when short answers are on; cards and scam checks are never trimmed', async () => {
    const { a } = await elder('off');
    const long = (await say(a, 'tell me something nice about kettles please').expect(200)).body;
    expect(long.intent.action).toBe('chat');
    const sentences = (s: string) => s.split(/(?<=[.!?])\s+(?=[A-Z])/).length;
    expect(sentences(long.reply)).toBe(3);
    await say(a, 'keep answers short');
    const short = (await say(a, 'tell me something nice about kettles please').expect(200)).body;
    expect(short.reply).toBe('Kettles boil water quickly. Many come in several colours.');
    expect(short.intent.reply).toBe(short.reply);
    expect(short.shortened).toBe(true);
    // Turning memory off: the preference is no longer used.
    await a.put('/api/memory/settings').set(H).send({ enabled: false }).expect(200);
    expect(sentences((await say(a, 'tell me something nice about kettles please').expect(200)).body.reply)).toBe(3);
  });
});
