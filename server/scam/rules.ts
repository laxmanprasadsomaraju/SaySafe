/**
 * Deterministic scam signals. The AI never decides "safe" on its own:
 * these rules run first, and the final verdict can only be made STRICTER by AI.
 * We never fetch or open any URL found in a message (no SSRF, no link execution).
 */
import { parse as parseDomain } from 'tldts';
import { domainToUnicode } from 'node:url';
import { PROTECTED_BRANDS, TRUSTED_DOMAINS, TRUSTED_EMAILS, TRUSTED_HELP_PAGES, URL_SHORTENERS, PAYPAL_USER_CONTENT_DOMAINS } from './directory.js';
import { decideFromSignals, maxVerdict, normalizeVerdict, type Verdict, type Family, type Basis } from './verdicts.js';
import { extractLinks, extractPhones, truncateSafe } from './evidence.js';
import { detectIndicators } from './indicators.js';

export type { Verdict } from './verdicts.js';
export type Severity = 'high' | 'medium' | 'info';

export interface Signal {
  code: string;
  severity: Severity;
  title: string; // plain words, shown to the user
  detail: string; // why it matters
  /** The exact matched text, URL or indicator from the message (safely truncated, shown as plain text). */
  evidence?: string;
  family?: Family;
  /** Where the finding comes from: a deterministic rule, the AI model, or an independent source. */
  basis?: Basis;
  /** An info signal that still rules out "No obvious warning signs". */
  blocksAllClear?: boolean;
}

export interface ExtractedLink {
  raw: string;
  hostname: string | null;
  registrableDomain: string | null;
  isOfficialPayPal: boolean;
  /** For PayPal-owned links: a help page we verified, the home page, a page anyone can create (invoice, request, paypal.me), or another PayPal page. */
  officialKind?: 'help' | 'home' | 'user_content' | 'other';
}

export interface RuleResult {
  verdict: Verdict;
  signals: Signal[];
  links: ExtractedLink[];
  emails: string[];
  phones: string[];
  officialMatches: string[];
}

// PayPal pages that ANY PayPal user can create and send: real PayPal URL, but not proof the sender is honest.
const USER_CONTENT_PATH = /^\/(?:[a-z]{2}\/)?(?:invoice|invoices|request|myaccount\/transfer|paypalme|pools|donate|ncp|qrcodes|checkoutnow|webapps\/hermes|signin\/.*invoice)/i;
const HOME_PATH = /^\/(?:[a-z]{2}(?:\/home)?\/?)?$/i;

