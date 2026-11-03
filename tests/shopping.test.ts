import { describe, it, expect } from 'vitest';
import fixture from './fixtures/channel3-microwave.json';
import { normaliseProducts, describeDiscovery } from '../server/catalogue/channel3';
import {
  parseBudget, parseRequest, recommend, parseFollowup, compareRows, specsAnswer, spokenRecommendation, readAllSegments,
  sanitizeProfile, explanationIsGrounded, EMPTY_PROFILE, type ShopItem,
} from '../shared/shopping';

// Real Channel3 response for "microwave" (IE / EUR), captured 2026-11-03.
const all = normaliseProducts(fixture, 'EUR', null);
const under150 = normaliseProducts(fixture, 'EUR', 150);

const item = (over: Partial<ShopItem> & { id: string; price: number }): ShopItem => ({
  title: 'Solo Microwave', brand: null, image: null, imageAlt: '', features: [], rating: null,
  offers: [{ retailer: 'shop.ie', url: 'https://shop.ie/x', price: over.price, compareAt: null, currency: 'EUR', availability: 'InStock', condition: 'new' }],
  category: 'Microwave Ovens', attributes: {}, description: null, dimensions: null, ...over,
});

describe('budget parsing', () => {
  it.each([
    ['microwave under €150', 150], ['below 100 euro', 100], ['less than 99.99 euros', 99.99], ['up to €80', 80],
    ['kettle, max 40', 40], ['€150 or less', 150], ['150 euro max', 150], ['budget of 200', 200], ['show only under €100', 100],
    ['under 1,5', 1.5],
  ])('%s -> %s', (t, max) => expect(parseBudget(t).max).toBe(max));
  it('between', () => expect(parseBudget('between €50 and €100')).toEqual({ min: 50, max: 100 }));
  it('no budget', () => expect(parseBudget('a white microwave')).toEqual({ min: null, max: null }));
  it('strips budget and filler from the product query', () => {
    const r = parseRequest('Find me a compact microwave under €150');
    expect(r.keywords).toEqual(['compact', 'microwave']);
    expect(r.budget.max).toBe(150);
  });
});

describe('ranking (real Channel3 data)', () => {
  it('filters strictly by price and is deterministic', () => {
    const req = parseRequest('microwave under €150');
    const a = recommend(under150, req), b = recommend([...under150].reverse(), req);
    expect(a.rankedIds).toEqual(b.rankedIds);
    for (const id of a.rankedIds) expect(under150.find((p) => p.id === id)!.offers[0].price).toBeLessThanOrEqual(150);
    // A request budget is also enforced even if the upstream filter didn't apply it.
    const strict = recommend(all, req);
    for (const id of strict.rankedIds) expect(all.find((p) => p.id === id)!.offers[0].price).toBeLessThanOrEqual(150);
  });
  it('picks a best match with verifiable reasons, a cheaper alternative only if cheaper', () => {
    const rec = recommend(under150, parseRequest('microwave under €150'));
    const best = rec.picks.find((p) => p.role === 'best')!;
    expect(best.reasons.join(' ')).toMatch(/within your €150 budget/);
    const cheaper = rec.picks.find((p) => p.role === 'cheaper');
    if (cheaper) {
      const price = (id: string) => under150.find((p) => p.id === id)!.offers[0].price;
      expect(price(cheaper.id)).toBeLessThan(price(best.id));
    }
    expect(new Set(rec.picks.map((p) => p.id)).size).toBe(rec.picks.length);
  });
  it('no cheaper alternative when the best match is already the cheapest', () => {
    const rec = recommend([item({ id: 'a', price: 50 }), item({ id: 'b', price: 90, offers: [{ ...item({ id: 'b', price: 90 }).offers[0], availability: 'Unknown' }] })], parseRequest('microwave'));
    expect(rec.picks[0].id).toBe('a');
    expect(rec.picks.some((p) => p.role === 'cheaper')).toBe(false);
  });
  it('feature words in the request favour listings that state them', () => {
    const rec = recommend(under150, parseRequest('microwave with child lock'));
    const best = under150.find((p) => p.id === rec.picks[0].id)!;
    expect(JSON.stringify(best).toLowerCase()).toContain('child');
  });
});

