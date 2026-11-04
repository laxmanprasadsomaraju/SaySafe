// Real product discovery through the Channel3 product API (https://channel3.ai/docs).
// POST https://api.trychannel3.com/v1/search with header x-api-key.
// Discovery only: SaySafe never completes a retailer purchase. Offers link out to the retailer.

import { recommend, parseRequest, spokenRecommendation, type Recommendation } from '../../shared/shopping.js';

export const CHANNEL3_BASE = process.env.CHANNEL3_API_BASE ?? 'https://api.trychannel3.com';
export const channel3Configured = () => Boolean(process.env.CHANNEL3_API_KEY);

export interface DiscoveryOffer {
  retailer: string; // store domain as Channel3 returns it
  url: string; // retailer product page (https only)
  price: number; // as listed by the retailer, in `currency`
  compareAt: number | null;
  currency: string;
  availability: 'InStock' | 'OutOfStock' | 'Unknown';
  condition: string | null;
}
export interface DiscoveryProduct {
  id: string;
  title: string;
  brand: string | null;
  image: string | null;
  imageAlt: string;
  features: string[];
  /** Aggregate rating exactly as Channel3 lists it (value/count). Channel3 returns no review text. */
  rating: { value: number; count: number } | null;
  offers: DiscoveryOffer[]; // sorted cheapest first, in-stock first
  category: string | null;
  attributes: Record<string, string[]>;
  description: string | null;
  dimensions: { label: string; value: string } | null;
  /** Audience exactly as Channel3 lists it (female/male), when it does. */
  gender?: string | null;
  /** Colours Channel3 measured on the product photo (hex + share), used only for ranking, never claimed as a stated colour. */
  colours?: { hex: string; pct: number }[];
  /** Variant options as listed (e.g. Size: S, M, L). Labels only; availability as Channel3 states it. */
  variants?: { name: string; values: string[] }[];
  why?: string[];
}
export interface DiscoveryResult {
  source: 'channel3';
  query: string;
  maxPrice: number | null;
  currency: string;
  country: string;
  fetchedAt: string;
  products: DiscoveryProduct[];
  /** Sanitised copy of what was sent to Channel3 (query + filters + config). No key, no user id. */
  request?: { query: string; filters: Record<string, unknown>; config: Record<string, unknown>; brandFilterDropped?: boolean };
}

/** Structured filters SaySafe may send. Names checked against https://api.trychannel3.com/openapi.json (SearchFilters), 2026-11-04. */
export interface SearchFiltersIn {
  gender?: 'female' | 'male' | null;
  age?: ('kids' | 'adult' | 'toddler' | 'infant' | 'newborn')[] | null;
  /** Brand NAME; resolved to Channel3 brand_ids through GET /v1/brands/search (cached). */
  brand?: string | null;
  /** Retailer domain(s), e.g. argos.ie (website_ids accepts domains). */
  websites?: string[] | null;
  minPrice?: number | null;
}

export class Channel3Error extends Error {
  constructor(public code: 'not_configured' | 'unauthorized' | 'rate_limited' | 'bad_request' | 'upstream' | 'timeout' | 'malformed', message: string, public retryAfter?: number) { super(message); }
}

