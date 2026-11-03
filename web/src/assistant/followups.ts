/**
 * Deterministic follow-ups about what is already in the conversation. Every answer is built only from
 * fields in the listing data or the user's own payment records: nothing is guessed or certified.
 */
import type { ProductItem } from './schemas';
import type { ShopItem } from '../../../shared/shopping';

export type Followup =
  | { kind: 'cheaper' }
  | { kind: 'age'; age: number }
  | { kind: 'seller' }
  | { kind: 'last_payment' }
  | { kind: 'payment_status' }
  | { kind: 'payments' }
  | { kind: 'refund' }
  | { kind: 'search'; q: string }
  | { kind: 'compare' }
  | { kind: 'more' }
  | { kind: 'none' };

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16 };
const NUMW = String.raw`(\d{1,2}|${Object.keys(WORDS).join('|')})`;
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);

/** The age the person asks about ("a four-year-old", "for a 4 year old", "aged 4"), or null. */
export function askedAge(text: string): number | null {
  const s = text.toLowerCase();
  const m = s.match(new RegExp(String.raw`\b${NUMW}[\s-]*(?:years?|yrs?|yo)\b(?:[\s-]*olds?)?`)) ?? s.match(new RegExp(String.raw`\b(?:aged?|age of)\s*${NUMW}\b`));
  return m ? num(m[1]) ?? null : null;
}

export function parseFollowup(text: string, hasProducts: boolean): Followup {
  const s = text.toLowerCase().trim();
  if (/\brefunds?\b|\bmoney back\b/.test(s)) return { kind: 'refund' };
  const sm = s.match(/^(?:search|find|look for)\s+(?:my\s+)?(?:payments?|purchases?|orders?|history|activity)\s+(?:for\s+)?(.{2,60})$/) ?? s.match(/^(?:search|find)\s+(?:my\s+)?(.{2,40}?)\s+(?:payment|purchase|order|receipt)s?$/);
  if (sm) return { kind: 'search', q: sm[1].replace(/[?.!]+$/, '').trim() };
  // "Did my payment go through?": the status of the purchase in this conversation (or the newest one), read from the server.
  if (/\b(did|has|have|is)\b.{0,12}\b(my|the|that|this|it)\b.{0,14}\b(payment|purchase|order|it)?\b.{0,6}\b(go(ne)? through|work(ed)?|succeed(ed)?|complete(d)?|finish(ed)?|done|paid|been paid)\b/.test(s) && /\b(payment|purchase|order|it|through)\b/.test(s) && !/\b(john|pay [a-z]+ back)\b/.test(s) && !/\b(to|for)\s+(?!the shop|demo|it\b)[a-z]+\b.{0,3}$/.test(s.replace(/[?.!]+$/, ''))) return { kind: 'payment_status' };
  // "my last payment to John" is about Mary's own records (the companion), not the Demo Shop receipt.
  const toPerson = /\b(payment|paid)\s+(to|for)\s+(?!the shop|demo)[a-z]/.test(s);
  if (!toPerson && (/\b(last|latest|most recent|previous)\b.{0,20}\b(payment|purchase|order|receipt)\b/.test(s) || /^(show )?(my )?receipt\b/.test(s))) return { kind: 'last_payment' };
  if (/\b(my|all|show) (payments|purchases|orders)\b|\bpayment history\b|\bwhat (have i|did i) (bought|buy|paid|pay)\b/.test(s)) return { kind: 'payments' };
  if (!hasProducts) return { kind: 'none' };
  const age = askedAge(s);
  if (age !== null && /\b(suitable|suit|ok|okay|good|right|safe|fine|appropriate|for)\b/.test(s)) return { kind: 'age', age };
  if (/\b(seller|shop|store|retailer|website|site|merchant|company)\b/.test(s) && /\b(trust|trustworthy|trusted|legit|legitimate|genuine|real|scam|reliable|reputable|safe|honest)\b/.test(s)) return { kind: 'seller' };
  if (/\bis (this|that|it) (a )?(legit|scam|genuine|real)\b/.test(s)) return { kind: 'seller' };
  if (/\b(cheaper|less expensive|lower price|lower[- ]cost|cheapest|more affordable)\b/.test(s)) return { kind: 'cheaper' };
  // "Compare real shops for a toaster" is a new search, not "compare the products on screen".
  if (/\b(compare|side by side|which (one )?is better|difference)\b/.test(s) && !/\bcompare\s+(real\s+)?(shops?|prices|retailers|stores)\b.{0,10}\b(for|on)\s+\w/.test(s)) return { kind: 'compare' };
  if (/\b(show more|more options|see more|other options)\b/.test(s)) return { kind: 'more' };
  return { kind: 'none' };
}

/** All text a listing actually states (for "only from listed attributes"). */
export function listedText(p: ProductItem): string[] {
  const attrs = Object.entries(p.attributes ?? {}).flatMap(([k, v]) => v.map((x) => `${k}: ${x}`));
  return [p.title, ...p.features, ...attrs, p.description ?? ''].filter(Boolean);
}

