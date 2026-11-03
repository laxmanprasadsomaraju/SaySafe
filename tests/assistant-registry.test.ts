import { describe, it, expect } from 'vitest';
import { parseBlock, productItems, restoreThread, BLOCK_KINDS } from '../web/src/assistant/schemas';
import { parseFollowup, askedAge, ageAnswer, ageClaims, sellerAnswer, sellerFacts, toShopItem } from '../web/src/assistant/followups';
import { compareRows } from '../shared/shopping';

const item = (over: Record<string, unknown> = {}) => ({ id: 'p1', title: 'Wooden Train Set', brand: null, image: 'https://cdn.trychannel3.com/a.jpg', imageAlt: '', features: ['30 pieces'], price: 24.99, compareAt: null, currency: 'EUR', retailer: 'Smyths', url: 'https://www.smythstoys.com/ie/en-ie/p/1', availability: 'InStock', ...over });

describe('assistant component registry', () => {
  it('has exactly the approved components', () => {
    expect([...BLOCK_KINDS].sort()).toEqual(['compare', 'family_status', 'payment_history', 'payment_prep', 'product_cards', 'receipt', 'scam_result', 'trusted_links']);
  });
  it('rejects unknown kinds and markup-shaped payloads', () => {
    expect(parseBlock({ kind: 'html', html: '<img src=x onerror=alert(1)>' })).toBeNull();
    expect(parseBlock({ kind: 'custom_component', props: {} })).toBeNull();
    expect(parseBlock({ kind: 'product_cards', source: 'channel3', query: 'x', items: [], fetchedAt: null, note: null })).toBeNull(); // empty list
  });
  it('only allows https and internal links, and safe image sources', () => {
    expect(parseBlock({ kind: 'trusted_links', items: [{ label: 'x', href: 'javascript:alert(1)' }] })).toBeNull();
    expect(parseBlock({ kind: 'trusted_links', items: [{ label: 'x', href: 'http://paypal.com.evil.net' }] })).toBeNull();
    expect(parseBlock({ kind: 'trusted_links', items: [{ label: 'x', to: '//evil.example' }] })).toBeNull();
    expect(parseBlock({ kind: 'trusted_links', items: [{ label: 'Help', to: '/help' }, { label: 'PayPal', href: 'https://www.paypal.com/ie/smarthelp/home' }] })).not.toBeNull();
    expect(productItems([item({ url: 'javascript:alert(1)' }), item({ id: 'p2', image: 'data:text/html,<script>' }), item({ id: 'p3' })]).map((p) => p.id)).toEqual(['p3']);
  });
  it('validates scam results, payment cards and receipts', () => {
    expect(parseBlock({ kind: 'scam_result', scanId: 'scan_1', verdict: 'suspicious', headline: 'h', summary: 's', signals: [{ severity: 'high', title: 't', detail: 'd' }], safeActions: [{ label: 'Open PayPal', url: 'https://www.paypal.com' }], aiNotice: null })).not.toBeNull();
    expect(parseBlock({ kind: 'scam_result', scanId: 'scan_1', verdict: 'suspicious', headline: 'h', summary: 's', signals: [], safeActions: [{ label: 'Call', url: 'tel:+18000000' }], aiNotice: null })).toBeNull();
    const prep = { kind: 'payment_prep', lines: [{ productId: 'kettle-classic', name: 'Kettle', quantity: 1, lineCents: 3200, image: 'kettle.webp' }], totalCents: 3200, currency: 'EUR', merchant: 'SaySafe Demo Shop', needsFamily: false, thresholdCents: 7500, idempotencyKey: 'abcdefgh12', status: 'ready', requestId: null, error: null };
    expect(parseBlock(prep)).not.toBeNull();
    expect(parseBlock({ ...prep, totalCents: -1 })).toBeNull();
    expect(parseBlock({ ...prep, status: 'captured' })).toBeNull(); // the card can never claim a capture
    expect(parseBlock({ kind: 'receipt', requestId: 'pay_abcdef', state: 'CAPTURED', item: 'Kettle', merchant: 'm', amountCents: 3200, currency: 'EUR', receipt: { captureId: 'C1', amount: '32.00', currency: 'EUR', payee: 'Shop', orderId: 'O1', webhookConfirmed: true }, evidenceLabel: null, verifiedSteps: 3, at: '2026-11-03T01:00:00Z' })).not.toBeNull();
  });
  it('re-validates a saved conversation and drops tampered blocks', () => {
    const saved = JSON.stringify({ v: 1, mode: 'find', focusId: null, messages: [{ id: 'a', role: 'assistant', text: 'hi', blocks: [{ kind: 'html', html: '<b>x</b>' }, { kind: 'trusted_links', items: [{ label: 'Help', to: '/help' }] }] }] });
    const t = restoreThread(saved)!;
    expect(t.messages[0].blocks.map((b) => b.kind)).toEqual(['trusted_links']);
    expect(restoreThread('{not json')).toBeNull();
    expect(restoreThread(JSON.stringify({ v: 2 }))).toBeNull();
  });
});

describe('assistant follow-ups', () => {
  it('recognises the supported follow-ups', () => {
    expect(parseFollowup('show cheaper ones', true).kind).toBe('cheaper');
    expect(parseFollowup('is it suitable for a four-year-old?', true)).toEqual({ kind: 'age', age: 4 });
    expect(parseFollowup('check if this seller is trustworthy', true).kind).toBe('seller');
    expect(parseFollowup('show my last payment', false).kind).toBe('last_payment');
    expect(parseFollowup('show my payments', false).kind).toBe('payments');
    expect(parseFollowup('show cheaper ones', false).kind).toBe('none'); // nothing to compare against yet
    expect(askedAge('for a 4 year old')).toBe(4);
    expect(askedAge('aged 7')).toBe(7);
  });
  it('answers age questions only from listed attributes', () => {
    const listed = item({ attributes: { 'Age Range': ['Ages 3+'] } });
    const range = item({ id: 'p2', title: 'Science kit', features: ['For ages 8-12 years'] });
    const none = item({ id: 'p3', title: 'Plain mug', features: ['Dishwasher safe'] });
    expect(ageClaims(listed)[0]).toMatchObject({ min: 3, max: 99 });
    const a = ageAnswer([listed, range, none], 4, (t) => t);
    expect(a).toContain('“Ages 3+”');
    expect(a).toContain('includes age 4');
    expect(a).toContain('isn’t listed for age 4');
    expect(a).toContain('doesn’t say an age');
    expect(ageAnswer([none], 4, (t) => t)).toMatch(/doesn’t say what age/);
  });
  it('gives seller facts and guidance, never a trust verdict', () => {
    const a = sellerAnswer(sellerFacts(productItems([item()])[0], productItems([item()]), false));
    expect(a).toContain('smythstoys.com');
    expect(a).toContain('can’t vouch');
    expect(a).not.toMatch(/\b(is|are) (trustworthy|safe|legit|reliable)\b/i);
    const cheap = productItems([item({ id: 'a', price: 5 }), item({ id: 'b', price: 40 }), item({ id: 'c', price: 42 })]);
    expect(sellerAnswer(sellerFacts(cheap[0], cheap, false))).toContain('much lower than the other listings');
    expect(sellerAnswer(sellerFacts(cheap[0], cheap, true))).toContain('SaySafe Demo Shop');
  });
  it('reuses the shared compare rows', () => {
    const rows = compareRows(productItems([item(), item({ id: 'p2', price: 30 })]).map(toShopItem));
    expect(rows.find((r) => r.label.toLowerCase().includes('price'))?.values.length).toBe(2);
  });
});
