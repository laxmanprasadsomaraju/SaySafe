/** Payment companion: pure matching rules, date hints, cancel directory, contact_mismatch scam rule. No network, AI off. */
import { describe, it, expect } from 'vitest';
import { searchPayments, nameMatch, parseDateHint, type Candidate } from '../server/companion/match';
import { CANCEL_GUIDES, findCancelGuide } from '../shared/cancelGuides';
import { checkContacts, claimsToBe, phoneKey } from '../server/scam/contactMismatch';
import { scanMessage } from '../server/scam/guardian';
import { COMPANION_LABELS, SUB_TRANSITIONS, CompanionIntentParams } from '../shared/companion';

const manual = (id: string, recipient: string, amountCents: number, date: string, note: string | null = null): Candidate => ({ id, source: 'manual', recipient, description: note, amountCents, currency: 'EUR', date, evidence: { kind: 'manual', label: COMPANION_LABELS.manual, method: 'bank_transfer' } });
const shop = (id: string, amountCents: number, date: string, items = 'Classic Kettle'): Candidate => ({ id, source: 'paypal_sandbox', recipient: 'SaySafe Demo Shop', description: items, amountCents, currency: 'EUR', date, evidence: { kind: 'paypal_sandbox', captureStatus: 'COMPLETED', webhookVerified: true, orderState: 'CAPTURED' } });

describe('name matching', () => {
  it('Jon and John match with a spelling caveat', () => {
    const r = searchPayments([manual('m1', 'Jon Murphy', 8000, '2026-10-01')], { q: 'John Murphy' });
    expect(r.matches.map((m) => m.id)).toEqual(['m1']);
    expect(r.matches[0].caveats.join(' ')).toMatch(/Spelled differently: "john" and "jon"/);
  });
  it('a first name matches a full name, with a partial-name caveat', () => {
    const r = searchPayments([manual('m1', 'John Murphy', 8000, '2026-10-01')], { q: 'John' });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].caveats.join(' ')).toMatch(/Partial name/);
  });
  it('"John Murphy" does not match "John Smith" (surname contradicts)', () => {
    const r = searchPayments([manual('m1', 'John Smith', 8000, '2026-10-01')], { q: 'John Murphy' });
    expect(r.matches).toEqual([]);
    expect(r.guidance).toMatch(/couldn't find a record of paying John Murphy/);
  });
  it('two different Johns are both listed with a note', () => {
    const r = searchPayments([manual('m1', 'John Smith', 5000, '2026-09-01'), manual('m2', 'John Murphy', 8000, '2026-10-01')], { q: 'John' });
    expect(r.matches).toHaveLength(2);
    expect(r.notes.join(' ')).toMatch(/More than one person matches "John"/);
  });
  it('unrelated names do not match', () => {
    expect(nameMatch('Mary', 'John Murphy').score).toBe(0);
    expect(searchPayments([manual('m1', 'Patrick', 8000, '2026-10-01')], { q: 'John' }).matches).toEqual([]);
  });
});

describe('HARD RULE: a person-name query never matches a SaySafe Demo Shop payment', () => {
  it('"John" with the same amount excludes the Demo Shop payment and says why', () => {
    const r = searchPayments([shop('pay_1', 8000, '2026-10-01')], { q: 'John', amountCents: 8000, from: '2026-10-01' });
    expect(r.matches).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/SaySafe Demo Shop payments are not shown: they are shop purchases, not payments to John/);
  });
  it('never returns a Demo Shop payment for any person name, even with a manual John record present', () => {
    for (const q of ['John', 'Jon', 'John Murphy', 'the plumber', 'Mary']) {
      const r = searchPayments([shop('pay_1', 8000, '2026-10-01'), manual('m1', 'John Murphy', 8000, '2026-10-01')], { q, amountCents: 8000 });
      expect(r.matches.some((m) => m.source === 'paypal_sandbox'), q).toBe(false);
    }
  });
  it('a query about the shop or an item it sold can match', () => {
    expect(searchPayments([shop('pay_1', 3200, '2026-10-01')], { q: 'kettle' }).matches[0]?.id).toBe('pay_1');
    expect(searchPayments([shop('pay_1', 3200, '2026-10-01')], { q: 'demo shop' }).matches[0]?.id).toBe('pay_1');
  });
  it('amount-only search may list a Demo Shop payment, labelled as a shop purchase', () => {
    const r = searchPayments([shop('pay_1', 3200, '2026-10-01')], { amountCents: 3200 });
    expect(r.matches[0].evidence).toMatchObject({ kind: 'paypal_sandbox', captureStatus: 'COMPLETED', webhookVerified: true });
    expect(r.guidance).toMatch(/shop purchases, not payments to a person/);
  });
});

