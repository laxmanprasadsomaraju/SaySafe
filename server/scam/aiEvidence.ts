/**
 * The AI layer's contract: what the model may return, and the deterministic checks its answer must
 * pass before it can change anything.
 *
 * - The model can only RAISE the verdict, by one step, and only with validated evidence.
 * - Each reason needs a category from a fixed list and an exact quote. The quote must be a substring of
 *   the normalised text SaySafe read (pasted text or screenshot text) or the host of a link in it, and it
 *   must actually show what the category claims (a "code request" quote must contain a request for a code).
 * - Vague possibilities ("could be", "unusual", "not verified", "no proof") are not evidence.
 * - Reasons that fail are dropped (and counted); if none remain the model has no effect at all.
 * - The model never lowers a rule warning and can never give "No obvious warning signs".
 */
import { z } from 'zod';
import { maxVerdict, type Verdict } from './verdicts.js';
import { truncateSafe, stripDisguise } from './evidence.js';
import { vouchesOrInstructs } from '../ai/outputGuard.js';

export const AI_CATEGORIES = [
  'urgency_or_threat',
  'payment_request',
  'code_or_password_request',
  'remote_access',
  'impersonation',
  'suspicious_link',
  'unexpected_charge_or_refund',
  'gift_card_or_crypto',
  'secrecy',
  'prize_or_too_good',
  'call_this_number',
  'instructions_to_checker',
] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];

export const AI_CATEGORY_LABEL: Record<AiCategory, string> = {
  urgency_or_threat: 'Pressure or threats',
  payment_request: 'Asks for money',
  code_or_password_request: 'Asks for a code, password or card details',
  remote_access: 'Asks you to install an app or share your screen',
  impersonation: 'Claims to be someone it may not be',
  suspicious_link: 'A link to check',
  unexpected_charge_or_refund: 'A charge or refund story',
  gift_card_or_crypto: 'Gift cards or crypto',
  secrecy: 'Asks you to keep it secret',
  prize_or_too_good: 'A prize or an offer too good to be true',
  call_this_number: 'Tells you to call a number',
  instructions_to_checker: 'Orders aimed at a scam checker',
};

/** Categories that point at deception, not just "money is involved". Only these can raise Needs checking to Suspicious. */
// "impersonation" is left out: whether a sender is who they claim is exactly what SaySafe cannot know, and in
// the live run the model called genuine senders (a plumber, a swim club) impostors. Lookalike links and
// addresses are caught by the rules instead.
const DECEPTIVE: ReadonlySet<AiCategory> = new Set(AI_CATEGORIES.filter((c) => !['payment_request', 'call_this_number', 'suspicious_link', 'impersonation'].includes(c)));

/**
 * Strict schema. Unknown keys, a verdict outside the list (e.g. "safe" from an injected message) or a
 * category outside the list fail validation; the caller retries once, then falls back to rule checks only.
 * spoken_summary is optional on purpose: in the live run the model sometimes left it out (root cause of
 * 3/66 invalid outputs) and it is never trusted anyway; the deterministic wording is used instead.
 */
export const AiReason = z.object({
  category: z.enum(AI_CATEGORIES),
  quote: z.string().max(400),
  explanation: z.string().max(400),
}).strict();

export const AiAssessment = z.object({
  verdict: z.enum(['suspicious', 'needs_checking', 'no_extra_concern', 'needs_verification'])
    .transform((v) => (v === 'needs_verification' ? 'needs_checking' : v) as 'suspicious' | 'needs_checking' | 'no_extra_concern'),
  reasons: z.array(AiReason).max(8),
  spoken_summary: z.string().max(1200).optional(),
}).strict();
export type AiAssessmentT = z.infer<typeof AiAssessment>;

export const AI_JSON_SHAPE = `{"verdict":"suspicious|needs_checking|no_extra_concern","reasons":[{"category":"${AI_CATEGORIES.join('|')}","quote":"exact words copied from the message","explanation":"one short plain sentence"}],"spoken_summary":"..."}`;

// ---------- validation ----------

