/**
 * "Have I already paid X?" — pure matching over the elder's own records. No I/O, no AI.
 *
 * Two sources:
 *  - paypal_sandbox: SaySafe Demo Shop payments made in this app (recipient is always the Demo Shop, a shop,
 *    never a person). HARD RULE: a query naming someone else (e.g. "John") never matches a Demo Shop payment,
 *    even when the amount is the same. They are excluded, not listed as "not a payment to John" (docs/COMPANION.md).
 *  - manual: records the user typed. Always labelled "Recorded by you, not verified".
 *
 * The result never says a person was paid. It says what records exist, how well they match, and what is uncertain.
 */
import { DEMO_SHOP_RECIPIENT, DATE_TOLERANCE_DAYS, DUPLICATE_WINDOW_DAYS, COMPANION_LABELS, type PaymentMatchT, type PaymentSearchResultT, type RepeatGroupT } from '../../shared/companion.js';
import { editDistance } from '../scam/rules.js';

export interface Candidate {
  id: string;
  source: 'paypal_sandbox' | 'manual';
  recipient: string;
  /** Item names for shop payments, the user's note for manual ones. */
  description: string | null;
  amountCents: number;
  currency: string;
  /** YYYY-MM-DD */
  date: string;
  evidence: PaymentMatchT['evidence'];
  /** "Try as Mary" sample row. */
  sample?: boolean;
}

export interface SearchInput {
  q?: string | null;
  amountCents?: number | null;
  from?: string | null;
  to?: string | null;
}

const STOP = new Set(['to', 'the', 'a', 'an', 'for', 'mr', 'mrs', 'ms', 'miss', 'dr', 'my', 'i', 'paid', 'pay', 'did', 'have', 'already', 'and', 'of', 'at', 'on', 'from', 'by']);
const SHOP_WORDS = new Set(['saysafe', 'demo', 'shop', 'paypal', 'sandbox', 'order', 'purchase', 'shopping']);

export const normName = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s'-]/g, ' ').replace(/['-]/g, '').replace(/\s+/g, ' ').trim();
export const tokens = (s: string) => normName(s).split(' ').filter((t) => t.length >= 2 && !STOP.has(t));

/** How well one query word matches one name word: 1 exact, 0.85 prefix, 0.8 one typo (Jon/John), else 0. */
export function tokenSimilarity(q: string, r: string): number {
  if (q === r) return 1;
  if (q.length >= 3 && r.length >= 3 && (r.startsWith(q) || q.startsWith(r))) return 0.85;
  if (Math.min(q.length, r.length) >= 3 && editDistance(q, r) === 1) return 0.8;
  if (Math.min(q.length, r.length) >= 6 && editDistance(q, r) === 2) return 0.7;
  return 0;
}

export interface NameMatch { score: number; matched: string[]; unmatchedQuery: string[]; extraInRecord: string[]; fuzzy: [string, string][] }

export function nameMatch(query: string, recipient: string): NameMatch {
  const qt = tokens(query);
  const rt = tokens(recipient);
  const matched: string[] = [];
  const unmatchedQuery: string[] = [];
  const fuzzy: [string, string][] = [];
  const used = new Set<number>();
  let sum = 0;
  for (const q of qt) {
    let best = 0; let bi = -1;
    rt.forEach((r, i) => { const s = tokenSimilarity(q, r); if (s > best) { best = s; bi = i; } });
    if (best >= 0.7) {
      matched.push(rt[bi]); used.add(bi); sum += best;
      if (best < 1) fuzzy.push([q, rt[bi]]);
    } else unmatchedQuery.push(q);
  }
  const extraInRecord = rt.filter((_, i) => !used.has(i));
  const score = qt.length ? sum / qt.length : 0;
  return { score, matched, unmatchedQuery, extraInRecord, fuzzy };
}