const isHttps = (u: unknown): u is string => { try { return typeof u === 'string' && new URL(u).protocol === 'https:'; } catch { return false; } };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Map Channel3's documented Product schema into the small shape the UI shows. Drops anything unverifiable. */
export function normaliseProducts(raw: unknown, currency: string, maxPrice: number | null): DiscoveryProduct[] {
  const list = Array.isArray((raw as any)?.products) ? (raw as any).products : [];
  const out: DiscoveryProduct[] = [];
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || typeof p.title !== 'string') continue;
    const offers: DiscoveryOffer[] = (Array.isArray(p.offers) ? p.offers : [])
      .map((o: any): DiscoveryOffer | null => {
        const price = num(o?.price?.price);
        const cur = typeof o?.price?.currency === 'string' ? o.price.currency.toUpperCase() : null;
        if (price === null || price <= 0 || !cur || !isHttps(o?.url) || typeof o?.domain !== 'string') return null;
        return {
          retailer: o.domain.replace(/^www\./, ''),
          url: o.url,
          price,
          compareAt: num(o?.price?.compare_at_price),
          currency: cur,
          availability: o.availability === 'InStock' || o.availability === 'OutOfStock' ? o.availability : 'Unknown',
          condition: typeof o.condition === 'string' ? o.condition : null,
        };
      })
      .filter((o: DiscoveryOffer | null): o is DiscoveryOffer => o !== null)
      // Only offers in the requested currency: we never convert prices.
      .filter((o: DiscoveryOffer) => o.currency === currency)
      .filter((o: DiscoveryOffer) => maxPrice === null || o.price <= maxPrice)
      .sort((a: DiscoveryOffer, b: DiscoveryOffer) => (a.availability === 'InStock' ? 0 : 1) - (b.availability === 'InStock' ? 0 : 1) || a.price - b.price)
      .slice(0, 4);
    if (!offers.length) continue;
    const imgs = Array.isArray(p.images) ? p.images : [];
    const main = imgs.find((i: any) => i?.is_main_image) ?? imgs[0];
    // Only Channel3's own CDN is allowed by our CSP (img-src); other hosts fall back to a placeholder.
    const fromCdn = (u: unknown) => isHttps(u) && new URL(u).hostname === 'cdn.trychannel3.com';
    const image = fromCdn(main?.cleaned_url) ? main.cleaned_url : fromCdn(main?.url) ? main.url : null;
    const brand = Array.isArray(p.brands) && typeof p.brands[0]?.name === 'string' ? p.brands[0].name : null;
    const rv = num(p?.ratings?.value), rc = num(p?.ratings?.count);
    out.push({
      id: p.id,
      title: p.title.slice(0, 200),
      brand,
      image,
      imageAlt: typeof main?.alt_text === 'string' && main.alt_text.trim() ? main.alt_text.slice(0, 200) : `Photo of ${p.title.slice(0, 120)}`,
      features: (Array.isArray(p.key_features) ? p.key_features : []).filter((f: unknown) => typeof f === 'string').slice(0, 6).map((f: string) => f.slice(0, 140)),
      rating: rv !== null && rc ? { value: rv, count: rc } : null,
      offers,
      category: typeof p?.category?.title === 'string' ? p.category.title.slice(0, 80) : null,
      attributes: attributesOf(p?.structured_attributes),
      description: typeof p.description === 'string' ? p.description.slice(0, 800) : null,
      dimensions: dimensionsOf((Array.isArray(p.offers) ? p.offers : []).find((o: any) => o?.dimensions)?.dimensions),
      gender: p.gender === 'female' || p.gender === 'male' ? p.gender : null,
      colours: (Array.isArray(p.colors) ? p.colors : []).filter((c: any) => typeof c?.hex === 'string' && /^#[0-9a-f]{6}$/i.test(c.hex)).slice(0, 5).map((c: any) => ({ hex: c.hex.toLowerCase(), pct: num(c.percentage) ?? 0 })),
      variants: variantsOf(p?.variants),
    });
  }
  return out;
}

function attributesOf(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 12)) {
    if (!Array.isArray(v)) continue;
    const vals = v.filter((x): x is string => typeof x === 'string').slice(0, 6).map((x) => x.slice(0, 60));
    if (vals.length) out[k.slice(0, 40)] = vals;
  }
  return out;
}

function variantsOf(v: any): { name: string; values: string[] }[] {
  const opts = Array.isArray(v?.options) ? v.options : [];
  return opts.slice(0, 3).map((o: any) => ({
    name: typeof o?.name === 'string' ? o.name.slice(0, 30) : '',
    values: (Array.isArray(o?.values) ? o.values : []).filter((x: any) => typeof x?.label === 'string' && x.exists !== false && x.available !== 'OutOfStock').slice(0, 12).map((x: any) => x.label.slice(0, 30)),
  })).filter((o: { name: string; values: string[] }) => o.name && o.values.length);
}

