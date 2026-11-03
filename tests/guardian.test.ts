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
  it('no warning signs + AI suspicious -> needs_checking (AI raises one step)', async () => {
    aiOpinion = 'suspicious';
    const r = await scanMessage(official);
    expect(r.verdict).toBe('needs_checking');
    expect(r.aiReasons).toEqual(['Model doubt']);
  });
  it('needs checking + AI suspicious -> suspicious', async () => {
    aiOpinion = 'suspicious';
    expect((await scanMessage('Kilkee Swim Club requested €15.00 EUR from you.')).verdict).toBe('suspicious');
  });
  it('no warning signs + AI needs_verification stays, with the disclosure', async () => {
    aiOpinion = 'needs_verification';
    const r = await scanMessage(official);
    expect(r.verdict).toBe('no_obvious_warning_signs');
    expect(r.disclosure).toMatch(/can't confirm who sent this/);
    expect(r.spokenSummary).not.toBe('model words'); // spoken text follows the final verdict and disclosure
  });
  it('AI can never grant the all-clear', async () => {
    aiOpinion = 'no_obvious_warning_signs';
    expect((await scanMessage('Your parcel is ready. Pay the €2 customs fee today.')).verdict).toBe('needs_checking');
  });
  it('AI can never lower a rule-based Suspicious', async () => {
    aiOpinion = 'needs_verification';
    expect((await scanMessage('URGENT your account is locked, pay a fee at http://paypa1-secure.top/verify')).verdict).toBe('suspicious');
  });
});
