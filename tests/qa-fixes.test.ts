/** QA fixes (2026-11-03): spaced Irish numbers and a trailing full stop in the phone extractor, the contact-mismatch
 * summary's sentence case, and the payment-matches card no longer repeating its warning and scope note. */
import { describe, it, expect } from 'vitest';
import { extractPhones } from '../server/scam/evidence';
import { extract } from '../server/scam/rules';
import { checkContacts } from '../server/scam/contactMismatch';
import { contactMismatchSummary } from '../server/scam/guardian';
import { matchesCardText, MATCHES_SCOPE_NOTE } from '../web/src/assistant/companion';

const raw = (s: string) => extractPhones(s).map((p) => p.raw);

describe('phone extractor: spaced Irish numbers and full stops', () => {
  it.each([
    ['Hi Mum its Tom new number 087 999 1111.', '087 999 1111'],
    ['New number: 087 999 1111.', '087 999 1111'],
    ['my number is 087 999 1111.', '087 999 1111'],
    ['number 087 999 1111. Thanks', '087 999 1111'],
    ['Ring me on 0879991111.', '0879991111'],
    ['Call 087-999-1111.', '087-999-1111'],
    ['Call +353 87 999 1111.', '+353 87 999 1111'],
    ['Text 083 123 4567.Thanks', '083 123 4567'],
  ])('%s', (text, want) => { expect(raw(text)).toEqual([want]); });

  it('still ignores ids, dates and amounts', () => {
    expect(raw('Order no. 12345678.')).toEqual([]);
    expect(raw('Transaction ID 12345678901.')).toEqual([]);
    expect(raw('account number 12345678.')).toEqual([]);
    expect(raw('Date 2026-11-02, total €1,234.56.')).toEqual([]);
  });

  it('the contact check sees the spaced number and flags the mismatch', () => {
    const text = 'Hi Mum its Tom new number 087 999 1111.';
    const found = extract(text);
    expect(found.phones).toEqual(['087 999 1111']);
    const r = checkContacts(text, found, [{ name: 'Tom', relation: 'son', phone: '+353 87 123 4567', email: null }]);
    expect(r.check?.kind).toBe('mismatch');
  });
});

describe('contact-mismatch summary sentence case', () => {
  it('starts the rest of the summary with a capital letter', () => {
    const s = contactMismatchSummary('Mary', { title: "This says it's from Tom, but the number isn't the one you saved", detail: 'Call Tom on the number you saved.' }, "Mary, this message looks suspicious. Please don't click any links.");
    expect(s).toBe("Mary, this says it's from Tom, but the number isn't the one you saved. Call Tom on the number you saved. This message looks suspicious. Please don't click any links.");
    expect(s).not.toMatch(/\. this message/);
  });
});

describe('payment-matches card text is not repeated', () => {
  const r = {
    guidance: "I found a record that may match. A record you typed is not proof the money arrived. Don't pay again until you've checked with John.",
    notes: ['More than one person matches "John". Check which one you mean.', 'SaySafe only knows Demo Shop payments made in this app and records you typed in. It cannot see your bank or your PayPal wallet.'],
  };
  it('drops the "Don\'t pay again" sentence (it is the heading) and the scope note (it is the footer)', () => {
    const t = matchesCardText(r);
    expect(t.guidance).toBe('I found a record that may match. A record you typed is not proof the money arrived.');
    expect(t.notes).toEqual(['More than one person matches "John". Check which one you mean.']);
    expect(MATCHES_SCOPE_NOTE).toMatch(/^SaySafe only knows SaySafe Demo Shop payments/);
  });
  it('keeps "no match" guidance untouched', () => {
    const g = "I couldn't find a record of paying John. That doesn't mean you haven't paid. Check your bank statement, or ask John, before you pay.";
    expect(matchesCardText({ guidance: g, notes: [] }).guidance).toBe(g);
  });
});