describe('amounts, dates, duplicates', () => {
  it('repeated amounts get a caveat', () => {
    const r = searchPayments([manual('m1', 'John Murphy', 8000, '2026-10-01'), manual('m2', 'Plumber', 8000, '2026-08-01')], { q: 'John', amountCents: 8000 });
    expect(r.matches[0].caveats.join(' ')).toMatch(/more than one payment of €80/);
  });
  it('a date a few days off is flagged; far off says more than N days', () => {
    const near = searchPayments([manual('m1', 'John', 8000, '2026-10-03')], { q: 'John', from: '2026-10-01' });
    expect(near.matches[0].caveats.join(' ')).toMatch(/2 days off/);
    const far = searchPayments([manual('m1', 'John', 8000, '2026-10-20')], { q: 'John', amountCents: 8000, from: '2026-10-01' });
    expect(far.matches[0].caveats.join(' ')).toMatch(/off by more than 3 days/);
    expect(far.matches[0].score).toBeLessThan(near.matches[0].score + 0.0001);
  });
  it('a different amount with a matching name still shows, with the difference stated', () => {
    const r = searchPayments([manual('m1', 'John', 7500, '2026-10-01')], { q: 'John', amountCents: 8000 });
    expect(r.matches[0].caveats.join(' ')).toMatch(/Different amount: €75 recorded, €80 asked/);
  });
  it('amount-only search ignores other amounts', () => {
    expect(searchPayments([manual('m1', 'John', 7500, '2026-10-01')], { amountCents: 8000 }).matches).toEqual([]);
  });
  it('possible duplicates are flagged on both records', () => {
    const r = searchPayments([manual('m1', 'John Murphy', 8000, '2026-10-01'), manual('m2', 'john murphy', 8000, '2026-10-02')], { q: 'John Murphy' });
    expect(r.matches).toHaveLength(2);
    for (const m of r.matches) expect(m.caveats.join(' ')).toMatch(/Possible duplicate/);
  });
  it('manual records always say they are not verified, and guidance never says "paid"', () => {
    const r = searchPayments([manual('m1', 'John', 8000, '2026-10-01')], { q: 'John' });
    expect(r.matches[0].caveats.join(' ')).toMatch(/Recorded by you, not verified/);
    expect(r.guidance).toMatch(/Don't pay again until you've checked with John/);
    expect(r.guidance).not.toMatch(/\byou (have )?paid\b/i);
  });
});

describe('date hints', () => {
  const today = new Date('2026-11-03T10:00:00Z');
  it.each([
    ['1 Oct', { from: '2026-10-01', to: '2026-10-01' }],
    ['October 1st', { from: '2026-10-01', to: '2026-10-01' }],
    ['yesterday', { from: '2026-11-02', to: '2026-11-02' }],
    ['last month', { from: '2026-10-01', to: '2026-10-31' }],
    ['in December', { from: '2025-12-01', to: '2025-12-31' }],
  ])('%s', (h, w) => expect(parseDateHint(h, today)).toEqual(w));
  it('unreadable hints give no window', () => expect(parseDateHint('around the time of the match', today)).toBeNull());
});

