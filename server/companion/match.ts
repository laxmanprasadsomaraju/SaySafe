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
import { DEMO_SHOP_RECIPIENT, DATE_TOLERANCE_DAYS, COMPANION_LABELS, type PaymentMatchT, type PaymentSearchResultT } from '../../shared/companion.js';
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

export function searchPayments(cands: Candidate[], input: SearchInput): PaymentSearchResultT {
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
  const out: PaymentMatchT[] = [];
  for (const c of cands) {
    const reasons: string[] = [];
    const caveats: string[] = [];
    const parts: { w: number; s: number }[] = [];

    if (hasName) {
      if (c.source === 'paypal_sandbox') {
        // HARD RULE: never match a shop payment to a person. Only a query about the shop or its items may match.
        if (!queryIsAboutShop(q!, c)) { excludedShop++; continue; }
        reasons.push(`Paid to ${DEMO_SHOP_RECIPIENT} in this app`);
        parts.push({ w: 0.5, s: 1 });
      } else {
        const nm = nameMatch(q!, c.recipient);
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
      const dup = cands.find((o) => o.id !== c.id && o.source === 'manual' && o.currency === c.currency && o.amountCents === c.amountCents
        && normName(o.recipient) === normName(c.recipient) && Math.abs(toDay(o.date) - toDay(c.date)) <= DATE_TOLERANCE_DAYS);
      if (dup) caveats.push(`Possible duplicate: you recorded a similar payment on ${fmtDate(dup.date)}.`);
      caveats.push(`${COMPANION_LABELS.manual}. SaySafe can't see whether the money arrived.`);
    }
    if (score < 0.45) continue;
    out.push({ id: c.id, source: c.source, recipient: c.recipient, description: c.description, amountCents: c.amountCents, currency: c.currency, date: c.date, score: Math.round(score * 100) / 100, matchReasons: reasons, caveats, evidence: c.evidence });
  }
  out.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  const matches = out.slice(0, 10);

  // Several different people behind one first name.
  if (hasName) {
    const people = new Set(matches.filter((m) => m.source === 'manual').map((m) => normName(m.recipient)));
    if (people.size > 1) notes.push(`More than one person matches "${q}". Check which one you mean.`);
  }
  if (excludedShop > 0) notes.push(`${DEMO_SHOP_RECIPIENT} payments are not shown: they are shop purchases, not payments to ${q}.`);
  notes.push('SaySafe only knows Demo Shop payments made in this app and records you typed in. It cannot see your bank or your PayPal wallet.');

  const who = q ?? 'them';
  let guidance: string;
  if (!matches.length) guidance = `I couldn't find a record of paying ${who}. That doesn't mean you haven't paid. Check your bank statement, or ask ${who}, before you pay.`;
  else if (matches.every((m) => m.source === 'paypal_sandbox')) guidance = `These are ${DEMO_SHOP_RECIPIENT} payments made in this app (PayPal sandbox). They are shop purchases, not payments to a person.`;
  else guidance = `I found ${matches.length === 1 ? 'a record' : 'records'} that may match. A record you typed is not proof the money arrived. Don't pay again until you've checked with ${who}.`;

  return { query: { q, amountCents: amount, from, to: input.to ?? null }, matches, guidance, notes };
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
