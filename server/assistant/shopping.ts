/**
 * Shopping request understanding (deterministic). Turns "black women's Nike T-shirts under €40" into a structured
 * Channel3 request: product words, brand, audience, colour, price range, size, retailer, and a gift recipient.
 *
 * Privacy: only product terms leave the server. A gift recipient ("for my grandson") is noted for the reply and
 * dropped from everything sent to Channel3. Names, relations, ids and amounts owed never go to Channel3.
 */
import { parseBudget } from '../../shared/shopping.js';
import { COLOURS } from '../memory/extract.js';
import type { SearchFiltersIn } from '../catalogue/channel3.js';

export interface ShoppingSpec {
  /** The product words only (no brand, colour, audience, budget, size or recipient). */
  product: string;
  brand: string | null;
  gender: 'female' | 'male' | null;
  age: 'kids' | 'adult' | null;
  colour: string | null;
  maxPrice: number | null;
  minPrice: number | null;
  size: string | null;
  retailer: string | null;
  /** "for my grandson": a relation word only, for the reply. Never sent anywhere. */
  recipient: string | null;
  cheapest: boolean;
}

/** Brands we recognise in lower-case text (a capitalised unknown word is also treated as a brand, below). */
const BRANDS = ['nike', 'adidas', 'puma', 'reebok', 'new balance', 'asics', 'under armour', 'levi\'s', 'levis', 'skechers', 'converse', 'vans', 'the north face', 'columbia',
  'sony', 'playstation', 'nintendo', 'xbox', 'microsoft', 'apple', 'samsung', 'lg', 'philips', 'panasonic', 'bosch', 'siemens', 'tefal', 'breville', 'russell hobbs', 'morphy richards',
  'delonghi', 'de\'longhi', 'kenwood', 'swan', 'smeg', 'dualit', 'sage', 'ninja', 'dyson', 'shark', 'lego', 'hotpoint', 'beko', 'sharp', 'logik', 'kitchenaid', 'salter', 'tower', 'lenovo', 'hp', 'dell', 'kindle', 'amazon', 'fitbit', 'garmin', 'jbl', 'bose', 'roberts'];
const BRAND_CASE: Record<string, string> = { 'levi\'s': 'Levi\'s', levis: 'Levi\'s', lg: 'LG', hp: 'HP', jbl: 'JBL', 'de\'longhi': 'De\'Longhi', delonghi: 'De\'Longhi', playstation: 'Sony' };
/** Retailers -> domains for Channel3's website_ids filter (it accepts domains). */
const RETAILERS: Record<string, string> = { argos: 'argos.ie', currys: 'currys.ie', 'harvey norman': 'harveynorman.ie', 'did electrical': 'did.ie', did: 'did.ie', 'jd sports': 'jdsports.ie', jd: 'jdsports.ie', zalando: 'zalando.ie', decathlon: 'decathlon.ie', 'arnotts': 'arnotts.ie', 'brown thomas': 'brownthomas.com', next: 'next.co.uk', 'nike.com': 'nike.com', smyths: 'smythstoys.com', 'power city': 'powercity.ie', 'dunnes': 'dunnesstores.com', 'marks and spencer': 'marksandspencer.com', 'm&s': 'marksandspencer.com', 'harvey norman ireland': 'harveynorman.ie' };
const RELATIONS = 'grandson|granddaughter|grandchild|grandkids?|son|daughter|husband|wife|partner|friend|neighbou?r|nephew|niece|brother|sister|mum|mam|mother|dad|father|carer|grandchildren|children|kids';
const SIZES: [RegExp, string][] = [[/\b(?:size\s+)?(?:extra[- ]small|xs)\b/i, 'XS'], [/\bsize\s+small\b|\bin small\b|\b(?:a )?small size\b/i, 'S'], [/\bsize\s+medium\b|\bin medium\b|\bmedium size\b|\bsize m\b/i, 'M'], [/\bsize\s+large\b|\bin large\b|\blarge size\b|\bsize l\b/i, 'L'], [/\b(?:size\s+)?(?:extra[- ]large|xl)\b/i, 'XL'], [/\b(?:size\s+)?xxl\b/i, 'XXL'], [/\bsize\s+(\d{1,2}(?:\.5)?)\b/i, '$1']];