describe('cancellation directory', () => {
  it('has 8 official https guides, each verified on a date', () => {
    expect(CANCEL_GUIDES).toHaveLength(8);
    for (const g of CANCEL_GUIDES) { expect(g.url.startsWith('https://')).toBe(true); expect(g.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
  });
  it('finds guides by what people say', () => {
    expect(findCancelGuide('Netflix Premium')?.id).toBe('netflix');
    expect(findCancelGuide('Amazon Prime Video')?.id).toBe('amazon_prime');
    expect(findCancelGuide('disney+')?.id).toBe('disney_plus');
    expect(findCancelGuide('Sky Sports')?.id).toBe('sky_ireland');
    expect(findCancelGuide('Bord Gáis')).toBeNull();
  });
  it('external subscriptions can never be moved to provider_confirmed by the user', () => {
    for (const to of Object.values(SUB_TRANSITIONS)) expect(to).not.toContain('provider_confirmed');
  });
});

describe('scam rule contact_mismatch', () => {
  const son = { name: 'Tom', relation: 'son', phone: '087 123 4567', email: 'tom@example.ie' };
  it('phone numbers compare across +353 / 00353 / 08x forms', () => {
    expect(phoneKey('+353 87 123 4567')).toBe(phoneKey('087 123 4567'));
    expect(phoneKey('00353871234567')).toBe(phoneKey('0871234567'));
  });
  it('recognises claims by relation and by name', () => {
    expect(claimsToBe("Hi Mum it's me, this is my new number", son)).toBeTruthy();
    expect(claimsToBe('It is your son here', son)).toBeTruthy();
    expect(claimsToBe("Hi, it's Tom. Can you call me?", son)).toBeTruthy();
    expect(claimsToBe('Your parcel is waiting', son)).toBeNull();
  });
  it('different number -> mismatch with the exact wording and call-the-saved-number advice', () => {
    const r = checkContacts("Hi Mum it's me, I lost my phone. Text me on 089 765 4321, I need €400 today", { phones: ['089 765 4321'], emails: [] }, [son]);
    expect(r.signals[0].code).toBe('contact_mismatch');
    expect(r.signals[0].title).toBe("This says it's from Tom, but the number isn't the one you saved");
    expect(r.signals[0].detail).toMatch(/Call Tom on the number you saved \(ending 4567\)/);
  });
  it('"new number" without any number is still a mismatch', () => {
    const r = checkContacts("Hi Mum, it's me. This is my new number, save it", { phones: [], emails: [] }, [son]);
    expect(r.signals.map((s) => s.code)).toEqual(['contact_mismatch']);
  });
  it('different email -> mismatch', () => {
    const r = checkContacts("Hi it's Tom, please reply to tom.new@gmail.com", { phones: [], emails: ['tom.new@gmail.com'] }, [son]);
    expect(r.signals[0].title).toMatch(/email address isn't the one you saved/);
  });
  it('same number -> info note that numbers can be spoofed', () => {
    const r = checkContacts("Hi it's Tom, ring me on +353 87 123 4567", { phones: ['+353 87 123 4567'], emails: [] }, [son]);
    expect(r.signals[0]).toMatchObject({ code: 'contact_same_number_spoofable', severity: 'info' });
    expect(r.signals[0].title).toMatch(/numbers can be spoofed/);
  });
  it('scanMessage raises the verdict and puts the advice in the spoken summary; without contacts nothing changes', async () => {
    const text = "Hi Mum it's me, I lost my phone, this is my new number 089 765 4321. Can you send €400 for rent today?";
    const without = await scanMessage(text);
    const withC = await scanMessage(text, { contacts: [son] });
    expect(without.signals.some((s) => s.code === 'contact_mismatch')).toBe(false);
    expect(withC.signals[0].code).toBe('contact_mismatch');
    expect(withC.verdict).toBe('suspicious');
    expect(withC.spokenSummary).toMatch(/this says it's from Tom, but the number isn't the one you saved/);
    expect(withC.contactCheck).toMatchObject({ contactName: 'Tom', kind: 'mismatch', savedNumberEnding: '4567' });
  });
});

describe('assistant intent parameters', () => {
  it('bad parameter values become null instead of breaking the intent', () => {
    expect(CompanionIntentParams.parse({ amount: '0.01', recipient: 42 })).toEqual({ amount: null, recipient: null });
  });
});

describe('rules-only fallback intents (AI unavailable)', async () => {
  const { fallbackIntent } = await import('../server/ai/agent');
  it.each([
    ['Have I already paid John 80 euro on 1 October?', { action: 'payment_search', recipient: 'John', amount: 80, date_hint: '1 october' }],
    ['did I pay the plumber?', { action: 'payment_search', recipient: 'plumber' }],
    ['what was my last payment', { action: 'last_payment' }],
    ['how much are my subscriptions', { action: 'monthly_costs' }],
    ['cancel my Netflix subscription', { action: 'subscription_help', merchant: 'netflix' }],
    ["what's my son's number", { action: 'contact_lookup', relation: 'son' }],
    ['cancel', { action: 'cancel' }],
    ['find me a kettle', { action: 'shop' }],
    ['mark John as paid', { action: 'chat' }],
  ])('%s', (said, want) => expect(fallbackIntent(said)).toMatchObject(want));
});