const dayMs = 86_400_000;
const toDay = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / dayMs);
export const fmtMoney = (c: number, cur: string) => `${cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'USD' ? '$' : cur + ' '}${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const fmtDate = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Does the query name the Demo Shop or something bought there? Anything else is treated as a person/other payee. */
export function queryIsAboutShop(q: string, c: Candidate): boolean {
  const qt = tokens(q);
  if (!qt.length) return true;
  const desc = tokens(c.description ?? '');
  return qt.every((t) => SHOP_WORDS.has(t) || desc.some((d) => tokenSimilarity(t, d) >= 0.85));
}

/** Words that say nothing about WHAT was paid for ("Fence repair (paid again?)" is still a fence repair). */
const NOTE_NOISE = new Set(['paid', 'again', 'pay', 'payment', 'same', 'maybe', 'twice', 'second', 'another', 'not', 'sure', 'check', 'the', 'for', 'and']);
const noteTokens = (s: string | null) => tokens(s ?? '').filter((t) => t.length >= 3 && !NOTE_NOISE.has(t));
const sameNote = (a: string | null, b: string | null) => normName(a ?? '') === normName(b ?? '');

/**
 * Classify two records with the same payee, amount and currency (see RepeatGroup in shared/companion.ts).
 * Returns null when they are not a same-payee/same-amount pair. Never says a person was paid.
 */
export function classifyRepeat(a: Candidate, b: Candidate): RepeatGroupT | null {
  if (a.id === b.id || a.source !== 'manual' || b.source !== 'manual') return null;
  if (a.currency !== b.currency || a.amountCents !== b.amountCents || normName(a.recipient) !== normName(b.recipient)) return null;
  const [first, second] = a.date <= b.date ? [a, b] : [b, a];
  const daysApart = Math.abs(toDay(second.date) - toDay(first.date));
  const ta = noteTokens(first.description); const tb = noteTokens(second.description);
  const differentWork = ta.length > 0 && tb.length > 0 && !ta.some((x) => tb.some((y) => tokenSimilarity(x, y) >= 0.85));
  const base = { ids: [first.id, second.id], recipient: first.recipient, amountCents: first.amountCents, currency: first.currency, daysApart };
  const amt = fmtMoney(first.amountCents, first.currency);
  if (daysApart === 0 && sameNote(first.description, second.description)) {
    return { ...base, kind: 'identical_entries', message: `Two identical entries: ${amt} to ${first.recipient} on ${fmtDate(first.date)}${first.description ? ` (“${first.description}”)` : ''}. They may be one payment typed in twice, or two payments. Check with ${first.recipient} or your bank before deleting one or paying again.` };
  }
  if (!differentWork && daysApart <= DUPLICATE_WINDOW_DAYS) {
    return { ...base, kind: 'possible_duplicate', message: `Possible duplicate: two payments of ${amt} to ${first.recipient}, ${daysApart} day${daysApart === 1 ? '' : 's'} apart (${fmtDate(first.date)} and ${fmtDate(second.date)})${first.description || second.description ? ` for the same kind of work` : ''}. Ask ${first.recipient} before paying again.` };
  }
  const why = differentWork ? `for different things (“${first.description}” and “${second.description}”)` : `${daysApart} days apart`;
  return { ...base, kind: 'separate_payments', message: `You recorded ${amt} to ${first.recipient} twice, ${why}. That looks like two separate payments, not a duplicate.` };
}

export function searchPayments(candsIn: Candidate[], input: SearchInput): PaymentSearchResultT {
  // The same record must never be counted twice, whichever surface or query reached it.
  const cands = [...new Map(candsIn.map((c) => [c.id, c])).values()];
  const q = input.q?.trim() || null;
  const amount = input.amountCents ?? null;
  const from = input.from ?? null;
  const to = input.to ?? input.from ?? null;
  const notes: string[] = [];
  const qTokens = q ? tokens(q) : [];
  const hasName = qTokens.length > 0;

  // Repeated amounts and duplicates are judged over ALL the user's records, not only the matches.
  const amountCount = new Map<string, number>();
  for (const c of cands) amountCount.set(`${c.currency}:${c.amountCents}`, (amountCount.get(`${c.currency}:${c.amountCents}`) ?? 0) + 1);

  let excludedShop = 0;
  const byItem = new Set<string>();
  const out: PaymentMatchT[] = [];
  for (const c of cands) {
    const reasons: string[] = [];
    const caveats: string[] = [];
    const parts: { w: number; s: number }[] = [];

    if (hasName) {
      if (c.source === 'paypal_sandbox') {
        // HARD RULE: never match a shop payment to a person. Only a query about the shop or its items may match.
        if (!queryIsAboutShop(q!, c)) { excludedShop++; continue; }
        reasons.push(c.sample ? `Sample ${DEMO_SHOP_RECIPIENT} purchase (illustrative)` : `Paid to ${DEMO_SHOP_RECIPIENT} in this app`);
        if (qTokens.some((t) => !SHOP_WORDS.has(t))) byItem.add(c.id);
        parts.push({ w: 0.5, s: 1 });
      } else {
        const nm = nameMatch(q!, c.recipient);
        // Not the payee's name: the record's own note may name the item ("Microwave" bought from Currys).
        const desc = tokens(c.description ?? '');
        if ((nm.score < 0.7 || nm.matched.length === 0) && qTokens.length && qTokens.every((t) => desc.some((d) => tokenSimilarity(t, d) >= 0.85))) {
          reasons.push(`Your note says "${c.description}" (paid to ${c.recipient})`);
          byItem.add(c.id);
          parts.push({ w: 0.5, s: 0.9 });
        } else {
        if (nm.score < 0.7 || nm.matched.length === 0) continue;
        if (nm.unmatchedQuery.length) {
          // "John Murphy" asked, record says "John Smith": the surname contradicts. Not the same person.
          if (nm.extraInRecord.length) continue;
          caveats.push(`Only part of the name matches: you asked about "${q}", the record says "${c.recipient}".`);
        } else if (nm.extraInRecord.length) {
          caveats.push(`Partial name: you said "${q}", the record says "${c.recipient}".`);
        }
        for (const [a, b] of nm.fuzzy) caveats.push(`Spelled differently: "${a}" and "${b}". It may be someone else.`);
        reasons.push(nm.score === 1 && !nm.unmatchedQuery.length ? `Name matches "${c.recipient}"` : `Name is similar to "${c.recipient}"`);
        const penalty = nm.unmatchedQuery.length ? 0.6 : 1;
        parts.push({ w: 0.5, s: nm.score * penalty });
        }
      }
    }

    if (amount != null) {
      const diff = Math.abs(c.amountCents - amount);
      if (diff === 0) { reasons.push(`Same amount (${fmtMoney(c.amountCents, c.currency)})`); parts.push({ w: 0.3, s: 1 }); }
      else if (diff <= Math.max(100, Math.round(amount * 0.02))) { reasons.push(`Close amount (${fmtMoney(c.amountCents, c.currency)})`); caveats.push(`The amount is not exactly the same: ${fmtMoney(c.amountCents, c.currency)} recorded, ${fmtMoney(amount, c.currency)} asked.`); parts.push({ w: 0.3, s: 0.6 }); }
      else {
        if (!hasName) continue; // amount-only search: a different amount is not a match
        caveats.push(`Different amount: ${fmtMoney(c.amountCents, c.currency)} recorded, ${fmtMoney(amount, c.currency)} asked.`);
        parts.push({ w: 0.3, s: 0 });
      }
    }

    if (from) {
      const d = toDay(c.date); const a = toDay(from); const b = toDay(to!);
      const off = d < a ? a - d : d > b ? d - b : 0;
      if (off === 0) { reasons.push(from === to ? `Same date (${fmtDate(c.date)})` : `In the dates you asked about (${fmtDate(c.date)})`); parts.push({ w: 0.2, s: 1 }); }
      else if (off <= DATE_TOLERANCE_DAYS) { reasons.push(`Near the date you asked about (${fmtDate(c.date)})`); caveats.push(`The date is ${off} day${off === 1 ? '' : 's'} off (${fmtDate(c.date)}).`); parts.push({ w: 0.2, s: 0.6 }); }
      else {
        if (!hasName && amount == null) continue; // date-only search: outside the window is not a match
        caveats.push(`The date is off by more than ${DATE_TOLERANCE_DAYS} days (${fmtDate(c.date)}).`);
        parts.push({ w: 0.2, s: 0 });
      }
    }

    if (!parts.length) { parts.push({ w: 1, s: 0.5 }); reasons.push('Listed because no details were given'); }
    const wsum = parts.reduce((s, p) => s + p.w, 0);
    let score = parts.reduce((s, p) => s + p.w * p.s, 0) / wsum;
    if ((amountCount.get(`${c.currency}:${c.amountCents}`) ?? 0) > 1) {
      caveats.push(`You have more than one payment of ${fmtMoney(c.amountCents, c.currency)}. This could be a different one.`);
      score *= 0.9;
    }
    if (c.source === 'manual') {
      for (const o of cands) {
        const rep = o.id !== c.id ? classifyRepeat(c, o) : null;
        if (!rep) continue;
        if (rep.kind === 'possible_duplicate') caveats.push(`Possible duplicate: you recorded a similar payment on ${fmtDate(o.date)} (${rep.daysApart} day${rep.daysApart === 1 ? '' : 's'} apart).`);
        else if (rep.kind === 'identical_entries') caveats.push(`Identical entry on the same day: this may be the same payment typed in twice.`);
        else caveats.push(`Separate payment: you also recorded ${fmtMoney(o.amountCents, o.currency)} to ${o.recipient} on ${fmtDate(o.date)}${o.description ? ` (${o.description})` : ''}.`);
      }
      caveats.push(c.sample ? 'Sample data: an illustrative record, not a real payment.' : `${COMPANION_LABELS.manual}. SaySafe can't see whether the money arrived.`);
    } else if (c.sample) {
      caveats.push('Sample data: illustrative, there is no PayPal record for it.');
    }
    if (score < 0.45) continue;
    out.push({ id: c.id, source: c.source, recipient: c.recipient, description: c.description, amountCents: c.amountCents, currency: c.currency, date: c.date, score: Math.round(score * 100) / 100, matchReasons: reasons, caveats, evidence: c.evidence, ...(c.sample ? { sample: true } : {}) });
  }
  out.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  const matches = out.slice(0, 10);
  // Same-payee / same-amount pairs among the matches, each pair once.
  const repeats: RepeatGroupT[] = [];
  const byId = new Map(cands.map((c) => [c.id, c]));
  for (let i = 0; i < matches.length; i++) for (let j = i + 1; j < matches.length; j++) {
    const a = byId.get(matches[i].id); const b = byId.get(matches[j].id);
    const rep = a && b ? classifyRepeat(a, b) : null;
    if (rep) repeats.push(rep);
  }
  for (const rep of repeats) notes.push(rep.message); // the card shows notes; the reply wording uses `repeats`

  // Several different people behind one first name.
  if (hasName) {
    const people = new Set(matches.filter((m) => m.source === 'manual').map((m) => normName(m.recipient)));
    if (people.size > 1) notes.push(`More than one person matches "${q}". Check which one you mean.`);
  }
  const itemHits = matches.filter((m) => byItem.has(m.id));
  if (itemHits.length > 1 && new Set(itemHits.map((m) => normName(m.recipient))).size > 1) {
    notes.push(`These look like separate purchases of "${q}" from ${[...new Set(itemHits.map((m) => m.recipient))].join(' and ')}. Check you meant to buy more than one.`);
  }
  if (excludedShop > 0 && byItem.size === 0) notes.push(`${DEMO_SHOP_RECIPIENT} payments are not shown: they are shop purchases, not payments to ${q}.`);
  notes.push('SaySafe only knows Demo Shop payments made in this app and records you typed in. It cannot see your bank or your PayPal wallet.');

  const who = itemHits.length && itemHits.length === matches.length ? 'the shop' : q ?? 'them';
  let guidance: string;
  if (!matches.length) guidance = `I couldn't find a record of paying ${q ?? 'them'}. That doesn't mean you haven't paid. Check your bank statement, or ask ${who}, before you pay.`;
  else if (matches.every((m) => m.source === 'paypal_sandbox')) guidance = `These are ${DEMO_SHOP_RECIPIENT} payments made in this app (PayPal sandbox). They are shop purchases, not payments to a person.`;
  else guidance = `I found ${matches.length === 1 ? 'a record' : 'records'} that may match. A record you typed is not proof the money arrived. Don't pay again until you've checked with ${who}.`;

  return { query: { q, amountCents: amount, from, to: input.to ?? null }, matches, repeats, guidance, notes };
}

