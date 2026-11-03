/**
 * The three evidence classes shown with every scan, in the API and the UI:
 *
 *  1. observable  — plain facts about what is in the message: a link and its host, a phone number, an
 *                   email address, an amount, that the text came from a screenshot. No judgement.
 *  2. rule        — a deterministic SaySafe rule matched, with the exact words it matched.
 *  3. ai          — an AI interpretation that passed the evidence gate (exact quote + fixed category).
 *
 * Nothing here says a sender, payment or merchant is "verified": SaySafe has no independent check for
 * those. A paypal.com address is reported as where a link points, not as proof of who sent it.
 */
import type { RuleResult } from './rules.js';
import type { ValidatedReason } from './aiEvidence.js';
import type { ReputationResult } from './reputation.js';
import { truncateSafe, quoteSpan } from './evidence.js';

export interface ObservableFact { kind: 'link' | 'phone' | 'email' | 'amount' | 'screenshot' | 'scam_list'; text: string; quote?: string }
export interface RuleEvidence { code: string; severity: 'high' | 'medium' | 'info'; title: string; quote?: string; detail: string }
export interface AiEvidence { category: string; categoryLabel: string; quote: string; explanation: string }
export interface EvidenceClasses {
  observable: ObservableFact[];
  rule: RuleEvidence[];
  ai: AiEvidence[];
  /** Plain labels for the three classes, for clients that render them. */
  labels: { observable: string; rule: string; ai: string };
}

export const EVIDENCE_LABELS = {
  observable: 'What is in the message',
  rule: 'SaySafe rule checks that matched',
  ai: 'AI interpretation (quoted from the message)',
} as const;

const MONEY_RE = /(?:[€$£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:eur|euro|euros|usd|gbp)\b)/gi;

export function buildEvidence(a: { src: string; rules: RuleResult; ai: ValidatedReason[]; fromImage: boolean; reputation: ReputationResult[] }): EvidenceClasses {
  const src = a.src.normalize('NFKC');
  const observable: ObservableFact[] = [];
  if (a.fromImage) observable.push({ kind: 'screenshot', text: 'The text was read from a screenshot.' });
  for (const l of a.rules.links.slice(0, 8)) {
    const host = l.hostname ?? 'an address SaySafe could not read';
    const where = l.isOfficialPayPal
      ? l.officialKind === 'user_content'
        ? `A link to ${host}, a PayPal page that any PayPal user can create (invoice, request or PayPal.me). It shows where the link goes, not who sent it.`
        : `A link to ${host}, a PayPal-owned address. It shows where the link goes, not who sent the message.`
      : `A link to ${host}.`;
    observable.push({ kind: 'link', text: where, quote: truncateSafe(l.raw, 120) });
  }
  for (const p of a.rules.phones.slice(0, 5)) observable.push({ kind: 'phone', text: 'A phone number.', quote: truncateSafe(p, 40) });
  for (const e of a.rules.emails.slice(0, 5)) observable.push({ kind: 'email', text: 'An email address.', quote: truncateSafe(e, 80) });
  const amounts = Array.from(new Set(Array.from(src.matchAll(MONEY_RE)).map((m) => m[0].trim()))).slice(0, 4);
  for (const m of amounts) {
    const i = src.indexOf(m);
    observable.push({ kind: 'amount', text: 'An amount of money.', quote: i >= 0 ? quoteSpan(src, i, i + m.length, 20, 80) : m });
  }
  for (const r of a.reputation.filter((x) => x.listed)) observable.push({ kind: 'scam_list', text: `This link is on a scam list (${r.source}).`, quote: truncateSafe(r.url, 120) });

  const rule: RuleEvidence[] = a.rules.signals
    .filter((s) => s.code !== 'threat_intel')
    .map((s) => ({ code: s.code, severity: s.severity, title: s.title, quote: s.evidence, detail: s.detail }));

  const ai: AiEvidence[] = a.ai.map((r) => ({ category: r.category, categoryLabel: r.categoryLabel, quote: r.quote, explanation: r.explanation }));
  return { observable, rule, ai, labels: { ...EVIDENCE_LABELS } };
}