/** Budget phrases only (unlike shared stripBudget, a bare model number like "PS5" or "size 9" is kept). */
function stripMoney(text: string): string {
  const CUR = String.raw`(?:€|eur(?:os?)?\b|euros?\b)`; const NUM = String.raw`(\d{1,6}(?:[.,]\d{1,2})?)`;
  return text
    .replace(new RegExp(String.raw`between\s*${CUR}?\s*${NUM}\s*${CUR}?\s*(?:and|-|to)\s*${CUR}?\s*${NUM}\s*${CUR}?`, 'gi'), ' ')
    .replace(new RegExp(String.raw`(?:under|below|less than|cheaper than|no more than|not more than|max(?:imum)?(?: of)?|up to|within|at most|over|above|more than|at least|<)\s*${CUR}?\s*${NUM}\s*${CUR}?`, 'gi'), ' ')
    .replace(new RegExp(String.raw`(?:budget (?:of|is)?\s*)?€\s*${NUM}|${NUM}\s*(?:euros?|eur)\b`, 'gi'), ' ')
    .replace(/\b(?:or less|tops)\b/gi, ' ');
}

const has = (s: string, w: string) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(s);
const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** Leading request words and filler, removed from the product words. */
const LEAD = /^(?:(?:hi|hello|hey|ok|okay|so|please|um|well)[, ]+)*(?:(?:can|could|would) you |please |i(?:'d| would) like (?:to )?|i want(?: to)? |i need(?: to)? |i'm looking for |i am looking for |help me |let's |lets |do you have |have you got |are there (?:any )?|is there (?:a |an )?|show me |find me |get me |buy me |search for |look for |looking for |find |show |search |get |buy |shop for |order |purchase )+/i;
const FILLER = /\b(?:please|thanks|thank you|now|today|for now|some|any|a|an|the|me|for me|new|good|nice|real|listings?|products?|options?|in ireland|online|that|which|one|ones|to buy|buy|find|show|search|instead|version|also|only|just|again|available|cheap(?:er|est)?|affordable|budget|price|prices|real shops?|shops?|stores?)\b/gi;

export function parseShopping(text: string): ShoppingSpec {
  const raw = text.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  let s = raw;
  const l = raw.toLowerCase();
  // Gift recipient (relation only; dropped from the search).
  const rec = s.match(new RegExp(`\\b(?:as a (?:present|gift) )?for (?:my|our) (${RELATIONS})(?:'s)?(?: (?:birthday|christmas|present|gift))?\\b`, 'i'));
  const recipient = rec ? rec[1].toLowerCase() : /\b(?:a )?(?:present|gift)\b/i.test(s) ? 'someone' : null;
  if (rec) s = s.replace(rec[0], ' ');
  s = s.replace(/\b(?:as a |for a )?(?:present|gift|birthday present|christmas present)\b/gi, ' ');

  // Size.
  let size: string | null = null;
  for (const [re, v] of SIZES) { const m = s.match(re); if (m) { size = v.startsWith('$') ? m[1] : v; s = s.replace(m[0], ' '); break; } }
  const budget = parseBudget(s);
  s = stripMoney(s);
  // Audience.
  let gender: ShoppingSpec['gender'] = null; let age: ShoppingSpec['age'] = null;
  if (/\b(women'?s|womens|woman'?s|ladies'?|lady'?s|female|for women|for her)\b/i.test(s)) { gender = 'female'; age = 'adult'; }
  else if (/\b(men'?s|mens|man'?s|gents'?|male|for men|for him)\b/i.test(s)) { gender = 'male'; age = 'adult'; }
  if (/\b(girls'?|girl'?s)\b/i.test(s)) { gender = 'female'; age = 'kids'; }
  else if (/\b(boys'?|boy'?s)\b/i.test(s)) { gender = 'male'; age = 'kids'; }
  else if (/\b(kids'?|children'?s|child'?s|toddler)\b/i.test(s)) age = 'kids';
  if (!gender && recipient && /^(grandson|son|nephew|brother|husband|dad|father)$/.test(recipient) && /\b(t-?shirts?|shirts?|jumpers?|hoodies?|jackets?|shoes?|trainers?|clothes|socks|pyjamas?)\b/i.test(s)) gender = 'male';
  if (!gender && recipient && /^(granddaughter|daughter|niece|sister|wife|mum|mam|mother)$/.test(recipient) && /\b(t-?shirts?|shirts?|jumpers?|hoodies?|jackets?|shoes?|trainers?|clothes|socks|pyjamas?|dress(?:es)?)\b/i.test(s)) gender = 'female';
  s = s.replace(/\b(women'?s|womens|woman'?s|ladies'?|lady'?s|female|for women|for her|men'?s|mens|man'?s|gents'?|male|for men|for him|girls'?|girl'?s|boys'?|boy'?s|kids'?|children'?s|child'?s)\b/gi, ' ');
  // Colour.
  const colour = COLOURS.find((c) => has(s.toLowerCase(), c)) ?? null;
  if (colour) s = s.replace(new RegExp(`\\b${colour}\\b`, 'i'), ' ');
  // Retailer ("from Argos", "at Currys", "on Zalando").
  let retailer: string | null = null;
  for (const [name, dom] of Object.entries(RETAILERS).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`\\b(?:from|at|on|in)\\s+${name.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}\\b`, 'i');
    if (re.test(s)) { retailer = dom; s = s.replace(re, ' '); break; }
  }
  // Brand.
  let brand: string | null = null;
  const sl = s.toLowerCase();
  for (const b of [...BRANDS].sort((a, b2) => b2.length - a.length)) if (has(sl, b)) { brand = BRAND_CASE[b] ?? titleCase(b); s = s.replace(new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}\\b`, 'i'), ' '); break; }
  const ps = /\b(ps5|ps4|playstation ?5|playstation)\b/i.test(raw);
  if (ps) brand = null; // "PS5" is the product; the brand filter would only narrow it to accessories.
  const cheapest = /\b(cheap|cheaper|cheapest|affordable|budget|low[- ]cost|inexpensive)\b/i.test(l);
  // Product words.
  let product = s.replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim().replace(LEAD, '').replace(FILLER, ' ').replace(/['"]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  product = product.replace(/\bt[- ]?shirts?\b|\btees?\b/g, 't-shirt').replace(/\b(t-shirt)( t-shirt)+\b/g, '$1').replace(/\s+\b(in|with|of|from|at|on|and)$/g, '').trim();
  if (ps && !/ps5|playstation/.test(product)) product = `ps5 ${product}`.trim();
  return { product, brand, gender, age, colour, maxPrice: budget.max, minPrice: budget.min, size, retailer, recipient, cheapest };
}

/** The text sent to Channel3 as the query: product words (+ brand, colour, size words as plain terms). Never the recipient. */
export function channel3Query(sp: ShoppingSpec, opts: { colour?: string | null } = {}): string {
  const colour = opts.colour === undefined ? sp.colour : opts.colour;
  const aud = sp.gender === 'female' ? (sp.age === 'kids' ? 'girls' : 'women\'s') : sp.gender === 'male' ? (sp.age === 'kids' ? 'boys' : 'men\'s') : sp.age === 'kids' ? 'kids' : '';
  return [colour, aud, sp.brand, sp.product].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Structured Channel3 filters (only documented names; colour is ranked locally, see channel3.ts). */
export function channel3Filters(sp: ShoppingSpec): SearchFiltersIn {
  return {
    gender: sp.gender, age: sp.age === 'kids' ? ['kids'] : sp.age === 'adult' ? ['adult'] : null,
    brand: sp.brand, websites: sp.retailer ? [sp.retailer] : null, minPrice: sp.minPrice,
  };
}

/** Back to one readable request string (stored with the products shown, re-parsed for refinements). */
export function specText(sp: ShoppingSpec): string {
  const parts = [channel3Query(sp)];
  if (sp.size) parts.push(`size ${sp.size}`);
  if (sp.retailer) parts.push(`from ${Object.entries(RETAILERS).find(([, d]) => d === sp.retailer)?.[0] ?? sp.retailer}`);
  if (sp.minPrice && sp.maxPrice) parts.push(`between €${sp.minPrice} and €${sp.maxPrice}`);
  else if (sp.maxPrice) parts.push(`under €${sp.maxPrice}`);
  else if (sp.minPrice) parts.push(`over €${sp.minPrice}`);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Is this a product search at all (as opposed to records, chat, a scam check)? Conservative. */
export function looksLikeProductSearch(text: string): boolean {
  const s = text.toLowerCase().replace(/[’]/g, "'").trim();
  if (s.length > 200 || /https?:|www\./.test(s)) return false;
  if (/\b(pay|paid|payment|transaction|receipt|subscription|contact|scam|message|limit|preferences?|remember|charged|refund|send money|transfer)\b/.test(s)) return false;
  const verb = /^(?:(?:hi|hello|ok|okay|so|please)[, ]+)*(?:(?:can|could) you |please |i(?:'d| would) like |i want |i need |i'm looking for |i am looking for |help me |do you have |have you got |are there |is there |show me |find me |get me |buy me |looking for |search for |look for |find |show |search |get |buy |shop for |order |purchase |any )/.test(s);
  return verb || /\b(for my (grandson|granddaughter|son|daughter|husband|wife|friend))\b.*\b(present|gift|buy|get)\b|\b(present|gift)\b.*\bfor my\b/.test(s);
}

/** Follow-up that narrows/changes the LAST real-shop search: "only Nike", "under €30", "a red version", "size medium",
 *  "a women's version instead", "something blue instead", "more like the second one". Returns the merged spec or null. */
export function refineSpec(text: string, last: ShoppingSpec): { spec: ShoppingSpec; changed: string[] } | null {
  const s = text.toLowerCase().replace(/[’]/g, "'").replace(/[?.!]+$/, '').trim();
  if (s.length > 80) return null;
  const cue = /^(only|just|what about|how about|and|or|do you have|have you got|is there|show me|find|any|in|i want|i'd like|something|anything|instead|make it|cheaper|under|below|less than|over|more than|ignore)\b/.test(s) || /\b(instead|version|only|size|colou?r)\b/.test(s);
  if (!cue) return null;
  const n = parseShopping(text);
  // A new product of its own ("show me women's Nike T-shirts" after kettles) is a NEW search, not a refinement,
  // unless they say "instead" ("a toaster instead").
  const ownNoun = n.product.replace(/\b(version|versions|something|anything|colou?rs?|sizes?|kind|type|style|those|these|them|it|ones?|cheaper|more|other|like|what|about|how|do|you|have|got|is|there|only|just|and|or|make|instead|i|want|would|like|in|on|at)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (ownNoun && ownNoun !== last.product && !/\binstead\b/.test(s)) return null;
  const next: ShoppingSpec = { ...last };
  const changed: string[] = [];
  if (n.brand && n.brand !== last.brand) { next.brand = n.brand; changed.push(`brand ${n.brand}`); }
  if (n.colour && n.colour !== last.colour) { next.colour = n.colour; changed.push(`colour ${n.colour}`); }
  if (n.gender && n.gender !== last.gender) { next.gender = n.gender; next.age = n.age; changed.push(n.gender === 'female' ? 'women\'s' : 'men\'s'); }
  if (n.size && n.size !== last.size) { next.size = n.size; changed.push(`size ${n.size}`); }
  if (n.maxPrice && n.maxPrice !== last.maxPrice) { next.maxPrice = n.maxPrice; changed.push(`under €${n.maxPrice}`); }
  if (n.minPrice && n.minPrice !== last.minPrice) { next.minPrice = n.minPrice; changed.push(`over €${n.minPrice}`); }
  if (n.retailer && n.retailer !== last.retailer) { next.retailer = n.retailer; changed.push(`from ${n.retailer}`); }
  // A new product noun ("something blue instead" has none; "a women's version" has none) replaces the old one only
  // when it is a real noun and not a filler word.
  const noun = n.product.replace(/\b(version|something|anything|colou?r|size|kind|type|style|those|these|them|it)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (noun && noun !== last.product && noun.length >= 3 && !/^(red|blue|black|white)$/.test(noun) && /\b(instead)\b/.test(s)) { next.product = noun; changed.push(noun); }
  return changed.length ? { spec: next, changed } : null;
}

/** Named colours -> sRGB, for ranking against Channel3's measured photo colours. */
const HEX: Record<string, [number, number, number]> = { black: [20, 20, 20], white: [245, 245, 245], red: [200, 30, 40], blue: [30, 70, 180], navy: [20, 30, 70], green: [40, 140, 60], grey: [128, 128, 128], gray: [128, 128, 128], silver: [192, 192, 192], pink: [240, 150, 190], yellow: [240, 210, 40], orange: [240, 130, 30], purple: [120, 50, 150], brown: [110, 70, 40], beige: [220, 200, 170], cream: [245, 235, 210], gold: [212, 175, 55], teal: [0, 128, 128] };
export function photoColourMatches(colour: string, colours: { hex: string; pct: number }[] | undefined): boolean {
  const t = HEX[colour.toLowerCase()];
  if (!t || !colours?.length) return false;
  return colours.slice(0, 2).some((c) => {
    const n = parseInt(c.hex.slice(1), 16); const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const d = Math.sqrt(rgb.reduce((a, v, i) => a + (v - t[i]) ** 2, 0));
    return d < 70 && (c.pct === 0 || c.pct >= 0.15);
  });
}