/** Parse a spoken date hint into a window. Returns null when it can't be read (then no date filter is used). */
export function parseDateHint(hint: string | null | undefined, today: Date = new Date()): { from: string; to: string } | null {
  if (!hint) return null;
  const h = hint.toLowerCase().trim();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const t0 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const add = (d: Date, n: number) => new Date(d.getTime() + n * dayMs);
  if (/^\d{4}-\d{2}-\d{2}$/.test(h)) return { from: h, to: h };
  if (/\btoday\b/.test(h)) return { from: iso(t0), to: iso(t0) };
  if (/\byesterday\b/.test(h)) return { from: iso(add(t0, -1)), to: iso(add(t0, -1)) };
  if (/\blast week\b/.test(h)) return { from: iso(add(t0, -13)), to: iso(add(t0, -7 + 0)) };
  if (/\bthis week\b/.test(h)) return { from: iso(add(t0, -6)), to: iso(t0) };
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthRange = (y: number, m: number) => ({ from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) });
  if (/\blast month\b/.test(h)) { const m = t0.getUTCMonth() - 1; return monthRange(m < 0 ? t0.getUTCFullYear() - 1 : t0.getUTCFullYear(), (m + 12) % 12); }
  if (/\bthis month\b/.test(h)) return monthRange(t0.getUTCFullYear(), t0.getUTCMonth());
  const dm = h.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/) ?? h.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  const pickYear = (m: number, d: number) => { const y = t0.getUTCFullYear(); return Date.UTC(y, m, d) > t0.getTime() ? y - 1 : y; }; // past tense: "on 1 Oct" means the last 1 Oct
  if (dm) {
    const [a, b] = /^\d/.test(dm[1]) ? [dm[1], dm[2]] : [dm[2], dm[1]];
    const mi = MONTHS.indexOf(b.slice(0, 3));
    const day = Number(a);
    if (mi >= 0 && day >= 1 && day <= 31) { const y = pickYear(mi, day); const d = iso(new Date(Date.UTC(y, mi, day))); return { from: d, to: d }; }
  }
  const mo = h.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/);
  if (mo) { const mi = MONTHS.indexOf(mo[1].slice(0, 3)); const y = Date.UTC(t0.getUTCFullYear(), mi, 1) > t0.getTime() ? t0.getUTCFullYear() - 1 : t0.getUTCFullYear(); return monthRange(y, mi); }
  return null;
}
