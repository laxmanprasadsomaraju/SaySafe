/**
 * Shared, deterministic shopping logic for real-product discovery (Channel3).
 * Used by the server (/api/discover) and the browser (follow-ups, compare, read-aloud text).
 *
 * Ground rules:
 *  - Every reason, comparison and spoken phrase is built ONLY from fields present in the listing data.
 *  - No invented specs, delivery, reviews, ratings or merchant trust.
 *  - Ratings are only mentioned when the listing carried a rating object, and are always labelled as listed ratings.
 */

// ---------- Types ----------
export interface ShopOffer {
  retailer: string;
  url: string;
  price: number;
  compareAt: number | null;
  currency: string;
  availability: 'InStock' | 'OutOfStock' | 'Unknown';
  condition: string | null;
}
export interface ShopItem {
  id: string;
  title: string;
  brand: string | null;
  image: string | null;
  imageAlt: string;
  features: string[];
  rating: { value: number; count: number } | null;
  offers: ShopOffer[];
  category?: string | null;
  attributes?: Record<string, string[]>;
  /** Listing description (not shown in full; used only to check that a preference word is really in the data). */
  description?: string | null;
  dimensions?: { label: string; value: string } | null;
}

export interface ShoppingProfile {
  colours: string[];
  brands: string[];
  styles: string[];
  avoid: string[];
  categories: string[];
  budgetMax: number | null;
}
export const EMPTY_PROFILE: ShoppingProfile = { colours: [], brands: [], styles: [], avoid: [], categories: [], budgetMax: null };

export interface Budget { max: number | null; min: number | null }
export interface ParsedRequest { budget: Budget; keywords: string[]; wantsCheap: boolean; productQuery: string }

export type PickRole = 'best' | 'cheaper' | 'another';
export interface Pick { role: PickRole; id: string; reasons: string[]; score: number }
export interface Recommendation {
  picks: Pick[];
  /** All listings that passed the filters, best first. */
  rankedIds: string[];
  /** Listings removed because they contain something on the avoid list. */
  avoidedCount: number;
  /** The usual budget from the profile was applied as a filter (no budget in the request). */
  usedProfileBudget: number | null;
  /** The usual budget would have removed everything, so it was not applied. */
  profileBudgetRelaxed: boolean;
}

// ---------- Text helpers ----------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (hay: string, word: string) => word.trim().length > 0 && new RegExp(`(^|[^a-z0-9])${esc(word.toLowerCase().trim())}(s|es)?([^a-z0-9]|$)`, 'i').test(hay);
const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(es|s)$/, '');
export const money = (n: number, currency = 'EUR') => (currency === 'EUR' ? `€${n.toFixed(n % 1 ? 2 : 0)}` : `${n.toFixed(2)} ${currency}`);

const STOP = new Set(['find', 'me', 'a', 'an', 'the', 'some', 'i', 'need', 'want', 'looking', 'for', 'get', 'buy', 'show', 'only', 'just', 'please', 'can', 'you', 'with', 'and', 'or', 'of', 'to', 'in', 'on', 'that', 'is', 'it', 'my', 'new', 'good', 'nice', 'best', 'cheap', 'cheaper', 'cheapest', 'affordable', 'budget', 'price', 'under', 'below', 'less', 'than', 'up', 'max', 'maximum', 'euro', 'euros', 'eur', 'around', 'about', 'between', 'real', 'shop', 'shops', 'ireland', 'irish', 'online', 'would', 'like', 'something', 'one', 'ones', 'which', 'what', 'have', 'has', 'any',
  // "Compare real shops for X": request words, not product features (they used to show up as "its listing mentions 'compare'").
  'compare', 'comparing', 'comparison', 'compared', 'prices', 'listings', 'listing', 'retailers', 'retailer', 'stores', 'store', 'other', 'look', 'search', 'see']);

