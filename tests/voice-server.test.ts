/** Server-side ghost-speech guards and "voice can never pay" checks. Whisper is a test double. */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

const whisper = vi.fn(async () => 'Thank you.');
vi.mock('../server/ai/provider', async (orig) => ({ ...(await orig<typeof import('../server/ai/provider')>()), transcribe: (...a: any[]) => (whisper as any)(...a) }));

import { createApp } from '../server/app';
import { db } from '../server/db/index';
const app = createApp();
const H = { 'Content-Type': 'application/json' };

async function elder() { const a = request.agent(app); await a.post('/api/demo/start').send({}); return a; }

describe('/api/voice/transcribe', () => {
  it('tiny (silent) uploads never reach Whisper', async () => {
    const a = await elder();
    whisper.mockClear();
    const r = await a.post('/api/voice/transcribe').attach('audio', Buffer.alloc(900), { filename: 'speech.webm', contentType: 'audio/webm' });
    expect(r.body).toEqual({ text: '', dropped: 'too_short' });
    expect(whisper).not.toHaveBeenCalled();
  });
  it('drops Whisper\'s silence hallucination unless the browser measured real speech', async () => {
    const a = await elder();
    const r = await a.post('/api/voice/transcribe').field('voicedMs', '200').attach('audio', Buffer.alloc(6000), { filename: 'speech.webm', contentType: 'audio/webm' });
    expect(r.body).toEqual({ text: '', dropped: 'silence_hallucination' });
    const noInfo = await a.post('/api/voice/transcribe').attach('audio', Buffer.alloc(6000), { filename: 'speech.webm', contentType: 'audio/webm' });
    expect(noInfo.body.text).toBe('');
    const real = await a.post('/api/voice/transcribe').field('voicedMs', '2500').attach('audio', Buffer.alloc(6000), { filename: 'speech.webm', contentType: 'audio/webm' });
    expect(real.body.text).toBe('Thank you.');
  });
  it('whitelists the language sent to Whisper', async () => {
    const a = await elder();
    whisper.mockClear();
    await a.post('/api/voice/transcribe').set('X-SaySafe-Lang', 'ga').field('voicedMs', '3000').attach('audio', Buffer.alloc(6000), { filename: 'speech.webm', contentType: 'audio/webm' });
    expect((whisper.mock.calls[0] as any[])[3]).toBe('en');
  });
});

describe('/api/assistant never runs on empty input and never pays', () => {
  it('rejects empty / punctuation-only text before any AI call', async () => {
    const a = await elder();
    expect((await a.post('/api/assistant').set(H).send({ text: '   ' })).status).toBe(400);
    expect((await a.post('/api/assistant').set(H).send({ text: '.' })).status).toBe(400);
  });
  it('a spoken "yes, pay now" creates no payment and approves nothing', async () => {
    const a = await elder();
    const before = (db.prepare('SELECT COUNT(*) n FROM payment_requests').get() as any).n;
    const approvals = (db.prepare("SELECT COUNT(*) n FROM approvals WHERE status='approved'").get() as any).n;
    const r = await a.post('/api/assistant').set(H).send({ text: 'yes, pay now', step: 'review' });
    expect(r.status).toBe(200);
    expect((db.prepare('SELECT COUNT(*) n FROM payment_requests').get() as any).n).toBe(before);
    expect((db.prepare("SELECT COUNT(*) n FROM approvals WHERE status='approved'").get() as any).n).toBe(approvals);
    // Family approval is a family-session-only route; an elder (or voice) can't approve it.
    expect((await a.post('/api/family/requests/x/decision').set(H).send({ decision: 'approve', approvalId: 'appr_123456' })).status).toBe(401);
  });
});