/** Normalise for quote matching: NFKC, strip disguise characters, unify quotes/dashes, collapse whitespace, lower case. */
export function normForQuote(s: string): string {
  return stripDisguise(s.normalize('NFKC'))
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Hedging, absence and "can't be sure" claims are not evidence. */
const VAGUE = /\b(?:could|might|may)\b|\bpossibl[ey]\b|\bperhaps\b|\bunusual\b|\bodd\b|\bseems?\b|\bappears? to\b|\b(?:not|never) (?:been )?(?:verified|confirmed)\b|\bcannot be (?:verified|confirmed)\b|\bunverified\b|\bno (?:proof|official|verification|details|contact)\b|\bdoes(?: not|n't) (?:provide|include|give|mention|say)\b|\black(?:s|ing)? of\b|\bgeneric\b|\btypical\b|\bcommon (?:scam )?(?:tactic|trick|technique)s?\b/i;

/** What a quote must contain for each category (deterministic, on the quote itself). */
const CUE: Record<AiCategory, RegExp> = {
  urgency_or_threat: /\b(?:urgent(?:ly)?|immediately|right away|asap|act now|within (?:the next )?(?:\d|an?\b|one|two|twenty)|before midnight|deadline|final (?:notice|warning|reminder)|last (?:chance|warning)|expires? (?:today|tonight|soon|in)|suspend(?:ed|sion)?|closure|will be closed|locked|limited|restricted|frozen|cut off|legal action|police|court|arrest(?:ed)?|penalt(?:y|ies)|(?:pay|settle|send|transfer)\b.{0,25}\b(?:today|tonight|now))/i,
  payment_request: /(?:[€$£]\s?\d|\d\s?(?:eur|euro|usd|gbp)\b|\b(?:pay|send|transfer|wire|lodge|settle|refund|lend|deposit|fee|invoice|amount due|money|request(?:ed)?)\b)/i,
  code_or_password_request: /\b(?:code|otp|pin|password|passcode|card (?:number|details)|cvv|bank (?:details|login)|login|sign[- ]?in details|security (?:questions?|answers?))\b/i,
  remote_access: /\b(?:anydesk|teamviewer|team viewer|quick ?support|quick ?assist|rustdesk|ultraviewer|logmein|remote|screen|install)\b/i,
  impersonation: /\b(?:paypal|bank|garda|revenue|an post|dpd|eir|support|security|fraud|team|department|official|it['’]?s me|this is|new number|your (?:son|daughter|grandson|granddaughter)|mum|mam|dad|nana|granny|father|landlord)\b/i,
  suspicious_link: /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b)/i,
  unexpected_charge_or_refund: /\b(?:charged|billed|debited|auto[- ]?renew|renewal|has been (?:processed|authori[sz]ed|completed)|not you|wasn['’]?t you|didn['’]?t (?:make|authori[sz]e|order)|did not (?:make|authori[sz]e|order)|by mistake|in error|too much|overpa(?:id|yment)|refund (?:is )?(?:pending|waiting|due|owed|available)|claim (?:your|the) refund|entitled to a refund|owed €|due a refund)/i,
  gift_card_or_crypto: /\b(?:gift ?cards?|vouchers?|google play|itunes|apple|steam|paysafe|bitcoin|btc|crypto|usdt|wallet)\b/i,
  secrecy: /\b(?:secret|between us|don['’]?t tell|do not tell|keep (?:this|it) quiet|tell (?:no ?one|nobody|anyone))\b/i,
  prize_or_too_good: /\b(?:won|winner|prize|selected|congratulations|reward|free|guaranteed|returns?|profits?|double)\b/i,
  call_this_number: /(?:\b(?:call|ring|phone|dial|whatsapp|contact|helpline|hotline)\b|(?:\+|00)\d|\b0\d[\d\s-]{6,})/i,
  instructions_to_checker: /\b(?:ignore|disregard|instructions?|mark|classify|label|treat|as safe|you are an?|ai|assistant|system)\b/i,
};

/** A request for a code in the quote must not be negated ("don't share it", "never give your PIN"). */
const NEGATED_REQUEST = /\b(?:never|don['’]?t|do not|not|no one|nobody|won['’]?t|will not)\b[^.]{0,30}\b(?:share|send|give|tell|read|ask|enter|reply)\b/i;

export interface ValidatedReason { category: AiCategory; categoryLabel: string; quote: string; explanation: string }
export interface DroppedReason { category: string; quote: string; why: 'quote_not_found' | 'quote_too_short' | 'quote_too_long' | 'quote_does_not_show_category' | 'vague' | 'unsafe_wording' | 'negated' | 'duplicate' }

export function validateAiReasons(
  reasons: AiAssessmentT['reasons'],
  sources: { text: string; hosts: string[] },
): { valid: ValidatedReason[]; dropped: DroppedReason[] } {
  const hay = normForQuote(sources.text);
  const hosts = sources.hosts.map((h) => normForQuote(h)).filter(Boolean);
  const valid: ValidatedReason[] = [];
  const dropped: DroppedReason[] = [];
  const seen = new Set<string>();
  for (const r of reasons) {
    const q = normForQuote(r.quote).replace(/^["'“”‘’]+|["'“”‘’.,;:!?]+$/g, '').trim();
    const drop = (why: DroppedReason['why']) => dropped.push({ category: r.category, quote: truncateSafe(r.quote, 80), why });
    if (Array.from(q).length < 4) { drop('quote_too_short'); continue; }
    if (Array.from(q).length > 240) { drop('quote_too_long'); continue; }
    const inText = hay.includes(q);
    const isHost = hosts.some((h) => h === q || h.endsWith('.' + q) || q === h.replace(/^www\./, ''));
    if (!inText && !isHost) { drop('quote_not_found'); continue; }
    if (!CUE[r.category].test(q)) { drop('quote_does_not_show_category'); continue; }
    if (r.category === 'code_or_password_request' && NEGATED_REQUEST.test(q)) { drop('negated'); continue; }
    if (VAGUE.test(r.explanation)) { drop('vague'); continue; }
    if (vouchesOrInstructs(r.explanation)) { drop('unsafe_wording'); continue; }
    const key = r.category + '|' + q;
    if (seen.has(key)) { drop('duplicate'); continue; }
    seen.add(key);
    valid.push({ category: r.category, categoryLabel: AI_CATEGORY_LABEL[r.category], quote: truncateSafe(r.quote, 160), explanation: truncateSafe(r.explanation, 240) });
  }
  return { valid: valid.slice(0, 4), dropped };
}

/**
 * AI raise, after validation. Never lowers; at most one step; nothing without a validated reason.
 * - no_extra_concern, or no valid reasons                       -> rules verdict unchanged
 * - "No obvious warning signs" + any valid reason               -> Needs checking
 * - "Needs checking" + AI suspicious + a valid DECEPTIVE reason -> Suspicious
 */
export function raiseWithEvidence(rules: Verdict, ai: { verdict: AiAssessmentT['verdict'] } | null, valid: ValidatedReason[]): Verdict {
  if (!ai || ai.verdict === 'no_extra_concern' || valid.length === 0) return rules;
  if (rules === 'no_obvious_warning_signs') return 'needs_checking';
  if (rules === 'needs_checking' && ai.verdict === 'suspicious' && valid.some((v) => DECEPTIVE.has(v.category))) return maxVerdict(rules, 'suspicious');
  return rules;
}
