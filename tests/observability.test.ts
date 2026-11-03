/**
 * Observability: correlation ids, structured error codes, redaction, cheap /api/ping, cached /api/health with
 * counters and no secrets. External services are TEST DOUBLES (global fetch is stubbed and counted).
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';

vi.hoisted(() => {
  process.env.GROQ_API_KEY = 'gsk_testsecretvalue1234567890';
  process.env.AI_FALLBACK_BASE_URL = '';
  process.env.PAYPAL_CLIENT_ID = 'paypal-client-id-not-real';
  process.env.PAYPAL_CLIENT_SECRET = 'paypal-secret-not-real-0123456789';
  process.env.ADMIN_TOKEN = 'admin-token-not-real-0123456789';
});
const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const url = String(typeof input === 'string' ? input : input?.url);
  calls.push(url);
  if (url.endsWith('/models')) return new Response('{"data":[]}', { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

import { createApp } from '../server/app';
import { redact, count, metrics } from '../server/obs';
import { __resetHealthCache } from '../server/ai/provider';

const app = createApp();
const H = { 'Content-Type': 'application/json' };

describe('correlation ids and structured errors', () => {
  it('every response carries X-Request-Id; a safe incoming id is kept, an unsafe one replaced', async () => {
    const a = await request(app).get('/api/ping').expect(200);
    expect(a.headers['x-request-id']).toMatch(/^req_[0-9a-f]{16}$/);
    const b = await request(app).get('/api/ping').set('X-Request-Id', 'client-trace-12345678').expect(200);
    expect(b.headers['x-request-id']).toBe('client-trace-12345678');
    const c = await request(app).get('/api/ping').set('X-Request-Id', 'bad id <script>').expect(200);
    expect(c.headers['x-request-id']).toMatch(/^req_/);
  });
  it('API failures carry a stable error code and the request id (distinguishable from an empty result)', async () => {
    const e = request.agent(app);
    await e.post('/api/demo/start').set(H).send({}).expect(200);
    const nf = await e.get('/api/payments/pay_doesnotexist').expect(404);
    expect(nf.body).toMatchObject({ error: 'not_found' });
    expect(nf.body.requestId).toBe(nf.headers['x-request-id']);
    const bad = await e.post('/api/family/policy').set(H).send({ thresholdEur: 'x' });
    expect(bad.status).toBe(401);
    const inv = await e.post('/api/quote').set(H).send({ items: 'nope' }).expect(400);
    expect(inv.body).toMatchObject({ error: 'bad_cart', requestId: inv.headers['x-request-id'] });
    const json = await request(app).post('/api/scan').set(H).send('{broken').expect(400);
    expect(json.body.error).toBe('invalid_json');
    // An empty list is a 200 with an empty array, never an error code.
    const list = await e.get('/api/companion/payments').expect(200);
    expect(list.body.error).toBeUndefined();
  });
});

describe('ping and health', () => {
  it('/api/ping makes no external call and no database call', async () => {
    const before = calls.length;
    for (let i = 0; i < 5; i++) await request(app).get('/api/ping').expect(200);
    expect(calls.length).toBe(before);
  });
  it('/api/health caches the external AI check (one upstream call for repeated health checks)', async () => {
    __resetHealthCache();
    const before = calls.filter((u) => u.endsWith('/models')).length;
    const h1 = await request(app).get('/api/health').expect(200);
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/health').expect(200);
    expect(calls.filter((u) => u.endsWith('/models')).length - before).toBe(1);
    expect(h1.body.db.ok).toBe(true);
    expect(h1.body.ai.cachedAt).toBeTruthy();
    expect(h1.body.webhooks).toMatchObject({ stored: expect.any(Number), unprocessed: expect.any(Number), failed: expect.any(Number) });
    expect(h1.body).toHaveProperty('paypal.counters');
    expect(h1.body).toHaveProperty('reconcile');
  });
  it('/api/health never contains secrets or credentials', async () => {
    const text = JSON.stringify((await request(app).get('/api/health').expect(200)).body);
    for (const s of [process.env.GROQ_API_KEY!, process.env.PAYPAL_CLIENT_SECRET!, process.env.PAYPAL_CLIENT_ID!, process.env.ADMIN_TOKEN!]) expect(text).not.toContain(s);
  });
  it('counters are exposed by name only (no ids, no amounts)', async () => {
    count('paypal.timeouts');
    const h = (await request(app).get('/api/health').expect(200)).body;
    expect(h.paypal.counters.timeouts).toBeGreaterThanOrEqual(1);
    expect(Object.keys(metrics()).every((k) => /^[a-z0-9_.]+$/.test(k))).toBe(true);
  });
});

describe('log redaction', () => {
  it('removes emails, phone numbers, bearer tokens, API keys and secrets', () => {
    const out = redact({ msg: 'Bearer abc.def.ghi failed for mary@example.com, call +44 20 7946 0999', key: 'gsk_abcdefghijklmnop123', password: 'hunter2', 'x-admin-token': 'zzz' });
    expect(out).not.toMatch(/abc\.def\.ghi|mary@example\.com|7946|gsk_abcdefghijklmnop123|hunter2|zzz/);
    expect(out).toMatch(/\[email\]/);
    expect(out).toMatch(/\[number\]/);
  });
});
