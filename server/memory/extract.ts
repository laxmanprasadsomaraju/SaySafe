/**
 * Deterministic memory extraction. ONLY explicit statements about the user's own shopping preferences
 * ("remember I like Panasonic", "I prefer red", "I don't like Russell Hobbs", "keep my budget below €100",
 * "forget that"). No AI is involved. The same function runs for typed text and for the voice transcript.
 * Anything uncertain or sensitive (health, money owed, other people, contact details, codes) is never saved.
 */
import type { MemoryCategory } from './store.js';

export interface MemoryFact { category: MemoryCategory; key: string; value: string; label: string }
export type Extraction =
  | { kind: 'save'; facts: MemoryFact[] }
  | { kind: 'forget'; scope: 'last' | 'all' | 'term'; term?: string }
  | { kind: 'refuse'; reason: 'sensitive' | 'unsupported' }
  | null;

export const COLOURS = ['red', 'blue', 'white', 'black', 'silver', 'grey', 'gray', 'green', 'cream', 'pink', 'yellow', 'orange', 'purple', 'brown', 'beige', 'gold', 'copper', 'navy', 'teal', 'rose gold', 'chrome'];
const AVOID_FEATURES = ['touch controls', 'touch screen', 'glass', 'plastic', 'apps', 'wifi', 'smart features'];
const NOT_TERMS = /^(it|that|this|them|those|these|one|you|shopping|buying|to|pay|paying|cheaper|cheapest|first|second|third|last|best|other|another|bigger|smaller|expensive|more|less|same|new|old|anything|nothing|everything|something|change|wait|now|then|thanks|thank you)$/i;
const STYLES = ['simple controls', 'big buttons', 'large buttons', 'dial controls', 'knobs', 'compact', 'retro', 'quiet', 'lightweight', 'stainless steel', 'cordless', 'digital display', 'easy to clean'];
// Never saved, whatever the phrasing.
const SENSITIVE = /\b(diabet\w*|medic\w*|medicine|pills?|tablets?|insulin|doctor|hospital|ill(ness)?|sick|dementia|alzheimer\w*|cancer|heart|blood|pregnan\w*|disab\w*|owe|owed|owing|debt|loan|overdraft|pin|password|passcode|code|card number|iban|bic|sort code|account number|bank|address|phone|mobile|email|e-mail|son|daughter|husband|wife|grandson|granddaughter|neighbou?r|carer|friend|brother|sister|religio\w*|church|politic\w*|vote)\b/i;
const NOT_A_STATEMENT = /https?:|www\.|@|\+?\d[\d\s-]{6,}/i;

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
const tidy = (s: string) => s.replace(/[“”"']/g, '').replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ').trim();
/** Strip filler product nouns so "red kettles" -> "red", "Panasonic microwaves" -> "Panasonic". */
const STRIP = /\b(the|a|an|any|anything|things?|stuff|products?|items?|ones?|brand|brands|colou?r|colou?red|kettles?|microwaves?|toasters?|radios?|appliances?|stuff from|made by|from|please|very much|much|really|so much|for (me|now)|anymore|any more)\b/gi;

function colourIn(s: string): string | null {
  const l = s.toLowerCase();
  return COLOURS.find((c) => new RegExp(`\\b${c}\\b`).test(l)) ?? null;
}
function styleIn(s: string): string | null {
  const l = s.toLowerCase();
  return STYLES.find((c) => l.includes(c)) ?? null;
}
const budgetIn = (s: string): number | null => {
  const m = s.match(/(?:€|eur\s?|euro\s?)\s*(\d{1,5}(?:[.,]\d{1,2})?)|(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:euros?|eur)\b/i);
  const n = m ? Number((m[1] ?? m[2]).replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 100000 ? Math.round(n * 100) / 100 : null;
};

/** A preference statement -> facts. Returns null when it isn't one we can read with certainty. */
function factsFrom(rest: string, positive: boolean): MemoryFact[] | null {
  const raw = tidy(rest);
  if (!raw || raw.length > 60) return null;
  const colour = colourIn(raw);
  const style = styleIn(raw);
  const feature = !positive ? AVOID_FEATURES.find((f) => raw.toLowerCase().includes(f)) ?? null : null;
  if (feature) return [{ category: 'brand_avoid', key: feature, value: feature, label: `you don't want ${feature}` }];
  if (positive && colour) {
    // "I like red, blue" / "red and blue": one colour preference holding both (personalise uses the first for search).
    const all = COLOURS.filter((c) => new RegExp(`\\b${c}\\b`).test(raw.toLowerCase())).map((c) => (c === 'gray' ? 'grey' : c)).filter((c, i, a) => a.indexOf(c) === i).slice(0, 3);
    const v = all.length > 1 ? all.join(', ') : (colour === 'gray' ? 'grey' : colour);
    return [{ category: 'shopping', key: 'colour', value: v, label: `you prefer ${all.length > 1 ? all.join(' and ') : colour}` }];
  }
  if (positive && style) return [{ category: 'shopping', key: `style:${style}`, value: style, label: `you prefer ${style}` }];
  const term = tidy(raw.replace(STRIP, ' '));
  if (!term || term.length < 2 || term.split(' ').length > 3 || /\d/.test(term)) return null;
  if (term.split(' ').some((w) => NOT_TERMS.test(w))) return null;
  // Treat it as a brand only when it looks like a name: capitalised as typed, or a single word that isn't a verb form.
  // "I like it", "I don't want to pay", "I prefer the cheaper one" are not preferences.
  const capitalised = /\b[A-Z][a-z]/.test(rest);
  const looksLikeBrand = capitalised || (term.split(' ').length === 1 && !/ing$/.test(term));
  if (!positive) {
    const v = colour ?? (looksLikeBrand ? titleCase(term) : null);
    if (!v) return null;
    return [{ category: 'brand_avoid', key: v.toLowerCase(), value: v, label: `you don't want ${v}` }];
  }
  if (!looksLikeBrand) return null;
  const v = titleCase(term);
  return [{ category: 'brand_like', key: v.toLowerCase(), value: v, label: `you like ${v}` }];
}

export function extractMemory(text: string): Extraction {
  const original = text.trim();
  if (!original || original.length > 160) return null;
  // A number, link or address in a "remember …" sentence is contact or account detail: refused, never saved.
  if (NOT_A_STATEMENT.test(original)) return /^(please )?(can you )?remember\b/i.test(original) ? { kind: 'refuse', reason: 'sensitive' } : null;
  const s = original.replace(/[’]/g, "'").replace(/\s+/g, ' ');
  const lead = s.replace(/^(ok(ay)?|so|and|also|oh|well|please|hey saysafe|saysafe),?\s+/i, '');
  const l = lead.toLowerCase();

  // ----- Forget -----
  const forgetVerb = /^(please )?(can you )?(forget|erase)\b/.test(l) || (/^(please )?(delete|remove|clear)\b/.test(l) && /\b(preferences?|memory|memories|what you (know|remember))\b/.test(l));
  if (forgetVerb) {
    if (/\b(everything|all)( (you|that you) (know|remember(ed)?)( about me)?)?\b|\b(all|every) (my )?(preferences|memory|memories)\b|\bmy memory\b/.test(l) && !/\bthat i\b/.test(l)) return { kind: 'forget', scope: 'all' };
    if (/^(please )?(can you )?(forget|delete|remove|erase) (that|it|this|what i (just )?said|my (last )?preference)[.!]*$/.test(l)) return { kind: 'forget', scope: 'last' };
    const t = l.match(/^(?:please )?(?:can you )?(?:forget|delete|remove|erase)(?: that)?(?: i (?:like|prefer|love|don't like|do not like|hate|dislike|avoid))?(?: my(?: preference for)?)? (.{2,40}?)[.!]*$/);
    if (t) { const term = tidy(t[1].replace(STRIP, ' ')); if (term) return { kind: 'forget', scope: 'term', term }; }
    return null;
  }

  // ----- Explicit statements -----
  const remember = /^(please )?(can you )?remember( that)?\b/.test(l);
  const bodyCased = lead.replace(/^(please )?(can you )?remember( that)?\s*/i, '');
  const body = bodyCased.toLowerCase();
  const pos = bodyCased.match(/^i (?:really )?(?:like|prefer|love|always buy|usually buy|go for)\s+(.+)$/i) ?? bodyCased.match(/^my favou?rite (?:colou?r|brand) is\s+(.+)$/i);
  const neg = bodyCased.match(/^i (?:really )?(?:don't|do not|never) (?:like|want|buy|trust)\s+(.+)$/i) ?? bodyCased.match(/^i (?:hate|dislike|avoid)\s+(.+)$/i) ?? bodyCased.match(/^(?:no more|never show me|don't show me|do not show me|avoid)\s+(.+)$/i);
  const bud = /\b(budget|spend|spending|anything (over|above|more than)|nothing (over|above|more than)|keep (it|things|my budget|purchases)|under|below|less than|up to|max(imum)?)\b/.test(body) && /^(i |keep |my |nothing |don't |do not |never |always |only )/.test(body) ? budgetIn(body) : null;
  const comm = /^(?:keep (?:your |the )?(?:answers|replies) short|i (?:like|prefer) short (?:answers|replies))$/.test(body);

  if (!remember && !pos && !neg && bud === null && !comm) return null;
  // Health, money owed, other people, contact details, codes: never saved.
  if (SENSITIVE.test(body)) return { kind: 'refuse', reason: 'sensitive' };
  if (comm) return { kind: 'save', facts: [{ category: 'communication', key: 'reply_length', value: 'short', label: 'you prefer short answers' }] };
  if (bud !== null && /\b(budget|spend|over|above|more than|under|below|less than|up to|max)/.test(body)) {
    return { kind: 'save', facts: [{ category: 'budget', key: 'max', value: String(bud), label: `your usual budget is up to €${bud}` }] };
  }
  const facts = pos ? factsFrom(pos[1], true) : neg ? factsFrom(neg[1], false) : null;
  if (facts) return { kind: 'save', facts };
  // "Remember to buy milk", "remember my appointment": not a shopping preference -> not saved.
  return remember ? { kind: 'refuse', reason: 'unsupported' } : null;
}
