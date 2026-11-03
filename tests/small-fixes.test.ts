/** Small wording fixes found in the release review. */
import { describe, it, expect } from 'vitest';
import { asSentence, scanMessage } from '../server/scam/guardian';
import { readFileSync } from 'node:fs';

describe('spoken scam summary grammar', () => {
  it('noun-phrase signal titles never follow "It" ("It a phone number…")', () => {
    expect(asSentence('a phone number next to an unexpected charge')).toBe('Warning sign: a phone number next to an unexpected charge.');
    expect(asSentence('it asks you to pay or send money')).toBe('It asks you to pay or send money.');
  });
  it('rules-only spoken summaries contain no "It a"/"It the" fragments', async () => {
    const r = await scanMessage('PayPal: You have a new invoice from Geek Support Services. Norton renewal €389.99 paid automatically today. If you did not authorise this payment, call PayPal Billing on +44 20 7946 0999 within 24 hours to cancel.', { userName: 'Mary' });
    expect(r.spokenSummary).not.toMatch(/\bIt (a|an|the|this)\b/);
  });
});

describe('send-money footnote', () => {
  it('the sentence is not break-all (no "kn ow" splits) and says nothing was checked or sent', () => {
    const src = readFileSync('web/src/assistant/companionCards.tsx', 'utf8');
    const line = src.split('\n').find((l) => l.includes('data-testid="send-footnote"'))!;
    expect(line).toMatch(/className="[^"]*break-words/);
    expect(line).not.toMatch(/<p className="[^"]*break-all/);
    expect(line).toMatch(/hasn’t checked that this is the right person or amount, and nothing has been sent/);
  });
});
