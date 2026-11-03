/**
 * Channel3 personalisation from remembered preferences.
 * - The CURRENT request always wins: a colour, budget or brand said now overrides what was remembered.
 * - Only product terms leave the server: at most one remembered colour is added to the Channel3 query text.
 *   No name, user id, household id, or anything else personal goes to Channel3 (or to Groq).
 * - Budget and brand/avoid preferences are applied locally in recommend(); nothing is invented, and when nothing
 *   fits the remembered budget, the closest listings are shown and the line says so.
 */
import { EMPTY_PROFILE, sanitizeProfile, type ShoppingProfile, type Recommendation, type ShopItem, parseBudget } from '../../shared/shopping.js';
import { getProfile } from '../prefs/store.js';
import { COLOURS } from './extract.js';
import * as store from './store.js';

export interface MemoryUse { colour: string | null; budget: number | null; brands: string[]; avoid: string[]; styles: string[]; /** which of these came from demo SAMPLE rows */ samples?: ('colour' | 'budget' | 'brand' | 'avoid' | 'style')[] }
export interface Personalised { profile: ShoppingProfile; memoryUsed: MemoryUse; memoryOn: boolean; queryColour: string | null }

const has = (s: string, w: string) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(s);

export function effectiveProfile(hh: string, userId: string, said: string, opts: { ignoreMemory?: boolean } = {}): Personalised {
  const form = getProfile(userId);
  const memoryOn = store.isEnabled(hh, userId);
  const none: MemoryUse = { colour: null, budget: null, brands: [], avoid: [], styles: [] };
  if (!memoryOn || opts.ignoreMemory) return { profile: form, memoryUsed: none, memoryOn, queryColour: null };
  const rows = store.listMemory(hh, userId).filter((m) => m.status === 'confirmed');
  const said_l = said.toLowerCase();
  const requestColour = COLOURS.some((c) => has(said_l, c));
  const requestBudget = parseBudget(said).max !== null;
  const use: MemoryUse = { ...none, brands: [], avoid: [], styles: [], samples: [] };
  const mark = (m: store.MemoryItem, k: NonNullable<MemoryUse['samples']>[number]) => { if (m.sample) use.samples!.push(k); };
  for (const m of rows) {
    if (m.category === 'shopping' && m.key === 'colour' && !requestColour) { use.colour = m.value; mark(m, 'colour'); }
    else if (m.category === 'shopping' && m.key.startsWith('style:')) { use.styles.push(m.value); mark(m, 'style'); }
    else if (m.category === 'brand_like') { use.brands.push(m.value); mark(m, 'brand'); }
    // "Find me a Breville kettle" overrides "I don't like Breville" for this request.
    else if (m.category === 'brand_avoid' && !has(said_l, m.value)) { use.avoid.push(m.value); mark(m, 'avoid'); }
    else if (m.category === 'budget' && m.key === 'max' && !requestBudget) { const n = Number(m.value); if (Number.isFinite(n) && n > 0) { use.budget = n; mark(m, 'budget'); } }
  }
  const profile = sanitizeProfile({
    colours: [...(use.colour ? [use.colour] : []), ...(requestColour ? [] : form.colours)],
    brands: [...use.brands, ...form.brands],
    styles: [...use.styles, ...form.styles],
    avoid: [...use.avoid, ...form.avoid.filter((a) => !has(said_l, a))],
    categories: form.categories,
    budgetMax: use.budget ?? form.budgetMax,
  });
  return { profile, memoryUsed: use, memoryOn, queryColour: use.colour };
}

/** The Channel3 query: the user's product terms, plus a remembered colour only if the request named none. */
export function personalisedQuery(query: string, p: Personalised): string {
  if (!p.queryColour || has(query, p.queryColour)) return query;
  return `${p.queryColour} ${query}`.slice(0, 200);
}

/** "Shown first because you prefer red and under €100." Only what actually shaped the top result. */
export function personalisationLine(rec: Recommendation, products: ShopItem[], p: Personalised): { line: string; used: string[]; ignorePhrase: string } | null {
  const best = rec.picks.find((k) => k.role === 'best');
  if (!best || (!p.memoryUsed.colour && p.memoryUsed.budget === null && !p.memoryUsed.brands.length && !p.memoryUsed.avoid.length && !p.memoryUsed.styles.length)) return null;
  const reasons = best.reasons.join(' | ').toLowerCase();
  const used: string[] = [];
  const smp = p.memoryUsed.samples ?? [];
  let sampleShaped = false;
  if (p.memoryUsed.colour && reasons.includes(`preference for ${p.memoryUsed.colour.toLowerCase()}`)) { used.push(`you prefer ${p.memoryUsed.colour}`); if (smp.includes('colour')) sampleShaped = true; }
  for (const s of p.memoryUsed.styles) if (reasons.includes(`preference for ${s.toLowerCase()}`)) { used.push(`you prefer ${s}`); break; }
  for (const b of p.memoryUsed.brands) if (reasons.includes(b.toLowerCase())) { used.push(`you like ${b}`); break; }
  if (p.memoryUsed.budget !== null && rec.usedProfileBudget === p.memoryUsed.budget) { used.push(`under €${p.memoryUsed.budget}`); if (smp.includes('budget')) sampleShaped = true; }
  const ignorePhrase = 'ignore my preferences';
  const notes: string[] = [];
  if (rec.avoidedCount && p.memoryUsed.avoid.length) notes.push(`I left out ${rec.avoidedCount} listing${rec.avoidedCount > 1 ? 's' : ''} with ${p.memoryUsed.avoid.slice(0, 2).join(' or ')}, as you asked.`);
  if (p.memoryUsed.budget !== null && rec.profileBudgetRelaxed) notes.push(`Nothing was under your usual €${p.memoryUsed.budget}, so these are the closest, and they cost more.`);
  if (p.memoryUsed.colour && !used.some((u) => u.includes(p.memoryUsed.colour!)) && products.length) notes.push(`None of these listings says ${p.memoryUsed.colour}; these are the closest.`);
  if (!used.length && !notes.length) return null;
  const head = used.length ? `Shown first because ${used.join(' and ')}${sampleShaped ? ' (sample preferences: change or remove them in Profile)' : ''}.` : '';
  return { line: `${[head, ...notes].filter(Boolean).join(' ')} Say “${ignorePhrase}” to see them without.`.slice(0, 380), used, ignorePhrase };
}

export { EMPTY_PROFILE };
