// Real product discovery through the Channel3 product API (https://channel3.ai/docs).
// POST https://api.trychannel3.com/v1/search with header x-api-key.
// Discovery only: SaySafe never completes a retailer purchase. Offers link out to the retailer.

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
  rating: { value: number; count: number } | null;
  offers: DiscoveryOffer[]; // sorted cheapest first, in-stock first
}
export interface DiscoveryResult {
  source: 'channel3';
  query: string;
  maxPrice: number | null;
  currency: string;
  country: string;
  fetchedAt: string;
  products: DiscoveryProduct[];
}

export class Channel3Error extends Error {
  constructor(public code: 'not_configured' | 'unauthorized' | 'rate_limited' | 'bad_request' | 'upstream' | 'timeout', message: string, public retryAfter?: number) { super(message); }
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
      features: (Array.isArray(p.key_features) ? p.key_features : []).filter((f: unknown) => typeof f === 'string').slice(0, 3).map((f: string) => f.slice(0, 140)),
      rating: rv !== null && rc ? { value: rv, count: rc } : null,
      offers,
    });
  }
  return out;
}

const cache = new Map<string, { at: number; value: DiscoveryResult }>();
const TTL = 10 * 60 * 1000;

export async function searchChannel3(
  query: string,
  opts: { maxPrice?: number | null; country?: string; currency?: string; limit?: number; userId?: string; fetchImpl?: typeof fetch } = {},
): Promise<DiscoveryResult> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new Channel3Error('not_configured', 'Real product search is not set up on this server.');
  const country = opts.country ?? 'IE';
  const currency = opts.currency ?? 'EUR';
  const maxPrice = opts.maxPrice ?? null;
  const q = query.trim().slice(0, 200);
  const cacheKey = JSON.stringify([q.toLowerCase(), maxPrice, country, currency]);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL && !opts.fetchImpl) return hit.value;

  const body: Record<string, unknown> = { query: q, limit: Math.min(opts.limit ?? 12, 30), config: { country, currency, language: 'en' } };
  if (maxPrice) body.filters = { price: { max_price: maxPrice } };
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${CHANNEL3_BASE}/v1/search`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json', ...(opts.userId ? { 'x-user-id': opts.userId } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e: any) {
    throw new Channel3Error(e?.name === 'TimeoutError' ? 'timeout' : 'upstream', 'The product search service did not answer.');
  }
  if (res.status === 401 || res.status === 403) throw new Channel3Error('unauthorized', 'The product search key was refused.');
  if (res.status === 429) throw new Channel3Error('rate_limited', 'Too many searches right now.', Number(res.headers.get('retry-after')) || 5);
  if (res.status === 402) throw new Channel3Error('rate_limited', 'Product search credits are used up for now.');
  if (res.status === 422 || res.status === 400) throw new Channel3Error('bad_request', 'That search could not be run.');
  if (!res.ok) throw new Channel3Error('upstream', `Product search failed (${res.status}).`);
  const raw = await res.json().catch(() => null);
  const value: DiscoveryResult = { source: 'channel3', query: q, maxPrice, currency, country, fetchedAt: new Date().toISOString(), products: relevant(normaliseProducts(raw, currency, maxPrice), q, new Map(((raw as any)?.products ?? []).filter((p: any) => typeof p?.id === 'string').map((p: any) => [p.id, String(p?.category?.title ?? '')]))).slice(0, 6) };
  if (!opts.fetchImpl) cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Keep products whose title or category mentions at least one meaningful query word (guards against nonsense matches). */
export function relevant(products: DiscoveryProduct[], query: string, categories: Map<string, string> = new Map()): DiscoveryProduct[] {
  const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(es|s)$/, '');
  const words = query.split(/\s+/).map(stem).filter((w) => w.length >= 3 && !['under', 'for', 'the', 'and', 'with', 'cheap', 'best', 'find', 'need'].includes(w));
  if (!words.length) return products;
  return products.filter((p) => { const hay = `${p.title} ${categories.get(p.id) ?? ''}`.toLowerCase(); return words.some((w) => hay.includes(w)); });
}

/** Plain spoken summary. Never claims SaySafe sells or guarantees these items. */
export function describeDiscovery(r: DiscoveryResult): string {
  if (!r.products.length) return `I couldn't find ${r.query} from shops in Ireland${r.maxPrice ? ` under €${r.maxPrice}` : ''}. Try different words or a higher price.`;
  const top = r.products.slice(0, 3).map((p, i) => `Option ${i + 1}: ${p.title}, from €${p.offers[0].price.toFixed(2)} at ${p.offers[0].retailer}`);
  return `I found ${r.products.length} real ${r.products.length === 1 ? 'product' : 'products'} from other shops. ${top.join('. ')}. Prices come from the shops and can change. You would buy on the shop's own website, not through SaySafe.`;
}
