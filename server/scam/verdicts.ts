/**
 * The three public verdicts, and the deterministic policy that picks one.
 *
 * SaySafe never says a message is "safe", "real" or "legitimate". The best it can say is
 * "No obvious warning signs", and that always carries NO_WARNING_DISCLOSURE.
 *
 * Older rows in security_scans (and older API clients) used three legacy codes:
 *   suspicious                -> suspicious
 *   needs_verification        -> needs_checking
 *   verified_official_contact -> no_obvious_warning_signs
 * normalizeVerdict() maps any stored or client-supplied value onto the new codes.
 */
export type Verdict = 'suspicious' | 'needs_checking' | 'no_obvious_warning_signs';
export type LegacyVerdict = 'suspicious' | 'needs_verification' | 'verified_official_contact';

export const VERDICT_LABEL: Record<Verdict, string> = {
  suspicious: 'Suspicious',
  needs_checking: 'Needs checking',
  no_obvious_warning_signs: 'No obvious warning signs',
};

export const NO_WARNING_DISCLOSURE =
  "SaySafe can't confirm who sent this or whether a payment is real. Check in the official PayPal app.";

export const VERDICT_RANK: Record<Verdict, number> = { no_obvious_warning_signs: 0, needs_checking: 1, suspicious: 2 };

/** Map any stored/legacy/unknown value to a public verdict. Unknown values fail closed to "needs_checking". */
export function normalizeVerdict(v: unknown): Verdict {
  switch (v) {
    case 'suspicious': return 'suspicious';
    case 'needs_checking':
    case 'needs_verification': return 'needs_checking';
    case 'no_obvious_warning_signs':
    case 'verified_official_contact': return 'no_obvious_warning_signs';
    default: return 'needs_checking';
  }
}

export function toLegacyVerdict(v: Verdict): LegacyVerdict {
  return v === 'suspicious' ? 'suspicious' : v === 'needs_checking' ? 'needs_verification' : 'verified_official_contact';
}

export function maxVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a;
}

/**
 * Risk families. Two medium signals only make a message "Suspicious" when they come from
 * different families AND at least one of them is a deception family (not just "it mentions a
 * payment" plus "it has a phone number", which an honest plumber's invoice also has).
 */
export type Family = 'payment' | 'contact' | 'pressure' | 'link' | 'identity' | 'story' | 'charge' | 'secret' | 'intel' | 'manipulation';
export const DECEPTION_FAMILIES: ReadonlySet<Family> = new Set(['pressure', 'link', 'identity', 'story', 'charge', 'secret', 'intel', 'manipulation']);

/** Where a finding comes from. Shown to the user next to each finding. */
export type Basis = 'deterministic_rule' | 'ai_judgement' | 'independently_verified';
export const BASIS_LABEL: Record<Basis, string> = {
  deterministic_rule: 'Deterministic rule',
  ai_judgement: 'AI judgement',
  independently_verified: 'Independently verified',
};

export interface PolicySignal {
  code: string;
  severity: 'high' | 'medium' | 'info';
  family?: Family;
  /** An info-level signal that still means "you must check this" (e.g. a phone number, an unknown link). */
  blocksAllClear?: boolean;
}

export interface PolicyLink {
  isOfficialPayPal: boolean;
  officialKind?: 'help' | 'home' | 'user_content' | 'other';
}

/**
 * Deterministic verdict.
 * - any high signal                                   -> suspicious
 * - medium signals from 2+ families, one deceptive    -> suspicious
 * - a story/pressure/charge/secret signal + a link that
 *   is not PayPal's                                    -> suspicious
 * - any medium signal, any blocking info signal,
 *   any link that is not a verified PayPal help/home
 *   page, or an uncertain screenshot                  -> needs_checking
 * - otherwise                                         -> no_obvious_warning_signs (+ disclosure)
 */
export function decideFromSignals(signals: PolicySignal[], links: PolicyLink[], opts: { ocrUncertain?: boolean } = {}): Verdict {
  if (signals.some((s) => s.severity === 'high')) return 'suspicious';
  const medFamilies = new Set(signals.filter((s) => s.severity === 'medium').map((s) => s.family ?? 'story'));
  if (medFamilies.size >= 2 && [...medFamilies].some((f) => DECEPTION_FAMILIES.has(f))) return 'suspicious';
  // A story, pressure or secret request that also points you to a link we cannot check.
  const hasUnverifiedLink = links.some((l) => !l.isOfficialPayPal);
  if (hasUnverifiedLink && ['story', 'pressure', 'secret', 'charge'].some((f) => medFamilies.has(f as Family))) return 'suspicious';
  if (medFamilies.size > 0) return 'needs_checking';
  if (signals.some((s) => s.blocksAllClear)) return 'needs_checking';
  if (links.some((l) => !(l.isOfficialPayPal && (l.officialKind === 'help' || l.officialKind === 'home')))) return 'needs_checking';
  if (opts.ocrUncertain) return 'needs_checking';
  return 'no_obvious_warning_signs';
}

/** What the model may say about a message. It can only say suspicious or needs_verification. */
export interface AiOpinion {
  verdict: 'suspicious' | 'needs_verification' | string;
  asks_for?: string[];
}

const RISKY_ASK = /pay|money|fund|transfer|card|bank|code|otp|pin\b|password|passcode|login|log in|sign in|call|phone|ring|gift|voucher|crypto|bitcoin|remote|anydesk|teamviewer|install|personal|identity|id\b|details|refund|fee|invoice/i;

/**
 * AI may raise the verdict, never lower it.
 * - AI "suspicious" raises needs_checking to suspicious, and no_obvious_warning_signs to needs_checking.
 * - AI "needs_verification" is the model's floor (it is told it may never say anything better),
 *   so on its own it carries no information. It raises "no obvious warning signs" to
 *   "needs checking" only when the model also names something risky the message asks for.
 */
export function mergeWithAi(rules: Verdict, ai: AiOpinion | null | undefined): Verdict {
  if (!ai) return rules;
  // One step up at most when the rules found nothing at all: the model is only allowed to say
  // "suspicious" or "needs_verification", and in the live eval it called plain receipts
  // "suspicious". Its doubt alone moves "no obvious warning signs" to "needs checking".
  if (ai.verdict === 'suspicious') return rules === 'no_obvious_warning_signs' ? 'needs_checking' : 'suspicious';
  if (rules === 'no_obvious_warning_signs' && (ai.asks_for ?? []).some((a) => RISKY_ASK.test(a))) return 'needs_checking';
  return rules;
}