/** Text a listing actually contains, lower-cased, for matching. */
export function listingText(p: ShopItem): string {
  const attrs = p.attributes ? Object.values(p.attributes).flat().join(' ') : '';
  return `${p.title} ${p.brand ?? ''} ${p.category ?? ''} ${p.features.join(' ')} ${attrs} ${p.description ?? ''}`.toLowerCase();
}

// ---------- Budget + request parsing ----------
const NUM = String.raw`(\d{1,6}(?:[.,]\d{1,2})?)`;
const CUR = String.raw`(?:€|eur(?:os?)?|euros?)`;
const toNum = (s: string) => Number(s.replace(',', '.'));

export function parseBudget(text: string): Budget {
  const s = text.toLowerCase().replace(/\s+/g, ' ');
  const between = s.match(new RegExp(String.raw`between\s*${CUR}?\s*${NUM}\s*${CUR}?\s*(?:and|-|to)\s*${CUR}?\s*${NUM}`));
  if (between) {
    const a = toNum(between[1]), b = toNum(between[2]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const maxRe = [
    new RegExp(String.raw`(?:under|below|less than|cheaper than|no more than|not more than|max(?:imum)?(?: of)?|up to|within|at most|<)\s*${CUR}?\s*${NUM}`),
    new RegExp(String.raw`${CUR}\s*${NUM}\s*(?:or less|max(?:imum)?|tops|budget)`),
    new RegExp(String.raw`${NUM}\s*${CUR}\s*(?:or less|max(?:imum)?|tops|budget)`),
    new RegExp(String.raw`budget (?:of|is)?\s*${CUR}?\s*${NUM}`),
  ];
  for (const re of maxRe) {
    const m = s.match(re);
    if (m) { const v = toNum(m[1]); if (v > 0) return { max: v, min: null }; }
  }
  const min = s.match(new RegExp(String.raw`(?:over|above|more than|at least)\s*${CUR}?\s*${NUM}`));
  return { max: null, min: min ? toNum(min[1]) : null };
}

/** Remove budget phrases so they don't end up in the product search words. */
export function stripBudget(text: string): string {
  return text
    .replace(new RegExp(String.raw`between\s*${CUR}?\s*${NUM}\s*${CUR}?\s*(?:and|-|to)\s*${CUR}?\s*${NUM}\s*${CUR}?`, 'gi'), ' ')
    .replace(new RegExp(String.raw`(?:under|below|less than|cheaper than|no more than|not more than|max(?:imum)?(?: of)?|up to|within|at most|over|above|more than|at least|<)\s*${CUR}?\s*${NUM}\s*${CUR}?`, 'gi'), ' ')
    .replace(new RegExp(String.raw`(?:budget (?:of|is)?\s*)?${CUR}?\s*${NUM}\s*${CUR}?\s*(?:or less|max(?:imum)?|tops|budget)?`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRequest(text: string): ParsedRequest {
  const budget = parseBudget(text);
  const rest = stripBudget(text);
  const words = rest.split(/\s+/).map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter((w) => w.length >= 2 && !STOP.has(w));
  return {
    budget,
    keywords: [...new Set(words)],
    wantsCheap: /\b(cheap|cheapest|cheaper|affordable|budget|low[- ]cost|inexpensive)\b/i.test(text),
    productQuery: words.join(' ') || rest,
  };
}

// ---------- Profile ----------
const cleanTerm = (v: unknown) => (typeof v === 'string' ? v.normalize('NFKC').replace(/[\u0000-\u001f\u007f<>{}`\\[\]|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '');
const cleanList = (v: unknown) => [...new Set((Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(cleanTerm).filter((x) => x.length >= 2))].slice(0, 10);

/** Accepts anything (request body, localStorage) and returns a safe, size-limited profile. */
export function sanitizeProfile(raw: unknown): ShoppingProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const b = typeof r.budgetMax === 'number' ? r.budgetMax : typeof r.budgetMax === 'string' ? Number(r.budgetMax) : NaN;
  return {
    colours: cleanList(r.colours),
    brands: cleanList(r.brands),
    styles: cleanList(r.styles),
    avoid: cleanList(r.avoid),
    categories: cleanList(r.categories),
    budgetMax: Number.isFinite(b) && b > 0 && b <= 100000 ? Math.round(b * 100) / 100 : null,
  };
}
export const profileIsEmpty = (p: ShoppingProfile) => !p.colours.length && !p.brands.length && !p.styles.length && !p.avoid.length && !p.categories.length && p.budgetMax === null;

/** Short summary of the profile, for the AI explanation prompt (passed as data, never as instructions). */
export function profileSummary(p: ShoppingProfile): string {
  const parts: string[] = [];
  if (p.colours.length) parts.push(`likes colours: ${p.colours.join(', ')}`);
  if (p.brands.length) parts.push(`likes brands: ${p.brands.join(', ')}`);
  if (p.styles.length) parts.push(`likes styles: ${p.styles.join(', ')}`);
  if (p.avoid.length) parts.push(`avoids: ${p.avoid.join(', ')}`);
  if (p.categories.length) parts.push(`shops for: ${p.categories.join(', ')}`);
  if (p.budgetMax !== null) parts.push(`usual budget up to €${p.budgetMax}`);
  return parts.join('; ').slice(0, 400);
}

// ---------- Ranking ----------
const bestOffer = (p: ShopItem) => p.offers[0];
export const priceOf = (p: ShopItem) => bestOffer(p)?.price ?? Infinity;

interface Scored { p: ShopItem; score: number; reasons: string[]; matched: number }

/**
 * The category most of the matching listings share (e.g. "Microwave Ovens" for "microwave"),
 * so accessories that merely mention the word (brackets, rice cookers) don't outrank the thing itself.
 */
export function primaryCategory(items: ShopItem[], keywords: string[]): string | null {
  const counts = new Map<string, { n: number; kw: number }>();
  for (const p of items) {
    if (!p.category) continue;
    const c = p.category.toLowerCase();
    const kw = keywords.filter((k) => c.includes(stem(k))).length;
    const e = counts.get(c) ?? { n: 0, kw };
    e.n++; counts.set(c, e);
  }
  const best = [...counts.entries()].filter(([, v]) => v.kw > 0 || v.n >= 2).sort((a, b) => b[1].kw - a[1].kw || b[1].n - a[1].n || a[0].localeCompare(b[0]))[0];
  return best && best[1].n >= 2 ? best[0] : null;
}

function scoreItem(p: ShopItem, req: ParsedRequest, profile: ShoppingProfile, effMax: number | null, minPrice: number, maxPrice: number, primary: string | null = null): Scored {
  const hay = listingText(p);
  const titleCat = `${p.title} ${p.category ?? ''}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  const o = bestOffer(p);

  // 1. Match to the request (title/category count double).
  const kws = req.keywords;
  const matchedKw = kws.filter((k) => hay.includes(stem(k)) || hasWord(hay, k));
  const featureKw = matchedKw.filter((k) => !titleCat.includes(stem(k)));
  if (kws.length) score += 40 * (matchedKw.length / kws.length) + 10 * (kws.filter((k) => titleCat.includes(stem(k))).length / kws.length);
  if (primary && p.category?.toLowerCase() === primary) {
    const kwInCat = kws.length ? kws.filter((k) => primary.includes(stem(k))).length / kws.length : 1;
    score += 25 * Math.max(kwInCat, kws.length ? 0 : 1);
  }
  if (featureKw.length) reasons.push(`its listing mentions ${featureKw.map((k) => `“${k}”`).join(' and ')}`);

  // 2. Price, strictly inside the budget (already filtered).
  if (effMax !== null) reasons.push(`${money(o.price, o.currency)} at ${o.retailer}, within your ${money(effMax, o.currency)} budget`);
  const spread = maxPrice - minPrice || 1;
  score += (req.wantsCheap ? 25 : 6) * (1 - (o.price - minPrice) / spread);
  if (req.wantsCheap && o.price === minPrice) reasons.push('the lowest price in these results');

  // 3. Availability as listed.
  if (o.availability === 'InStock') { score += 15; reasons.push('listed as in stock'); }
  else if (o.availability === 'OutOfStock') score -= 25;

  // 4. Completeness of the listing data.
  const complete = (p.image ? 1 : 0) + Math.min(p.features.length, 5) / 5 + (p.brand ? 0.5 : 0) + (p.attributes && Object.keys(p.attributes).length ? 0.5 : 0);
  score += 3 * complete;

  // 5. Profile boosts: only when the listing data actually contains the term.
  for (const c of profile.colours) if (hasWord(hay, c)) { score += 6; reasons.push(`matches your preference for ${c}`); break; }
  for (const b of profile.brands) if ((p.brand && p.brand.toLowerCase() === b.toLowerCase()) || hasWord(`${p.title} ${p.brand ?? ''}`.toLowerCase(), b)) { score += 8; reasons.push(`it’s ${p.brand ?? b}, a brand you like`); break; }
  for (const s of profile.styles) if (hasWord(hay, s)) { score += 5; reasons.push(`matches your preference for ${s}`); break; }
  for (const c of profile.categories) if (hasWord(titleCat, c) || hasWord(titleCat, c.replace(/s$/, ''))) { score += 3; break; }

  return { p, score: Math.round(score * 100) / 100, reasons, matched: matchedKw.length };
}

/** Deterministic ranking + picks. `items` must already be relevant to the query. */
export function recommend(items: ShopItem[], req: ParsedRequest, profile: ShoppingProfile = EMPTY_PROFILE): Recommendation {
  // Avoid list: drop anything whose listing contains an avoided term.
  let pool = items.filter((p) => p.offers.length > 0);
  const before = pool.length;
  pool = pool.filter((p) => !profile.avoid.some((a) => hasWord(listingText(p), a)));
  const avoidedCount = before - pool.length;

  // Strict budget. A budget in the request wins; otherwise the usual budget from the profile.
  let effMax = req.budget.max;
  let usedProfileBudget: number | null = null;
  let profileBudgetRelaxed = false;
  if (effMax === null && profile.budgetMax !== null) {
    if (pool.some((p) => priceOf(p) <= profile.budgetMax!)) { effMax = profile.budgetMax; usedProfileBudget = profile.budgetMax; }
    else if (pool.length) profileBudgetRelaxed = true;
  }
  if (effMax !== null) pool = pool.filter((p) => priceOf(p) <= effMax!);
  if (req.budget.min !== null) pool = pool.filter((p) => priceOf(p) >= req.budget.min!);

  const prices = pool.map(priceOf);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const primary = primaryCategory(pool, req.keywords);
  const scored = pool.map((p) => scoreItem(p, req, profile, effMax, minP, maxP, primary))
    .sort((a, b) => b.score - a.score || priceOf(a.p) - priceOf(b.p) || a.p.id.localeCompare(b.p.id));

  const picks: Pick[] = [];
  // Alternatives must be close to the best match in relevance, not just cheaper accessories.
  const relevantEnough = (s: Scored) => (!req.keywords.length || s.matched > 0) && (!scored[0] || s.score >= scored[0].score * 0.85);
  const best = scored[0];
  if (best) {
    picks.push({ role: 'best', id: best.p.id, reasons: best.reasons.length ? best.reasons : ['it matched your search most closely'], score: best.score });
    const bp = priceOf(best.p);
    const cheaper = scored.filter((s) => s !== best && priceOf(s.p) < bp && relevantEnough(s) && bestOffer(s.p).availability !== 'OutOfStock')[0];
    if (cheaper) {
      const o = bestOffer(cheaper.p);
      picks.push({ role: 'cheaper', id: cheaper.p.id, score: cheaper.score, reasons: [`${money(bp - o.price, o.currency)} less than the best match: ${money(o.price, o.currency)} at ${o.retailer}`, ...cheaper.reasons.filter((r) => !r.includes('budget')).slice(0, 2)] });
    }
    const another = scored.find((s) => s !== best && s !== cheaper && relevantEnough(s));
    if (another) picks.push({ role: 'another', id: another.p.id, score: another.score, reasons: another.reasons.length ? another.reasons.slice(0, 3) : ['also matches your search'] });
  }
  return { picks, rankedIds: scored.map((s) => s.p.id), avoidedCount, usedProfileBudget, profileBudgetRelaxed };
}

// ---------- Specs (only what the listing text states) ----------
export interface Specs { powerW: number | null; capacityL: number | null }
export function extractSpecs(p: ShopItem): Specs {
  const text = `${p.title} ${p.features.join(' ')}`;
  const w = text.match(/(\d{3,4})\s?(?:w\b|watts?\b)/i);
  const l = text.match(/(\d{1,3}(?:\.\d)?)\s?(?:l\b|litres?\b|liters?\b|ltrs?\b)/i);
  return { powerW: w ? Number(w[1]) : null, capacityL: l ? Number(l[1]) : null };
}

export interface CompareRow { label: string; values: (string | null)[] }
export function compareRows(items: ShopItem[]): CompareRow[] {
  const specs = items.map(extractSpecs);
  const rows: CompareRow[] = [
    { label: 'Price', values: items.map((p) => money(p.offers[0].price, p.offers[0].currency)) },
    { label: 'Shop', values: items.map((p) => p.offers[0].retailer) },
    { label: 'Stock (as listed)', values: items.map((p) => ({ InStock: 'In stock', OutOfStock: 'Out of stock', Unknown: null })[p.offers[0].availability]) },
    { label: 'Brand', values: items.map((p) => p.brand) },
    { label: 'Power (listed)', values: specs.map((s) => (s.powerW ? `${s.powerW} W` : null)) },
    { label: 'Capacity (listed)', values: specs.map((s) => (s.capacityL ? `${s.capacityL} L` : null)) },
    { label: 'Size (listed)', values: items.map((p) => p.dimensions?.value ?? null) },
    { label: 'Listed rating', values: items.map((p) => (p.rating ? `${p.rating.value.toFixed(1)} / 5 from ${p.rating.count} ratings` : null)) },
    { label: 'Key features', values: items.map((p) => (p.features.length ? p.features.slice(0, 3).join('; ') : null)) },
  ];
  // Drop rows where no item has data.
  return rows.filter((r) => r.values.some((v) => v !== null));
}

/** Plain answer to "which has better specifications": only listed numbers, and says what is missing. */
export function specsAnswer(items: ShopItem[], names: string[]): string {
  const specs = items.map(extractSpecs);
  const parts: string[] = [];
  const one = (key: keyof Specs, label: string, unit: string, more: string) => {
    const have = specs.map((s, i) => ({ v: s[key], i })).filter((x) => x.v !== null) as { v: number; i: number }[];
    const missing = specs.map((s, i) => (s[key] === null ? names[i] : null)).filter(Boolean);
    if (have.length >= 2) {
      const top = have.reduce((a, b) => (b.v > a.v ? b : a));
      const tie = have.filter((h) => h.v === top.v).length > 1;
      parts.push(tie ? `${label}: the same listed ${top.v} ${unit}.` : `${more}: ${names[top.i]}, ${top.v} ${unit}.`);
    } else if (have.length === 1) parts.push(`Only ${names[have[0].i]} lists its ${label.toLowerCase()} (${have[0].v} ${unit}).`);
    if (missing.length && have.length) parts.push(`${missing.join(' and ')} ${missing.length > 1 ? "don't" : "doesn't"} list ${label.toLowerCase()}.`);
  };
  one('powerW', 'Power', 'watts', 'Most listed power');
  one('capacityL', 'Capacity', 'litres', 'Largest listed capacity');
  if (!parts.length) return "These listings don't give comparable specifications, so I can't say which is better on specs. The compare table shows what each one does list.";
  return `${parts.join(' ')} I'm only comparing what the listings state.`;
}

// ---------- Spoken text (short, built separately from the screen) ----------
export const shortTitle = (t: string) => { const w = t.replace(/\s*[,|(].*$/, '').split(/\s+/); return w.length > 8 ? `${w.slice(0, 8).join(' ')}` : w.join(' '); };

/**
 * "Keep answers short": keep only the first `maxSentences` whole sentences (never cuts mid-sentence, so a price or a
 * name is never chopped). Deterministic; used for the Assistant's reply text and the AI explanation.
 */
export function shortenText(text: string, maxSentences = 1): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z“"€0-9])/);
  return parts.length <= maxSentences ? t : parts.slice(0, maxSentences).join(' ');
}

export function spokenRecommendation(items: ShopItem[], rec: Recommendation, query: string, opts: { short?: boolean } = {}): string {
  const best = rec.picks.find((p) => p.role === 'best');
  if (!best) return opts.short ? `I couldn't find ${query || 'that'} within that budget.` : `I couldn't find ${query || 'that'} in listings for Ireland within that budget. Try other words or a higher price.`;
  const p = items.find((x) => x.id === best.id)!;
  const o = p.offers[0];
  // Short: the pick, its price and shop, and where you'd buy it. No reasons, no follow-up question.
  if (opts.short) return `My best match is the ${shortTitle(p.title)}, ${money(o.price, o.currency)} at ${o.retailer}. You'd buy it on the shop's own website.`;
  const why = best.reasons.filter((r) => !r.startsWith('€')).slice(0, 2);
  const budget = best.reasons.find((r) => r.includes('budget'));
  const clause = (r: string) => (/^(listed|the lowest)/.test(r) ? `it's ${r}` : /^matches/.test(r) ? `it ${r}` : r);
  const reasonText = [budget ? `it's within your budget` : null, ...why.filter((r) => !r.includes('budget')).map(clause)].filter(Boolean).slice(0, 2).join(', and ');
  const followUp = rec.picks.length > 1 ? ' Would you like a cheaper option or a comparison?' : '';
  return `My best match is the ${shortTitle(p.title)}, ${money(o.price, o.currency)} at ${o.retailer}${reasonText ? `. I picked it because ${reasonText}` : ''}. You'd buy it on the shop's own website.${followUp}`;
}

/** One segment per listing, for the opt-in "Read everything" mode. */
export function readAllSegments(items: ShopItem[]): string[] {
  return items.map((p, i) => {
    const o = p.offers[0];
    const stock = o.availability === 'InStock' ? 'Listed as in stock.' : o.availability === 'OutOfStock' ? 'Listed as out of stock.' : '';
    const feats = p.features.slice(0, 2).join('. ');
    return `Listing ${i + 1} of ${items.length}: ${p.title}. ${money(o.price, o.currency)} at ${o.retailer}. ${stock} ${feats ? feats + '.' : ''}`.replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
  });
}

export function describeItem(p: ShopItem, label: string): string {
  const o = p.offers[0];
  const s = extractSpecs(p);
  const facts = [s.powerW ? `${s.powerW} watts` : null, s.capacityL ? `${s.capacityL} litres` : null].filter(Boolean);
  const feats = p.features.filter((f) => !/\d{3,4}\s?w\b|\d\s?l\b|litre/i.test(f)).slice(0, 2);
  return `${label}: ${shortTitle(p.title)}, ${money(o.price, o.currency)} at ${o.retailer}. ${facts.length ? `The listing says ${facts.join(' and ')}. ` : ''}${feats.length ? `It lists ${feats.join(', and ').toLowerCase()}.` : ''}`.trim();
}

// ---------- Follow-up intents ----------
export type Followup =
  | { kind: 'stop' }
  | { kind: 'why'; index: number | null }
  | { kind: 'cheaper' }
  | { kind: 'specs' }
  | { kind: 'budget'; max: number }
  | { kind: 'more'; index: number }
  | { kind: 'search'; text: string };

const ORD: Record<string, number> = { first: 0, '1st': 0, one: 0, second: 1, '2nd': 1, two: 1, third: 2, '3rd': 2, three: 2, last: 2 };
function ordinal(s: string): number | null {
  const m = s.match(/\b(first|second|third|1st|2nd|3rd|last)\b/) ?? s.match(/\b(?:option|number|no\.?)\s*(one|two|three|1|2|3)\b/);
  if (!m) {
    if (/\b(cheaper|lower[- ]cost) one\b/.test(s)) return 1;
    if (/\bbest (one|match)\b/.test(s)) return 0;
    return null;
  }
  const k = m[1];
  return /^\d$/.test(k) ? Number(k) - 1 : ORD[k] ?? null;
}

/** Deterministic parser for follow-ups about the results already on screen. */
export function parseFollowup(text: string, hasResults: boolean): Followup {
  const s = text.toLowerCase().trim().replace(/[!?.]+$/, '');
  if (/^(no,? )?(stop|stop talking|stop reading|be quiet|quiet|hush|shush|silence|enough|that's enough|shut up)\b/.test(s) || /\bstop (talking|reading|speaking)\b/.test(s)) return { kind: 'stop' };
  if (!hasResults) return { kind: 'search', text };
  if (/\bwhy\b/.test(s) && /\b(recommend|pick|picked|choose|chose|this|that|it|one)\b/.test(s)) return { kind: 'why', index: ordinal(s) };
  if (/\b(spec|specs|specification|specifications|more powerful|bigger|which is better|which one is better|compare)\b/.test(s)) return { kind: 'specs' };
  if (/\b(tell me more|more about|more detail|details (on|about|of)|what about|describe)\b/.test(s)) { const i = ordinal(s); if (i !== null) return { kind: 'more', index: i }; }
  const b = parseBudget(s);
  const rest = parseRequest(s).keywords.filter((k) => !['show', 'only', 'just', 'those', 'them', 'ones', 'filter', 'items', 'results', 'option', 'options', 'no', 'yes', 'ok', 'okay', 'actually', 'instead', 'rather', 'let', 'see', 'look', 'at', 'these', 'all', 'more', 'please'].includes(k));
  if (b.max !== null && rest.length === 0) return { kind: 'budget', max: b.max };
  if (/\b(cheaper|less expensive|lower price|lower[- ]cost|cheapest|more affordable)\b/.test(s) && rest.length === 0) return { kind: 'cheaper' };
  return { kind: 'search', text };
}

// ---------- AI explanation guard ----------
const BANNED_ALWAYS = /\b(deliver|delivery|shipping|warrant|guarantee|trusted|trustworthy|reputable|reliable|best[- ]?selling|popular|safe to buy|genuine|appeal|ideal|perfect|great|excellent|eas(?:y|ier|ily)|straightforward|helpful|safe|safety|older|senior|convenient|older adults?|elderly|quality|durable|value for money|bargain)\w*/i;
const RATING_WORDS = /\b(review|reviews|rating|ratings|rated|stars?)\b/i;

/**
 * Accepts an AI-written explanation only if it cites nothing the listing JSON doesn't contain:
 * no delivery/warranty/trust claims, no ratings unless a rating was returned (then they must be called "listed"),
 * and every number it mentions must appear in the data.
 */
export function explanationIsGrounded(text: string, item: ShopItem, extraNumbers: number[] = [], profile: ShoppingProfile = EMPTY_PROFILE): boolean {
  if (!text || text.length > 320) return false;
  // A preference may only be named if the listing data really contains it.
  const hay = listingText(item);
  for (const term of [...profile.colours, ...profile.brands, ...profile.styles]) if (hasWord(text.toLowerCase(), term) && !hasWord(hay, term)) return false;
  if (BANNED_ALWAYS.test(text)) return false;
  if (RATING_WORDS.test(text) && (!item.rating || !/\blisted\b/i.test(text))) return false;
  if (/\breview/i.test(text)) return false; // Channel3 returns aggregate ratings only, never review text
  const data = JSON.stringify(item) + ' ' + extraNumbers.join(' ');
  const nums = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return nums.every((n) => data.includes(n.replace(',', '.')) || data.includes(n));
}
