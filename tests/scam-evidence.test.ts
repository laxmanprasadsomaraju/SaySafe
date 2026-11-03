import { describe, it, expect } from 'vitest';
import { analyseText, extract } from '../server/scam/rules';
import { quoteSpan, truncateSafe, escapeHtml, extractPhones, extractLinks, nextStepsFor, couldNotVerify, SAFE_NEXT_STEPS } from '../server/scam/evidence';
import { normalizeVerdict, toLegacyVerdict, decideFromSignals, mergeWithAi } from '../server/scam/verdicts';

const codes = (t: string) => analyseText(t).signals.map((s) => s.code);

describe('old substring bugs are fixed', () => {
  it('"shipping" is not a PIN request', () => expect(codes('Your order is shipping today, free shipping.')).not.toContain('sensitive_request'));
  it('"PayPal" plus an amount is not a payment demand', () => expect(codes('You received €40.00 EUR on PayPal.')).not.toContain('payment_demand'));
  it('"blocked" is not "locked" and "unlimited" is not "limited"', () => {
    expect(codes('Unlimited data plan. Spam calls are blocked.')).not.toContain('urgency');
  });
  it('a warning not to share a code is not a request for one', () => {
    expect(codes('Never share this code with anyone: 112233 is your code')).not.toContain('sensitive_request');
    expect(codes('Please read me the code we just sent you')).toContain('sensitive_request');
  });
});

describe('extraction', () => {
  it('finds scheme-less shorteners and new TLDs', () => {
    expect(extractLinks('go to bit.ly/abc or paypal-help.shop/x now').map((l) => l.raw)).toEqual(['bit.ly/abc', 'paypal-help.shop/x']);
  });
  it('ignores file names, numbers and abbreviations', () => {
    expect(extractLinks('see invoice.pdf, total 3.50, e.g. this')).toEqual([]);
  });
  it('does not treat dates, amounts, times or labelled IDs as phone numbers', () => {
    expect(extractPhones('Date 2026-11-02, total €1,234.56, between 10:00 and 14:00, Transaction ID 12345678901, order 4471-2280-9913')).toEqual([]);
  });
  it('finds real phone shapes', () => {
    expect(extractPhones('call +1 (808) 555-0199 or 087 123 4567').map((p) => p.raw)).toEqual(['+1 (808) 555-0199', '087 123 4567']);
  });
  it('email domains are not links', () => expect(extract('write to someone@example-mail.com').links).toEqual([]));
});

describe('evidence quotes', () => {
  it('quotes the exact span with context, truncated safely', () => {
    const src = 'Hello. ' + 'x '.repeat(100) + 'please read the code back to us ' + 'y '.repeat(100);
    const i = src.indexOf('read the code');
    const q = quoteSpan(src, i, i + 13);
    expect(q).toContain('read the code');
    expect(Array.from(q).length).toBeLessThanOrEqual(142);
  });
  it('strips bidi overrides and zero-width characters', () => {
    expect(truncateSafe('pay\u202Elapyap\u200B.com')).toBe('paylapyap.com');
  });
  it('never splits an emoji', () => expect(truncateSafe('😀'.repeat(10), 5)).toBe('😀😀😀😀…'));
  it('escapes HTML', () => expect(escapeHtml('<img src=x onerror="a">')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;'));
  it('every finding has evidence and a basis', () => {
    const r = analyseText('URGENT: call +1 888 555 0101 now, your PayPal account is limited. Read me the code. bit.ly/x');
    for (const s of r.signals) { expect(s.evidence, s.code).toBeTruthy(); expect(s.basis, s.code).toBe('deterministic_rule'); }
  });
});

describe('verdict policy', () => {
  it('maps legacy codes', () => {
    expect(normalizeVerdict('needs_verification')).toBe('needs_checking');
    expect(normalizeVerdict('verified_official_contact')).toBe('no_obvious_warning_signs');
    expect(normalizeVerdict('something-else')).toBe('needs_checking');
    expect(toLegacyVerdict('no_obvious_warning_signs')).toBe('verified_official_contact');
  });
  it('a genuine paypal.com link cannot produce the all-clear when there is a payment ask, phone, urgency, gift card, remote access, code request or call-to-cancel', () => {
    const asks = ['Pay €50 today', 'Questions: +353 1 555 0100', 'Act now', 'Pay with a gift card', 'Install AnyDesk', 'Send me the verification code', 'Call us to cancel this order'];
    for (const a of asks) expect(analyseText(`${a}. https://www.paypal.com/ie/home`).verdict, a).not.toBe('no_obvious_warning_signs');
  });
  it('payment + phone alone is Needs checking; deceptive + other family is Suspicious', () => {
    expect(decideFromSignals([{ code: 'a', severity: 'medium', family: 'payment' }, { code: 'b', severity: 'medium', family: 'contact' }], [])).toBe('needs_checking');
    expect(decideFromSignals([{ code: 'a', severity: 'medium', family: 'payment' }, { code: 'b', severity: 'medium', family: 'pressure' }], [])).toBe('suspicious');
  });
  it('AI raises but never lowers', () => {
    expect(mergeWithAi('suspicious', { verdict: 'needs_verification' })).toBe('suspicious');
    expect(mergeWithAi('needs_checking', { verdict: 'suspicious' })).toBe('suspicious');
    expect(mergeWithAi('no_obvious_warning_signs', { verdict: 'suspicious' })).toBe('needs_checking');
    expect(mergeWithAi('no_obvious_warning_signs', { verdict: 'needs_verification', asks_for: [] })).toBe('no_obvious_warning_signs');
    expect(mergeWithAi('no_obvious_warning_signs', { verdict: 'needs_verification', asks_for: ['bank card details'] })).toBe('needs_checking');
    expect(mergeWithAi('needs_checking', { verdict: 'no_obvious_warning_signs' })).toBe('needs_checking');
  });
});

describe('next steps and limits', () => {
  it('report step uses the verified PayPal address and page', () => {
    const rep = SAFE_NEXT_STEPS.find((s) => s.id === 'report')!;
    expect(rep.text).toContain('phishing@paypal.com');
    expect(rep.url).toBe('https://www.paypal.com/ie/security/report-suspicious-messages');
  });
  it('suspicious results include reporting and Garda guidance', () => {
    expect(nextStepsFor('suspicious', { links: true, phones: true }).map((s) => s.id)).toEqual(['open-app', 'no-calls', 'no-codes', 'report', 'garda']);
  });
  it('always lists what SaySafe could not verify', () => {
    expect(couldNotVerify({ links: false, phones: false, emails: false, money: false })[0]).toMatch(/Who really sent this/);
  });
});