interface AgeClaim { raw: string; min: number; max: number }
/** Age ranges a listing states. Months are converted to years. */
export function ageClaims(p: ProductItem): AgeClaim[] {
  const out: AgeClaim[] = [];
  const push = (raw: string, min: number, max: number) => out.push({ raw: raw.trim(), min, max });
  for (const t of listedText(p)) {
    for (const m of t.matchAll(/\b(?:ages?|aged|for)?\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(years?|yrs?|y|months?)\b/gi)) {
      const k = /month/i.test(m[3]) ? 1 / 12 : 1; push(m[0], Number(m[1]) * k, Number(m[2]) * k);
    }
    for (const m of t.matchAll(/\bages?\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b(?!\s*(?:years?|yrs?|y|months?)\b)/gi)) push(m[0], Number(m[1]), Number(m[2]));
    for (const m of t.matchAll(/\b(?:ages?|aged)\s*(\d{1,2})\s*(?:\+|plus|and up|and over|and older)/gi)) push(m[0], Number(m[1]), 99);
    for (const m of t.matchAll(/\b(\d{1,2})\s*(?:\+|plus)\s*(?:years?|yrs?|y)\b/gi)) push(m[0], Number(m[1]), 99);
    for (const m of t.matchAll(/\b(\d{1,2})\s*(?:years?|yrs?)\s*(?:and|&)\s*(?:up|over|older)\b/gi)) push(m[0], Number(m[1]), 99);
    for (const m of t.matchAll(/\b(?:not suitable for|unsuitable for) children under\s*(\d{1,2})\s*(years?|months?)?/gi)) push(m[0], Number(m[1]) / (/month/i.test(m[2] ?? '') ? 12 : 1), 99);
  }
  return out;
}

export function ageAnswer(items: ProductItem[], age: number, short: (t: string) => string): string {
  const top = items.slice(0, 3);
  const lines = top.map((p) => {
    const c = ageClaims(p)[0];
    if (!c) return null;
    const ok = age >= c.min && age <= c.max;
    return `The ${short(p.title)} listing says “${c.raw}”, so ${ok ? `that includes age ${age}` : `it isn’t listed for age ${age}`}.`;
  });
  const known = lines.filter(Boolean) as string[];
  if (!known.length) return `${top.length > 1 ? 'These listings don’t' : 'This listing doesn’t'} say what age ${top.length > 1 ? 'they are' : 'it is'} for, so I can’t tell if ${top.length > 1 ? 'they suit' : 'it suits'} a ${age}-year-old. Please check with the shop.`;
  const missing = top.length - known.length;
  return `${known.join(' ')}${missing ? ` ${missing === 1 ? 'One listing doesn’t' : `${missing} listings don’t`} say an age.` : ''} I only go by what the listing states.`;
}

export interface SellerFacts { retailer: string; host: string | null; https: boolean; irish: boolean; demo: boolean; priceFarBelow: boolean }
export function sellerFacts(item: ProductItem, all: ProductItem[], demo: boolean): SellerFacts {
  let host: string | null = null; let https = false;
  if (item.url) { try { const u = new URL(item.url); host = u.hostname.replace(/^www\./, ''); https = u.protocol === 'https:'; } catch { /* */ } }
  const prices = all.map((p) => p.price).filter((n) => n > 0).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  return { retailer: item.retailer, host, https, irish: Boolean(host?.endsWith('.ie')), demo, priceFarBelow: prices.length >= 3 && item.price > 0 && item.price < median * 0.5 };
}
export const SELLER_GUIDANCE = 'Before you buy: type the shop’s address yourself instead of using links from messages, look for a real address and a returns policy, and pay with PayPal or a credit card so you have buyer protection.';
/** Facts and guidance only. Never says a shop is safe or trustworthy. */
export function sellerAnswer(f: SellerFacts): string {
  if (f.demo) return 'This is the SaySafe Demo Shop, a test shop on PayPal Sandbox. No real money moves, and every payment still needs your approval at PayPal.';
  const facts = [f.host ? `the listing links to ${f.host}` : 'the listing has no web address', f.host && f.https ? 'a secure https address' : null, f.irish ? 'an Irish .ie address' : null].filter(Boolean).join(', ');
  return `I can’t vouch for any shop, and SaySafe hasn’t checked ${f.retailer}. What I can see: ${facts}.${f.priceFarBelow ? ' Its price is much lower than the other listings, which can be a warning sign.' : ''} ${SELLER_GUIDANCE}`;
}

/** ProductItem -> the shared ShopItem shape, so the existing compare logic can be reused. */
export function toShopItem(p: ProductItem): ShopItem {
  return {
    id: p.id, title: p.title, brand: p.brand, image: p.image, imageAlt: p.imageAlt, features: p.features, rating: p.rating ?? null,
    offers: [{ retailer: p.retailer, url: p.url ?? '', price: p.price, compareAt: p.compareAt, currency: p.currency, availability: p.availability, condition: null }],
    attributes: p.attributes, description: p.description ?? null,
  };
}