/** Levenshtein distance, small strings only. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

const HOMOGLYPHS: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '5': 's', '7': 't', '@': 'a', '$': 's', 'rn': 'm', 'vv': 'w', 'i': 'l' };
function deHomoglyph(s: string) {
  let out = s;
  for (const [k, v] of Object.entries(HOMOGLYPHS)) out = out.split(k).join(v);
  return out;
}

export function isOfficialDomain(registrable: string | null): boolean {
  if (!registrable) return false;
  return TRUSTED_DOMAINS.some((d) => d.value === registrable);
}

export function analyseLink(raw: string): { link: ExtractedLink; signals: Signal[] } {
  const signals: Signal[] = [];
  let candidate = raw.trim().replace(/[.,;:!?]+$/, '');
  if (!/^https?:\/\//i.test(candidate)) candidate = 'http://' + candidate;
  let hostname: string | null = null;
  let url: URL | null = null;
  try {
    url = new URL(candidate);
    hostname = url.hostname.toLowerCase();
  } catch {
    signals.push({ code: 'url_unparseable', severity: 'medium', title: 'A link looks broken or disguised', detail: 'We could not read this link safely.', evidence: raw });
  }
  const parsed = hostname ? parseDomain(hostname) : null;
  const registrable = parsed?.domain ?? null;
  const userContentDomain = !!registrable && PAYPAL_USER_CONTENT_DOMAINS.includes(registrable);
  const official = isOfficialDomain(registrable) || userContentDomain;
  const link: ExtractedLink = { raw, hostname, registrableDomain: registrable, isOfficialPayPal: official };
  if (!hostname || !url) return { link, signals };
  if (official) {
    const bare = (url.origin + url.pathname).replace(/\/$/, '').toLowerCase();
    if (TRUSTED_HELP_PAGES.some((p) => bare === p.value.replace(/\/$/, '').toLowerCase())) link.officialKind = 'help';
    else if (userContentDomain || USER_CONTENT_PATH.test(url.pathname)) link.officialKind = 'user_content';
    else if (HOME_PATH.test(url.pathname)) link.officialKind = 'home';
    else link.officialKind = 'other';
    if (link.officialKind === 'user_content') {
      signals.push({ code: 'paypal_user_content', severity: 'medium', title: 'A real PayPal page that anyone can send', detail: 'Invoices, money requests and PayPal.me links are created by other users. A genuine PayPal address does not make the sender honest. Only pay if you expected it, and check inside the PayPal app.', evidence: hostname + url.pathname });
    }
  }

  // Raw credentials or @ trick: https://paypal.com@evil.com
  if (url.username || url.password || /@/.test(raw.replace(/^mailto:/i, '').split('/')[2] ?? '')) {
    signals.push({ code: 'url_at_trick', severity: 'high', title: 'The link hides its real address', detail: 'Text before an "@" in a web address is ignored by browsers. The real site is after it.', evidence: raw });
  }
  if (parsed?.isIp) {
    signals.push({ code: 'url_ip', severity: 'high', title: 'The link goes to a bare number address', detail: 'Real companies use their own names, not number addresses.', evidence: hostname });
  }
  // Punycode / IDN
  if (hostname.split('.').some((l) => l.startsWith('xn--')) || /[^\x00-\x7f]/.test(hostname)) {
    let shown = hostname;
    try { shown = domainToUnicode(hostname) || hostname; } catch { /* ignore */ }
    signals.push({ code: 'url_idn', severity: 'high', title: 'The link uses look-alike letters', detail: 'This address uses special characters that can imitate normal letters.', evidence: `${hostname} (shows as ${shown})` });
  }
  if (registrable && URL_SHORTENERS.has(registrable)) {
    signals.push({ code: 'url_shortener', severity: 'medium', title: 'The link hides where it goes', detail: 'Short links hide the real website. PayPal security messages do not need them.', evidence: hostname });
  }
  if (!official) {
    const label = (parsed?.domainWithoutSuffix ?? '').toLowerCase();
    const sub = (parsed?.subdomain ?? '').toLowerCase();
    for (const brand of PROTECTED_BRANDS) {
      const flat = deHomoglyph(label.replace(/[-_]/g, ''));
      if (sub.split('.').includes(brand) || sub.includes(brand)) {
        signals.push({ code: 'url_brand_in_subdomain', severity: 'high', title: `The link pretends to be ${cap(brand)}`, detail: `"${brand}" appears at the start, but the real website is ${registrable}.`, evidence: hostname });
      } else if (label.includes(brand) || flat.includes(brand)) {
        signals.push({ code: 'url_brand_lookalike', severity: 'high', title: `The link imitates ${cap(brand)}`, detail: `${registrable} is not ${cap(brand)}'s website.`, evidence: hostname });
      } else if (label.length >= 4 && isTyposquat(label, brand)) {
        signals.push({ code: 'url_typosquat', severity: 'high', title: `The link is spelled almost like ${cap(brand)}`, detail: `${registrable} is a near-copy of ${brand}.com.`, evidence: hostname });
      } else if (url.pathname.toLowerCase().includes(brand) || url.search.toLowerCase().includes(brand)) {
        signals.push({ code: 'url_brand_in_path', severity: 'medium', title: `The link mentions ${cap(brand)} but goes to another website`, detail: `The website is ${registrable}. "${brand}" later in the address means nothing.`, evidence: truncateSafe(hostname + url.pathname, 100) });
      }
    }
    if (/(login|signin|verify|secure|account|update|unlock|support|billing|confirm)/i.test(url.pathname + hostname) && !official) {
      signals.push({ code: 'url_login_words', severity: 'medium', title: 'The link asks you to sign in or "verify" on another site', detail: 'Only sign in on paypal.com, typed yourself or from the PayPal app.', evidence: hostname });
    }
    if (url.protocol === 'http:' && /^https?:\/\//i.test(raw) ) {
      signals.push({ code: 'url_http', severity: 'info', title: 'The link is not secure (http)', detail: 'It does not use an encrypted connection.', evidence: hostname });
    }
  }
  for (const sg of signals) {
    sg.family ??= sg.code === 'paypal_user_content' ? 'payment' : 'link';
    sg.basis ??= 'deterministic_rule';
    if (sg.evidence) sg.evidence = truncateSafe(sg.evidence, 120);
  }
  return { link, signals };
}

/** Near-spellings of a brand. Tight on purpose: "payday" or "paypay" are real words/brands, not lookalikes. */
function isTyposquat(label: string, brand: string): boolean {
  const flat = label.replace(/[-_]/g, '');
  if (editDistance(deHomoglyph(flat), brand) <= 1) return true;
  // two edits only when the label also uses digits or look-alike characters (paypa1l, pay-pa1)
  return /[0-9]/.test(label) && editDistance(deHomoglyph(flat), brand) <= 2;
}

const BRAND_NAMES: Record<string, string> = { paypal: 'PayPal' };
function cap(s: string) { return BRAND_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1); }

const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

export function extract(text: string) {
  const src = text.normalize('NFKC');
  const emails = Array.from(new Set((src.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())));
  const emailDomains = new Set(emails.map((e) => e.split('@')[1]));
  const links = extractLinks(src).map((l) => l.raw).filter((l) => !emailDomains.has(l.toLowerCase()));
  // Email addresses also look like phone-free text; remove them before looking for numbers.
  const noEmails = src.replace(EMAIL_RE, (m) => ' '.repeat(m.length));
  const phones = Array.from(new Set(extractPhones(noEmails).map((p) => p.raw)));
  return { links, emails, phones };
}

