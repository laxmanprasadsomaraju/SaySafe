import { describe, it, expect, vi } from 'vitest';
// AI provider is a TEST DOUBLE here only: it simulates the model's (already schema-checked) answer so the
// evidence gate and the raise-only merge are tested.
let aiData: any = null;
vi.mock('../server/ai/provider', async (orig) => {
  const real: any = await orig();
  return { ...real, aiConfigured: () => true, chat: vi.fn(), chatJSON: vi.fn(async () => ({ data: aiData, provider: 'test', model: 'test', attempts: 1 })) };
});
vi.mock('../server/scam/reputation', () => ({ checkReputation: async () => [] }));
import { scanMessage } from '../server/scam/guardian';

const reason = (category: string, quote: string, explanation = 'These words ask for something risky.') => ({ category, quote, explanation });

describe('guardian: AI raises only with validated evidence', () => {
  const official = 'https://www.paypal.com/ie/security/report-suspicious-messages';
  it('no warning signs + AI suspicious with NO reasons -> unchanged (no evidence, no effect)', async () => {
    aiData = { verdict: 'suspicious', reasons: [] };
    const r = await scanMessage(official);
    expect(r.verdict).toBe('no_obvious_warning_signs');
    expect(r.aiReasons).toEqual([]);
    expect(r.disclosure).toBe("No concerning signs were found in what you shared. This isn't a guarantee it's safe.");
  });
  it('a quote that is not in the message is dropped, and then the AI has no effect', async () => {
    aiData = { verdict: 'suspicious', reasons: [reason('urgency_or_threat', 'act within 24 hours or lose access')] };
    const r = await scanMessage('Hi Mary Kelly, here is your October summary. Open the PayPal app to see your full activity.');
    expect(r.verdict).toBe('no_obvious_warning_signs');
    expect(r.ai.droppedReasons?.[0]?.why).toBe('quote_not_found');
    expect(r.evidence.ai).toEqual([]);
  });
  it('vague possibilities are not evidence', async () => {
    aiData = { verdict: 'suspicious', reasons: [reason('impersonation', 'Kilkee Swim Club requested', 'It could be someone pretending to be the club.')] };
    const r = await scanMessage('Kilkee Swim Club requested €15.00 EUR from you via PayPal.');
    expect(r.verdict).toBe('needs_checking');
    expect(r.ai.droppedReasons?.map((d) => d.why)).toEqual(['quote_does_not_show_category']);
    aiData = { verdict: 'suspicious', reasons: [reason('payment_request', 'requested €15.00 EUR', 'This might be unusual.')] };
    expect((await scanMessage('Kilkee Swim Club requested €15.00 EUR from you via PayPal.')).ai.droppedReasons?.[0]?.why).toBe('vague');
  });
  it('a quote must show its category ("Don\'t share it" is not a code request)', async () => {
    aiData = { verdict: 'suspicious', reasons: [reason('code_or_password_request', "Don't share it with anyone")] };
    const r = await scanMessage("PayPal: 482913 is your security code. Don't share it with anyone.");
    expect(r.verdict).toBe('needs_checking');
    expect(r.ai.raised).toBe(false);
  });
  it('a valid quote raises No obvious warning signs to Needs checking (one step only)', async () => {
    aiData = { verdict: 'suspicious', reasons: [reason('prize_or_too_good', 'Free holiday for two', 'It offers a big prize out of nowhere.')] };
    const r = await scanMessage('Free holiday for two in Lanzarote, reply YES to accept.');
    expect(r.verdict).toBe('needs_checking');
    expect(r.ai.raised).toBe(true);
    expect(r.evidence.ai[0]).toMatchObject({ category: 'prize_or_too_good', quote: 'Free holiday for two' });
  });
  it('Needs checking -> Suspicious only with a valid DECEPTIVE category, not "asks for money"', async () => {
    const text = 'Hey! Total was €64. Can you send me your €32 when you get a chance?';
    aiData = { verdict: 'suspicious', reasons: [reason('payment_request', 'Can you send me your €32', 'It asks you to send money.')] };
    expect((await scanMessage(text)).verdict).toBe('needs_checking');
    const t2 = 'Hey, can you send me €32? Do not tell Mum about this.';
    aiData = { verdict: 'suspicious', reasons: [reason('secrecy', 'Do not tell Mum', 'It asks you to hide it from family.')] };
    expect((await scanMessage(t2)).verdict).toBe('suspicious');
  });
  it('a link host counts as a quote', async () => {
    aiData = { verdict: 'needs_checking', reasons: [reason('suspicious_link', 'hollowbooks.ie', 'The link goes to a shop website.')] };
    const r = await scanMessage('Thanks for your order. Track it at hollowbooks.ie/orders');
    expect(r.ai.droppedReasons).toEqual([]);
    expect(r.evidence.ai.length).toBe(1);
  });
  it('AI can never lower a rule-based Suspicious, nor grant the all-clear', async () => {
    aiData = { verdict: 'no_extra_concern', reasons: [] };
    expect((await scanMessage('URGENT your account is locked, pay a fee at http://paypa1-secure.top/verify')).verdict).toBe('suspicious');
    expect((await scanMessage('Your parcel is ready. Pay the €2 customs fee today.')).verdict).toBe('needs_checking');
  });
  it('the result carries three evidence classes and never says "verified" about sender, payment or merchant', async () => {
    aiData = { verdict: 'no_extra_concern', reasons: [] };
    const r = await scanMessage('PayPal invoice €399.99, due on receipt. https://www.paypal.com/invoice/p/#INV2-1 Questions? Call +1 888 555 0101');
    expect(r.evidence.observable.map((o) => o.kind)).toEqual(expect.arrayContaining(['link', 'phone', 'amount']));
    expect(r.evidence.observable.find((o) => o.kind === 'link')!.text).toMatch(/not who sent it/);
    expect(r.evidence.rule.length).toBeGreaterThan(0);
    const all = JSON.stringify([r.evidence, r.couldNotVerify, r.headline, r.spokenSummary, r.signals.map((s) => s.title)]);
    expect(all).not.toMatch(/(?<!not |cannot |can't |un)verified/i);
  });
});
