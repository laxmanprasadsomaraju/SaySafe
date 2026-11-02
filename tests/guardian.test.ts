import { describe, it, expect, vi } from 'vitest';
// AI provider is a TEST DOUBLE here only: it simulates the model's opinion so the merge logic is tested.
let aiOpinion: any = 'suspicious';
vi.mock('../server/ai/provider', () => ({
  aiConfigured: () => true,
  chat: vi.fn(),
  chatJSON: vi.fn(async () => ({ data: { verdict: aiOpinion, reasons: ['Model doubt'], spoken_summary: 'model words' }, provider: 'test', model: 'test' })),
}));
vi.mock('../server/scam/reputation', () => ({ checkReputation: async () => [] }));
import { scanMessage } from '../server/scam/guardian';

describe('guardian verdict merge', () => {
  const official = 'https://www.paypal.com/ie/security/report-suspicious-messages';
  it('rules-verified + AI suspicious -> needs_verification', async () => {
    aiOpinion = 'suspicious';
    const r = await scanMessage(official);
    expect(r.verdict).toBe('needs_verification');
    expect(r.spokenSummary).not.toBe('model words'); // spoken text follows the final verdict
  });
  it('rules-verified + AI verified stays verified', async () => {
    aiOpinion = 'verified_official_contact';
    expect((await scanMessage(official)).verdict).toBe('verified_official_contact');
  });
  it('AI can never upgrade a suspicious message', async () => {
    aiOpinion = 'verified_official_contact';
    expect((await scanMessage('URGENT your account is locked, pay a fee at http://paypa1-secure.top/verify')).verdict).toBe('suspicious');
  });
});