describe('wording never invents reviews, delivery or trust', () => {
  it('spoken summary is short, single recommendation, no review words', () => {
    const rec = recommend(under150, parseRequest('microwave under €150'));
    const text = spokenRecommendation(under150, rec, 'microwave');
    expect(text.length).toBeLessThan(330);
    expect(text).not.toMatch(/review|rating|star|deliver|warrant|trusted|reliable/i);
    expect(text).toMatch(/^My best match is the /);
    expect(text).toMatch(/shop's own website/);
  });
  it('describeDiscovery uses the same short summary', () => {
    const r = { source: 'channel3' as const, query: 'microwave', maxPrice: 150, currency: 'EUR', country: 'IE', fetchedAt: '', products: under150 };
    expect(describeDiscovery(r).split('. ').length).toBeLessThanOrEqual(5);
  });
  it('reasons never mention ratings, even when a rating exists', () => {
    const rec = recommend(under150, parseRequest('microwave'));
    expect(rec.picks.flatMap((p) => p.reasons).join(' ')).not.toMatch(/review|rating|star/i);
  });
  it('compare shows "listed rating" only when present, and marks missing fields', () => {
    const rows = compareRows([item({ id: 'a', price: 50, title: 'Microwave 800W 20L' }), item({ id: 'b', price: 60 })]);
    const power = rows.find((r) => r.label === 'Power (listed)')!;
    expect(power.values).toEqual(['800 W', null]);
    expect(rows.find((r) => r.label === 'Listed rating')).toBeUndefined();
  });
  it('specs answer only compares stated numbers and says what is missing', () => {
    const t = specsAnswer([item({ id: 'a', price: 50, title: 'Microwave 900W' }), item({ id: 'b', price: 60, title: 'Microwave 800W 20L' })], ['A', 'B']);
    expect(t).toMatch(/Most listed power: A, 900 watts/);
    expect(t).toMatch(/Only B lists its capacity/);
    expect(specsAnswer([item({ id: 'a', price: 1 }), item({ id: 'b', price: 2 })], ['A', 'B'])).toMatch(/don't give comparable/);
  });
  it('AI explanation guard rejects invented facts', () => {
    const p = under150[0];
    expect(explanationIsGrounded(`It is ${p.offers[0].price} euro at ${p.offers[0].retailer}.`, p)).toBe(true);
    expect(explanationIsGrounded('It has great reviews.', p)).toBe(false);
    expect(explanationIsGrounded('Free delivery next day.', p)).toBe(false);
    expect(explanationIsGrounded('It has 1234 W of power.', p)).toBe(false);
    expect(explanationIsGrounded('Customers rate it 4.9 stars.', item({ id: 'x', price: 10 }))).toBe(false);
    expect(explanationIsGrounded('A trusted shop.', p)).toBe(false);
  });
});

describe('shopping profile', () => {
  it('sanitises and limits input', () => {
    const p = sanitizeProfile({ colours: ['  Blue ', '<script>', 'x', ...Array(20).fill('red')], brands: 'Panasonic, Samsung', budgetMax: '120', avoid: [{}], evil: 'x' });
    expect(p.colours).toEqual(['Blue', 'script', 'red']);
    expect(p.brands).toEqual(['Panasonic', 'Samsung']);
    expect(p.budgetMax).toBe(120);
    expect(p.avoid).toEqual([]);
    expect(Object.keys(p)).not.toContain('evil');
    expect(sanitizeProfile({ budgetMax: -5 }).budgetMax).toBeNull();
  });
  it('the profile changes ranking (brand present in data gets boosted)', () => {
    const req = parseRequest('microwave under €150');
    const base = recommend(under150, req).picks[0].id;
    const target = under150.find((p) => p.id !== base && p.brand)!;
    const withBrand = recommend(under150, req, { ...EMPTY_PROFILE, brands: [target.brand!] });
    expect(withBrand.picks[0].id).toBe(target.id);
    expect(withBrand.picks[0].reasons.join(' ')).toMatch(/a brand you like/);
  });
  it('avoid list removes listings that contain the term', () => {
    const rec = recommend(under150, parseRequest('microwave'), { ...EMPTY_PROFILE, avoid: ['touch'] });
    for (const id of rec.rankedIds) expect(JSON.stringify(under150.find((p) => p.id === id)).toLowerCase()).not.toMatch(/\btouch/);
    expect(rec.avoidedCount).toBeGreaterThan(0);
  });
  it('usual budget filters when the request has none, and is relaxed if nothing fits', () => {
    const rec = recommend(all, parseRequest('microwave'), { ...EMPTY_PROFILE, budgetMax: 120 });
    expect(rec.usedProfileBudget).toBe(120);
    for (const id of rec.rankedIds) expect(all.find((p) => p.id === id)!.offers[0].price).toBeLessThanOrEqual(120);
    const relaxed = recommend(all, parseRequest('microwave'), { ...EMPTY_PROFILE, budgetMax: 5 });
    expect(relaxed.profileBudgetRelaxed).toBe(true);
    expect(relaxed.rankedIds.length).toBeGreaterThan(0);
  });
  it('never claims "matches your preference for blue" unless the listing shows blue', () => {
    const items = [item({ id: 'w', price: 50, title: 'White Microwave' }), item({ id: 'b', price: 70, title: 'Blue Microwave' })];
    const rec = recommend(items, parseRequest('microwave'), { ...EMPTY_PROFILE, colours: ['blue'] });
    for (const p of rec.picks) {
      const claims = p.reasons.some((r) => /preference for blue/.test(r));
      expect(claims).toBe(p.id === 'b');
    }
    // Real data has hex colour swatches only, never a "blue" word: so no claim at all.
    const real = recommend(under150, parseRequest('microwave'), { ...EMPTY_PROFILE, colours: ['blue'] });
    expect(real.picks.flatMap((p) => p.reasons).join(' ')).not.toMatch(/preference for blue/);
    // The AI explanation may not name a preference the listing lacks either.
    expect(explanationIsGrounded('It matches your preference for blue.', items[0], [], { ...EMPTY_PROFILE, colours: ['blue'] })).toBe(false);
    expect(explanationIsGrounded('It matches your preference for blue.', items[1], [], { ...EMPTY_PROFILE, colours: ['blue'] })).toBe(true);
  });
});

describe('follow-up intents', () => {
  it.each([
    ['stop talking', 'stop'], ['Stop', 'stop'], ['why did you recommend this', 'why'], ['find something cheaper', 'cheaper'],
    ['which has better specifications?', 'specs'], ['show only under €100', 'budget'], ['tell me more about the second one', 'more'],
    ['find me a kettle', 'search'],
  ])('%s -> %s', (t, kind) => expect(parseFollowup(t, true).kind).toBe(kind));
  it('carries the index and budget', () => {
    expect(parseFollowup('tell me more about the second one', true)).toEqual({ kind: 'more', index: 1 });
    expect(parseFollowup('show only under €100', true)).toEqual({ kind: 'budget', max: 100 });
    expect(parseFollowup('why the third one', true)).toEqual({ kind: 'why', index: 2 });
  });
  it('without results everything except stop is a new search', () => {
    expect(parseFollowup('find something cheaper', false).kind).toBe('search');
    expect(parseFollowup('stop talking', false).kind).toBe('stop');
  });
});

describe('read everything', () => {
  it('one segment per listing with title, price and merchant', () => {
    const segs = readAllSegments(under150);
    expect(segs).toHaveLength(under150.length);
    expect(segs[0]).toContain(under150[0].offers[0].retailer);
    expect(segs[0]).toMatch(/^Listing 1 of /);
  });
});
