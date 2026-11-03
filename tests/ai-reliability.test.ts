/**
 * AI reliability: bounded timeouts, at most one retry on 429/5xx honouring Retry-After, per-session rate
 * limit, daily usage cap, and honest fallbacks (rule checks only for scans; no made-up products for shopping).
 * The model and Channel3 are simulated with a stubbed global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import path from 'node:path';

vi.hoisted(() => {
  process.env.GROQ_API_KEY = 'test-key-not-real';
  process.env.CHANNEL3_API_KEY = 'test-key-not-real';
  process.env.AI_FALLBACK_BASE_URL = '';
  process.env.AI_TEXT_TIMEOUT_MS = '80';
  process.env.AI_VISION_TIMEOUT_MS = '80';
  process.env.AI_STT_TIMEOUT_MS = '80';
  process.env.AI_SESSION_LIMIT_PER_MIN = '4';
});

vi.mock('../server/paypal/client', () => ({
  paypalConfigured: () => true, createOrder: vi.fn(), getOrder: vi.fn(), captureOrder: vi.fn(), refundCapture: vi.fn(),
  verifyWebhook: vi.fn(async () => false), isUnknownOutcome: () => true, approveLink: () => null,
}));

type Mode = { kind: 'ok'; content: string } | { kind: 'status'; status: number; retryAfter?: string } | { kind: 'hang' };
let script: Mode[] = [];
let calls: string[] = [];
let channel3: 'ok' | 'down' = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url);
  if (url.includes('api.groq.com')) {
    calls.push(url);
    const m = script.length > 1 ? script.shift()! : script[0] ?? { kind: 'status', status: 500 };
    if (m.kind === 'hang') {
      return new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (m.kind === 'status') return new Response('{"error":"x"}', { status: m.status, headers: m.retryAfter ? { 'retry-after': m.retryAfter } : {} });
    const body = url.includes('/audio/') ? { text: m.content } : { choices: [{ message: { content: m.content } }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('trychannel3.com')) return channel3 === 'down' ? new Response('upstream', { status: 503 }) : new Response('{"products":[]}', { status: 200 });
  return new Response('nf', { status: 404 });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

import { chat, transcribe, AIUnavailableError, __resetAiUsage, aiUsage } from '../server/ai/provider';
import { createApp } from '../server/app';
import { PRODUCTS } from '../server/catalogue/products';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
const msg = [{ role: 'user' as const, content: 'hi' }];
async function elder() {
  const a = request.agent(app);
  await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200);
  return a;
}

beforeEach(() => { script = []; calls = []; channel3 = 'ok'; __resetAiUsage(); delete process.env.AI_DAILY_LIMIT; });

describe('provider: timeouts and retries', () => {
  it('a hanging model call is aborted by the bounded timeout and not retried', async () => {
    script = [{ kind: 'hang' }];
    const t0 = Date.now();
    await expect(chat(msg)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(calls.length).toBe(1);
  });

  it('429 with Retry-After is retried exactly once', async () => {
    script = [{ kind: 'status', status: 429, retryAfter: '0' }, { kind: 'ok', content: 'hello' }];
    expect((await chat(msg)).text).toBe('hello');
    expect(calls.length).toBe(2);
  });

  it('a Retry-After longer than the cap is not waited for (fallback instead)', async () => {
    script = [{ kind: 'status', status: 429, retryAfter: '120' }];
    const t0 = Date.now();
    await expect(chat(msg)).rejects.toThrow(/429/);
    expect(calls.length).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('5xx is retried at most once; 4xx is not retried', async () => {
    script = [{ kind: 'status', status: 503 }];
    await expect(chat(msg)).rejects.toThrow(/503/);
    expect(calls.length).toBe(2);
    calls = []; script = [{ kind: 'status', status: 400 }];
    await expect(chat(msg)).rejects.toThrow(/400/);
    expect(calls.length).toBe(1);
  });

  it('speech-to-text has a bounded timeout and the same single retry', async () => {
    script = [{ kind: 'hang' }];
    await expect(transcribe(Buffer.from('x'), 'audio/webm')).rejects.toThrow();
    expect(calls.length).toBe(1);
    calls = []; script = [{ kind: 'status', status: 500 }, { kind: 'ok', content: 'find me a kettle' }];
    expect(await transcribe(Buffer.from('x'), 'audio/webm')).toBe('find me a kettle');
    expect(calls.length).toBe(2);
  });

  it('the daily usage cap (AI_DAILY_LIMIT) stops model calls without calling the provider', async () => {
    process.env.AI_DAILY_LIMIT = '1';
    script = [{ kind: 'ok', content: 'one' }];
    expect((await chat(msg)).text).toBe('one');
    await expect(chat(msg)).rejects.toBeInstanceOf(AIUnavailableError);
    expect(calls.length).toBe(1);
    expect(aiUsage()).toMatchObject({ calls: 1, limit: 1 });
  });
});

describe('honest fallbacks when the model fails', () => {
  it('scan returns the deterministic rule result labelled "AI unavailable — rule checks only" with safe next steps', async () => {
    const e = await elder();
    script = [{ kind: 'status', status: 500 }];
    const r = await e.post('/api/scan').set(H).send({ text: 'PayPal: your account is limited. Verify now at http://paypa1-secure.com/login' }).expect(200);
    expect(r.body.aiNotice).toBe('AI unavailable — rule checks only');
    expect(r.body.ai.used).toBe(false);
    expect(r.body.aiReasons).toEqual([]);
    expect(r.body.verdict).toBe('suspicious');
    expect(r.body.safeActions.length).toBeGreaterThan(0);
    expect(r.body.spokenSummary).toMatch(/don't click any links|PayPal's official help/i);
  });

  it('screenshot reading failure says so plainly (no invented assessment)', async () => {
    const e = await elder();
    script = [{ kind: 'status', status: 500 }];
    const r = await e.post('/api/scan/image').attach('image', path.resolve('tests/fixtures/injection-invoice.png')).expect(503);
    expect(r.body.aiNotice).toBe('AI unavailable — rule checks only');
    expect(r.body).not.toHaveProperty('verdict');
  });

  it('assistant falls back to rules; shop results are real catalogue items only', async () => {
    const e = await elder();
    script = [{ kind: 'status', status: 500 }];
    const r = await e.post('/api/assistant').set(H).send({ text: 'find me a kettle' }).expect(200);
    expect(r.body.ai).toBe(false);
    expect(r.body.intent.action).toBe('shop');
    for (const p of r.body.products) expect(PRODUCTS.some((x) => x.id === p.id && x.priceCents === p.priceCents)).toBe(true);
  });

  it('discovery failure returns "I couldn\'t get recommendations right now" and no products', async () => {
    const e = await elder();
    script = [{ kind: 'status', status: 500 }];
    channel3 = 'down';
    const r = await e.post('/api/discover').set(H).send({ text: 'toaster' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body.message).toMatch(/I couldn't get recommendations right now/);
    expect(r.body.products).toEqual([]);
  });
});

describe('rate limits', () => {
  it('per-session limit on AI routes: one session is throttled, another is not', async () => {
    const a = await elder(); const b = await elder();
    script = [{ kind: 'status', status: 500 }];
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await a.post('/api/assistant').set(H).send({ text: 'hello' })).status);
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses[4]).toBe(429);
    await b.post('/api/assistant').set(H).send({ text: 'hello' }).expect(200);
  });
});