function dimensionsOf(d: any): { label: string; value: string } | null {
  const part = (x: any) => (num(x?.number) !== null && typeof x?.unit === 'string' ? `${x.number} ${x.unit}` : null);
  const [w, h, l] = [part(d?.width), part(d?.height), part(d?.length)];
  if (!w || !h || !l) return null;
  return { label: 'W × H × D', value: `${w} × ${h} × ${l}` };
}

const cache = new Map<string, { at: number; value: DiscoveryResult }>();
const TTL = 10 * 60 * 1000;
const brandCache = new Map<string, { at: number; id: string | null }>();

/** Brand name -> Channel3 brand id (exact name match only), via GET /v1/brands/search. Null when unsure. */
export async function resolveBrandId(name: string, key: string, f: typeof fetch = fetch): Promise<string | null> {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const hit = brandCache.get(n);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.id;
  try {
    const res = await f(`${CHANNEL3_BASE}/v1/brands/search?query=${encodeURIComponent(name.trim().slice(0, 60))}&limit=3`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null; // never fatal: the brand stays in the query text and in local ranking
    const raw: any = await res.json().catch(() => null);
    const b = (Array.isArray(raw?.brands) ? raw.brands : []).find((x: any) => typeof x?.id === 'string' && typeof x?.name === 'string' && x.name.trim().toLowerCase() === n);
    const id = b?.id ?? null;
    brandCache.set(n, { at: Date.now(), id });
    return id;
  } catch { return null; }
}

export async function searchChannel3(
  query: string,
  // relevanceQuery: the words the person actually asked for. A remembered colour added to the query text must never make
  // an unrelated listing "relevant" (e.g. a black microwave for "garden gnome").
  opts: { maxPrice?: number | null; country?: string; currency?: string; limit?: number; fetchImpl?: typeof fetch; relevanceQuery?: string; filters?: SearchFiltersIn } = {},
): Promise<DiscoveryResult> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new Channel3Error('not_configured', 'Real product search is not set up on this server.');
  const country = opts.country ?? 'IE';
  const currency = opts.currency ?? 'EUR';
  const maxPrice = opts.maxPrice ?? null;
  const fin = opts.filters ?? {};
  const minPrice = fin.minPrice ?? null;
  const q = query.trim().slice(0, 200);
  const rq = (opts.relevanceQuery ?? q).trim().slice(0, 200);
  const cacheKey = JSON.stringify([q.toLowerCase(), maxPrice, country, currency, rq.toLowerCase(), fin]);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL && !opts.fetchImpl) return hit.value;
  const f = opts.fetchImpl ?? fetch;

  // Structured filters (documented SearchFilters). Locale goes in config, never top level (top-level locale -> 422).
  const filters: Record<string, unknown> = {};
  if (maxPrice || minPrice) filters.price = { ...(minPrice ? { min_price: minPrice } : {}), ...(maxPrice ? { max_price: maxPrice } : {}) };
  if (fin.gender) filters.gender = fin.gender;
  if (fin.age?.length) filters.age = fin.age;
  if (fin.websites?.length) filters.website_ids = fin.websites.slice(0, 5);
  const brandId = fin.brand ? await resolveBrandId(fin.brand, key, f) : null;
  if (brandId) filters.brand_ids = [brandId];
  // colors.palette (beta) was evaluated live on 2026-11-04: a pure-black palette returned 0 women's Nike T-shirts that
  // plainly exist, so it is NOT sent. Colour is ranked locally from the listing text and Channel3's measured photo colours.
  const config = { country, currency, language: 'en' };

  const call = async (flt: Record<string, unknown>) => {
    const body: Record<string, unknown> = { query: q, limit: Math.min(opts.limit ?? 12, 30), config };
    if (Object.keys(flt).length) body.filters = flt;
    let res: Response;
    try {
      res = await f(`${CHANNEL3_BASE}/v1/search`, {
        method: 'POST',
        // Deliberately NO x-user-id: it is optional (attribution only) and Channel3 appends it to buy URLs, which would
        // expose an internal household id to retailers and, through this shared cache, to other visitors.
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (e: any) {
      throw new Channel3Error(e?.name === 'TimeoutError' ? 'timeout' : 'upstream', e?.name === 'TimeoutError' ? 'The product search service took too long to answer.' : 'The product search service did not answer.');
    }
    if (res.status === 401 || res.status === 403) throw new Channel3Error('unauthorized', 'The product search key was refused.');
    if (res.status === 429) throw new Channel3Error('rate_limited', 'Too many searches right now.', Number(res.headers.get('retry-after')) || 5);
    if (res.status === 402) throw new Channel3Error('rate_limited', 'Product search credits are used up for now.');
    if (res.status === 422 || res.status === 400) throw new Channel3Error('bad_request', 'That search could not be run.');
    if (!res.ok) throw new Channel3Error('upstream', `Product search failed (${res.status}).`);
    const raw = await res.json().catch(() => undefined);
    // Malformed data is an error, never "no results".
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).products)) throw new Channel3Error('malformed', 'The product search sent back data SaySafe could not read.');
    return raw;
  };
  let raw = await call(filters);
  let brandFilterDropped = false;
  // A resolved brand id that matches nothing in this locale: one retry without it (the brand stays in the query text).
  if (brandId && !(raw as any).products.length) { const { brand_ids: _b, ...rest } = filters; raw = await call(rest); brandFilterDropped = true; delete filters.brand_ids; }
  const value: DiscoveryResult = {
    source: 'channel3', query: q, maxPrice, currency, country, fetchedAt: new Date().toISOString(),
    products: relevant(normaliseProducts(raw, currency, maxPrice), rq, new Map(((raw as any)?.products ?? []).filter((p: any) => typeof p?.id === 'string').map((p: any) => [p.id, String(p?.category?.title ?? '')]))).slice(0, 10),
    request: { query: q, filters: { ...filters, ...(fin.brand ? { brand: fin.brand } : {}) }, config, ...(brandFilterDropped ? { brandFilterDropped } : {}) },
  };
  if (!opts.fetchImpl) cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Keep products whose title or category mentions at least one meaningful query word (guards against nonsense matches). */
