/**
 * Resolves references to products shown earlier ("that microwave", "the cheaper one", "the one from yesterday",
 * "I changed my mind") against the user's stored recent products. Deterministic; no AI.
 * Returns null when the text is not a reference, so everything else flows on unchanged.
 */
import type { RecentProduct } from './store.js';

export type ProductRef =
  | { kind: 'one'; item: RecentProduct; why: string }
  | { kind: 'many'; items: RecentProduct[]; why: string }
  | { kind: 'none'; why: string };

const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(es|s)$/, '');
const dayIndex = (iso: string) => Math.floor(Date.parse(iso) / 86_400_000);
const GENERIC = new Set(['one', 'thing', 'item', 'product', 'option', 'that', 'this', 'it']);

function mentions(p: RecentProduct, noun: string) {
  const n = stem(noun);
  if (n.length < 3) return false;
  return `${p.title} ${p.query ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).some((w) => stem(w) === n || (n.length >= 5 && stem(w).startsWith(n)));
}
const batches = (items: RecentProduct[]) => {
  const order: string[] = [];
  const by = new Map<string, RecentProduct[]>();
  for (const p of items) { if (!by.has(p.batch)) { by.set(p.batch, []); order.push(p.batch); } by.get(p.batch)!.push(p); }
  for (const b of by.values()) b.sort((a, c) => a.rank - c.rank);
  return order.map((b) => by.get(b)!); // newest batch first (items are newest first)
};

/** The noun in "that microwave" / "the microwave from yesterday", if any. */
export function referencedNoun(text: string): string | null {
  const m = text.toLowerCase().match(/\b(?:that|this|the|those)\s+(?:same\s+|other\s+|red\s+|blue\s+|white\s+|black\s+)?([a-z]{3,20})\b(?!\s+(?:one|shop|demo))/);
  const n = m?.[1] ?? null;
  return n && !GENERIC.has(n) && !/^(cheaper|cheapest|first|second|third|last|best|other|same|one|demo|shop|payment|money)$/.test(n) ? n : null;
}

export function isProductReference(text: string): boolean {
  const s = text.toLowerCase().trim().replace(/[?.!]+$/, '');
  if (s.length > 120) return false;
  return /^(i('ve| have)? changed my mind|actually,? i changed my mind)\b/.test(s)
    || /\b(the one|that one|the ones?)\s+(from|i saw|you showed|we looked at)\b.{0,20}\b(yesterday|earlier|before|last time|the other day|today)\b/.test(s)
    || /^(show me |what about |go back to |back to |i('ll| will) (take|have) |i want |open |remind me (of|about) )?(the )?(cheaper|cheapest|first|second|third) one$/.test(s)
    || /^(show me |what about |go back to |back to |i('ll| will) (take|have) |i want |open |remind me (of|about) |tell me (more )?about )(that|the) [a-z]{3,20}( again| from (yesterday|earlier|before))?$/.test(s)
    || /^(that|the) [a-z]{3,20} (again|from (yesterday|earlier|before))$/.test(s);
}

export function resolveProductRef(text: string, recent: RecentProduct[], now: Date): ProductRef | null {
  const s = text.toLowerCase().trim().replace(/[?.!]+$/, '');
  if (!recent.length) return null;
  const groups = batches(recent);
  const latest = groups[0] ?? [];
  const noun = referencedNoun(s);
  let pool = noun ? recent.filter((p) => mentions(p, noun)) : recent;
  if (noun && !pool.length) return { kind: 'none', why: `I don't have a ${noun} in what we looked at recently.` };

  const today = dayIndex(now.toISOString());
  if (/\byesterday\b/.test(s)) pool = pool.filter((p) => dayIndex(p.shownAt) === today - 1);
  else if (/\btoday\b/.test(s)) pool = pool.filter((p) => dayIndex(p.shownAt) === today);
  if (/\b(yesterday|today)\b/.test(s) && !pool.length) return { kind: 'none', why: `I don't have anything we looked at ${/yesterday/.test(s) ? 'yesterday' : 'today'}.` };

  // "I changed my mind": go back to the search before the latest one.
  if (/changed my mind/.test(s)) {
    const prev = groups[1];
    if (!prev) return { kind: 'many', items: latest.slice(0, 3), why: 'Which one would you like instead?' };
    return prev.length === 1 ? { kind: 'one', item: prev[0], why: 'Back to the one you looked at before.' } : { kind: 'many', items: prev.slice(0, 3), why: 'Back to what you looked at before. Which one?' };
  }
  // "The cheaper one": cheapest in the newest matching search.
  if (/\b(cheaper|cheapest)\b/.test(s)) {
    const g = groups.find((b) => b.some((p) => pool.includes(p))) ?? latest;
    const cheapest = [...g].sort((a, b) => a.price - b.price)[0];
    return cheapest ? { kind: 'one', item: cheapest, why: 'The cheaper one from your last search.' } : null;
  }
  const nth = s.match(/\b(first|second|third)\b/)?.[1];
  if (nth) {
    const g = groups.find((b) => b.some((p) => pool.includes(p))) ?? latest;
    const it = g[{ first: 0, second: 1, third: 2 }[nth as 'first']];
    return it ? { kind: 'one', item: it, why: `The ${nth} one from your last search.` } : null;
  }
  // One distinct match -> that product. Several -> ask which (newest first, at most 3).
  // Newest search first, and inside a search the order it was shown in (best match first).
  const ordered = groups.flat().filter((p) => pool.includes(p));
  const distinct = [...new Map(ordered.map((p) => [p.productId, p])).values()];
  if (distinct.length === 1) return { kind: 'one', item: distinct[0], why: '' };
  return { kind: 'many', items: distinct.slice(0, 3), why: 'Which one do you mean?' };
}