export function analyseText(input: string, opts: { ocrUncertain?: boolean } = {}): RuleResult {
  const src = input.normalize('NFKC').slice(0, 20000);
  const lower = src.toLowerCase();
  const signals: Signal[] = [];
  const { links: rawLinks, emails, phones } = extract(src);
  const links: ExtractedLink[] = [];
  const officialMatches: string[] = [];

  for (const raw of rawLinks.slice(0, 20)) {
    const r = analyseLink(raw);
    links.push(r.link);
    signals.push(...r.signals);
    if (r.link.isOfficialPayPal) officialMatches.push(r.link.hostname!);
  }
  const unofficial = links.filter((l) => !l.isOfficialPayPal);
  if (unofficial.length && !signals.some((s) => s.family === 'link' && s.severity !== 'info')) {
    signals.push({ code: 'link_unverified', severity: 'info', blocksAllClear: true, family: 'link', basis: 'deterministic_rule', title: 'A link SaySafe cannot check', detail: 'SaySafe reads the address but never opens it, so it cannot tell you what is on that page.', evidence: truncateSafe(unofficial.map((l) => l.raw).join(', '), 120) });
  }

  for (const e of emails) {
    const domain = e.split('@')[1];
    const reg = parseDomain(domain).domain;
    const trusted = TRUSTED_EMAILS.find((t) => t.value === e);
    const base = { basis: 'deterministic_rule' as const, evidence: e };
    if (trusted) {
      officialMatches.push(e);
    } else if (isOfficialDomain(reg)) {
      signals.push({ ...base, code: 'email_paypal_unlisted', severity: 'info', family: 'identity', title: 'An @paypal.com address we have not verified', detail: 'Sender names and addresses can be faked. Check inside the PayPal app instead.' });
    } else if (PROTECTED_BRANDS.some((b) => domain.includes(b) || deHomoglyph(domain).includes(b))) {
      signals.push({ ...base, code: 'email_brand_lookalike', severity: 'high', family: 'identity', title: 'An email address pretends to be PayPal', detail: `${domain} is not PayPal.` });
    } else if (/(gmail|outlook|hotmail|yahoo|icloud|proton|aol|gmx|mail)\./.test(domain) && /paypal|support|security|billing|refund|helpdesk|customer service/.test(lower)) {
      signals.push({ ...base, code: 'email_free_provider', severity: 'high', family: 'identity', title: 'A free email address claims to be support', detail: 'Companies like PayPal do not use Gmail, Outlook or Yahoo for support.' });
    } else {
      signals.push({ ...base, code: 'email_unverified', severity: 'info', blocksAllClear: true, family: 'identity', title: 'An email address SaySafe cannot check', detail: 'Anyone can create an email address. Reply only to addresses you already know.' });
    }
  }

  if (phones.length) {
    const askedToCall = /\b(call|ring|phone|dial|contact|whatsapp|text)\b/.test(lower);
    signals.push({ code: 'phone_unverified', severity: askedToCall ? 'medium' : 'info', blocksAllClear: true, family: 'contact', basis: 'deterministic_rule', title: 'A phone number we cannot verify', detail: 'Do not call numbers from messages. Scammers put their own number on real-looking invoices. Use the contact page inside the PayPal app.', evidence: truncateSafe(phones.join(', '), 80) });
  }

  signals.push(...detectIndicators(src, { phones: phones.length, unofficialLinks: unofficial.length, userContentLinks: links.filter((l) => l.officialKind === 'user_content').length }));

  return { verdict: decideVerdict(signals, officialMatches, links, input, opts), signals, links, emails, phones, officialMatches };
}

/**
 * Verdict policy (deterministic). See decideFromSignals in verdicts.ts:
 * - any high signal, or medium signals from 2+ risk families (one of them deceptive) -> suspicious
 * - any other warning, any phone number / unknown link / unknown email               -> needs_checking
 * - nothing found                                                                    -> no_obvious_warning_signs
 *   (always shown with the disclosure that SaySafe cannot confirm the sender or payment)
 * A genuine paypal.com link never lowers the verdict: it only means "no lookalike signal".
 */
export function decideVerdict(signals: Signal[], _officialMatches: string[], links: ExtractedLink[], _input: string, opts: { ocrUncertain?: boolean } = {}): Verdict {
  return decideFromSignals(signals, links, opts);
}

/** AI may only escalate, never downgrade. Accepts legacy codes from older callers. */
export function mergeVerdict(rules: Verdict, ai: string | null | undefined): Verdict {
  if (!ai) return rules;
  const a = normalizeVerdict(ai);
  if (a === 'no_obvious_warning_signs') return rules; // AI can never grant the all-clear
  return maxVerdict(rules, a);
}
