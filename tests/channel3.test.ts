import { describe, it, expect, beforeEach } from 'vitest';
import { normaliseProducts, searchChannel3, Channel3Error, describeDiscovery, relevant } from '../server/catalogue/channel3';

const sample = {
  products: [
    { id: 'p1', title: 'Compact Microwave 20L', brands: [{ id: 'b', name: 'Acme' }], images: [{ url: 'https://img.example/m.jpg', cleaned_url: 'https://cdn.trychannel3.com/m.png', is_main_image: true, alt_text: 'White microwave' }],
      key_features: ['20 litre', '700 W'], ratings: { value: 4.4, count: 120 },
      offers: [
        { url: 'https://shop-b.ie/m', domain: 'www.shop-b.ie', price: { price: 129, currency: 'EUR' }, availability: 'InStock' },
        { url: 'https://shop-a.ie/m', domain: 'shop-a.ie', price: { price: 99.99, currency: 'EUR', compare_at_price: 119 }, availability: 'InStock' },
        { url: 'https://shop-c.co.uk/m', domain: 'shop-c.co.uk', price: { price: 80, currency: 'GBP' }, availability: 'InStock' },
        { url: 'javascript:alert(1)', domain: 'evil.ie', price: { price: 10, currency: 'EUR' }, availability: 'InStock' },
        { url: 'https://shop-d.ie/m', domain: 'shop-d.ie', price: { price: 300, currency: 'EUR' }, availability: 'InStock' },
      ] },
    { id: 'p2', title: 'Only GBP item', offers: [{ url: 'https://x.co.uk', domain: 'x.co.uk', price: { price: 50, currency: 'GBP' }, availability: 'InStock' }] },
    { title: 'missing id' },
  ],
};

describe('Channel3 normalisation', () => {
  it('keeps only https offers in the requested currency within the cap, cheapest first', () => {
    const [p, ...rest] = normaliseProducts(sample, 'EUR', 150);
    expect(rest).toHaveLength(0); // GBP-only and malformed products dropped
    expect(p.offers.map((o) => o.retailer)).toEqual(['shop-a.ie', 'shop-b.ie']);
    expect(p.offers[0].compareAt).toBe(119);
    expect(p.image).toBe('https://cdn.trychannel3.com/m.png');
    expect(p.imageAlt).toBe('White microwave');
    expect(p.brand).toBe('Acme');
  });
  it('never converts currencies', () => {
    expect(normaliseProducts(sample, 'GBP', null).map((p) => p.offers[0].currency)).toEqual(['GBP', 'GBP']);
  });
  it('spoken summary says purchases happen on the retailer site', () => {
    const r = { source: 'channel3' as const, query: 'microwave', maxPrice: 150, currency: 'EUR', country: 'IE', fetchedAt: '', products: normaliseProducts(sample, 'EUR', 150) };
    expect(describeDiscovery(r)).toMatch(/shop's own website/);
    expect(describeDiscovery({ ...r, products: [] })).toMatch(/couldn't find/);
  });
});

describe('Channel3 search client', () => {
  beforeEach(() => { process.env.CHANNEL3_API_KEY = 'test-key'; });
  const fake = (status: number, body: unknown, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

  it('calls POST /v1/search with x-api-key, IE/EUR locale and price filter', async () => {
    const f: any = async (url: any, init: any) => { f.last = { url: String(url), init }; return new Response(JSON.stringify(sample), { status: 200 }); };
    const r = await searchChannel3('microwave', { maxPrice: 150, fetchImpl: f });
    expect(f.last.url).toBe('https://api.trychannel3.com/v1/search');
    expect(f.last.init.headers['x-api-key']).toBe('test-key');
    const body = JSON.parse(f.last.init.body);
    expect(body).toMatchObject({ query: 'microwave', config: { country: 'IE', currency: 'EUR' }, filters: { price: { max_price: 150 } } });
    expect(r.source).toBe('channel3');
    expect(r.products).toHaveLength(1);
  });
  it('maps errors: missing key, 401, 429 with retry-after, 500, network', async () => {
    delete process.env.CHANNEL3_API_KEY;
    await expect(searchChannel3('x', { fetchImpl: fake(200, sample) })).rejects.toMatchObject({ code: 'not_configured' });
    process.env.CHANNEL3_API_KEY = 'k';
    await expect(searchChannel3('x', { fetchImpl: fake(401, {}) })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(searchChannel3('x', { fetchImpl: fake(429, {}, { 'retry-after': '5' }) })).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 5 });
    await expect(searchChannel3('x', { fetchImpl: fake(500, {}) })).rejects.toMatchObject({ code: 'upstream' });
    const boom: any = async () => { throw new TypeError('fetch failed'); };
    await expect(searchChannel3('x', { fetchImpl: boom })).rejects.toBeInstanceOf(Channel3Error);
  });
  it('empty results are an empty list, not an error', async () => {
    const r = await searchChannel3('nothing', { fetchImpl: fake(200, { products: [] }) });
    expect(r.products).toEqual([]);
  });
});

describe('relevance guard', () => {
  it('drops products that mention none of the query words', () => {
    const ps = normaliseProducts(sample, 'EUR', 150);
    expect(relevant(ps, 'microwave')).toHaveLength(1);
    expect(relevant(ps, 'microwaves')).toHaveLength(1);
    expect(relevant(ps, 'flurbnog widget')).toHaveLength(0);
  });
});