export function relevant(products: DiscoveryProduct[], query: string, categories: Map<string, string> = new Map()): DiscoveryProduct[] {
  const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(es|s)$/, '');
  const words = query.split(/\s+/).map(stem).filter((w) => w.length >= 3 && !['under', 'for', 'the', 'and', 'with', 'cheap', 'best', 'find', 'need'].includes(w));
  if (!words.length) return products;
  // Compare with punctuation removed on BOTH sides, so "t-shirt" matches "T-Shirt" and "PS5" matches "PS-5".
  return products.filter((p) => { const hay = `${p.title} ${categories.get(p.id) ?? ''}`.toLowerCase(); const flat = hay.replace(/[^a-z0-9]/g, ''); return words.some((w) => hay.includes(w) || flat.includes(w)); });
}

/**
 * Short spoken summary: one recommendation, 1-2 reasons, an optional follow-up question.
 * It never lists every product. Never claims SaySafe sells or guarantees these items.
 */
export function describeDiscovery(r: DiscoveryResult, rec?: Recommendation): string {
  if (!r.products.length) return `I couldn't find ${r.query} in listings for Ireland${r.maxPrice ? ` under €${r.maxPrice}` : ''}. Try different words or a higher price.`;
  return spokenRecommendation(r.products, rec ?? recommend(r.products, parseRequest(r.query)), r.query);
}
