/**
 * Deterministic scam signals. The AI never decides "safe" on its own:
 * these rules run first, and the final verdict can only be made STRICTER by AI.
 * We never fetch or open any URL found in a message (no SSRF, no link execution).
 */
import { parse as parseDomain } from 'tldts';
import { domainToUnicode } from 'node:url';
import { PROTECTED_BRANDS, TRUSTED_DOMAINS, TRUSTED_EMAILS, TRUSTED_HELP_PAGES, URL_SHORTENERS, PAYPAL_USER_CONTENT_DOMAINS } from './directory.js';

export type Severity = 'high' | 'medium' | 'info';
export type Verdict = 'suspicious' | 'needs_verification' | 'verified_official_contact';

export interface Signal {
  code: string;
  severity: Severity;
  title: string; // plain words, shown to the user
  detail: string;
  evidence?: string;
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

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')\]]+|[a-z0-9][a-z0-9.-]*\.(?:com|net|org|info|xyz|top|ie|co|io|me|app|site|online|link|live|support|help|shop|biz|ru|cn|tk|ml|ga|cf|gq|uk|us)(?:\/[^\s<>"')\]]*)?)/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{7,}\d/g;

const URGENCY = [
  'immediately', 'urgent', 'within 24 hours', 'within 24h', 'right now', 'act now', 'final notice',
  'last warning', 'suspended', 'will be closed', 'locked', 'limited', 'restricted', 'expire today',
  'legal action', 'police', 'arrest', 'avoid suspension',
];
const SENSITIVE = [
  'password', 'one-time code', 'one time code', 'otp', 'verification code', 'security code', 'pin',
  'card number', 'cvv', 'bank details', 'login details', 'confirm your identity', 'verify your account',
  'remote access', 'anydesk', 'teamviewer',
];
const GIFT_CARD = ['gift card', 'giftcard', 'itunes card', 'google play card', 'steam card', 'amazon voucher', 'crypto', 'bitcoin', 'usdt'];
const PAY_DEMAND = ['pay', 'payment of', 'send €', 'send $', 'send £', 'refund fee', 'unlock fee', 'release fee', 'transfer'];
const INVOICE_SCAM = [
  'geek squad', 'norton', 'mcafee', 'bitcoin purchase', 'btc purchase', 'did not authorise', 'did not authorize',
  "didn't authorise", "didn't authorize", 'not authorised', 'not authorized', 'if you did not make this',
  'if this was not you', 'cancel this transaction', 'cancel this order', 'to dispute this', 'billing department',
];
// PayPal pages that ANY PayPal user can create and send: real PayPal URL, but not proof the sender is honest.
const USER_CONTENT_PATH = /^\/(?:[a-z]{2}\/)?(?:invoice|invoices|request|myaccount\/transfer|paypalme|pools|donate|ncp|qrcodes|checkoutnow|webapps\/hermes|signin\/.*invoice)/i;
const HOME_PATH = /^\/(?:[a-z]{2}(?:\/home)?\/?)?$/i;

const CALL_US = ['call us', 'call our', 'contact our security team', 'call the number', 'ring us', 'phone us'];

function norm(s: string) {
  return s.normalize('NFKC').toLowerCase();
}

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
      } else if (label.length >= 4 && editDistance(deHomoglyph(label), brand) <= 2) {
        signals.push({ code: 'url_typosquat', severity: 'high', title: `The link is spelled almost like ${cap(brand)}`, detail: `${registrable} is a near-copy of ${brand}.com.`, evidence: hostname });
      }
    }
    if (/(login|signin|verify|secure|account|update|unlock|support|billing|confirm)/i.test(url.pathname + hostname) && !official) {
      signals.push({ code: 'url_login_words', severity: 'medium', title: 'The link asks you to sign in or "verify" on another site', detail: 'Only sign in on paypal.com, typed yourself or from the PayPal app.', evidence: hostname });
    }
    if (url.protocol === 'http:' && /^https?:\/\//i.test(raw) ) {
      signals.push({ code: 'url_http', severity: 'info', title: 'The link is not secure (http)', detail: 'It does not use an encrypted connection.', evidence: hostname });
    }
  }
  return { link, signals };
}

const BRAND_NAMES: Record<string, string> = { paypal: 'PayPal' };
function cap(s: string) { return BRAND_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1); }

export function extract(text: string) {
  const links = Array.from(new Set((text.match(URL_RE) ?? []).filter((u) => !/@/.test(u.split('/')[0]) || /^https?:/i.test(u))));
  const emails = Array.from(new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())));
  // drop link matches that are actually the domain part of an email
  const emailDomains = new Set(emails.map((e) => e.split('@')[1]));
  const cleanLinks = links.filter((l) => !emailDomains.has(l.toLowerCase()));
  const phones = Array.from(new Set((text.match(PHONE_RE) ?? []).map((p) => p.trim()).filter((p) => p.replace(/\D/g, '').length >= 8 && p.replace(/\D/g, '').length <= 15)));
  return { links: cleanLinks, emails, phones };
}

export function analyseText(input: string): RuleResult {
  const text = norm(input).slice(0, 20000);
  const signals: Signal[] = [];
  const { links: rawLinks, emails, phones } = extract(input);
  const links: ExtractedLink[] = [];
  const officialMatches: string[] = [];

  for (const raw of rawLinks.slice(0, 20)) {
    const r = analyseLink(raw);
    links.push(r.link);
    signals.push(...r.signals);
    if (r.link.isOfficialPayPal) officialMatches.push(r.link.hostname!);
  }

  for (const e of emails) {
    const domain = e.split('@')[1];
    const reg = parseDomain(domain).domain;
    const trusted = TRUSTED_EMAILS.find((t) => t.value === e);
    if (trusted) {
      officialMatches.push(e);
    } else if (isOfficialDomain(reg)) {
      signals.push({ code: 'email_paypal_unlisted', severity: 'info', title: 'An @paypal.com address we have not verified', detail: 'Sender names and addresses can be faked. Check inside the PayPal app instead.', evidence: e });
    } else if (PROTECTED_BRANDS.some((b) => domain.includes(b) || deHomoglyph(domain).includes(b))) {
      signals.push({ code: 'email_brand_lookalike', severity: 'high', title: 'An email address pretends to be PayPal', detail: `${domain} is not PayPal.`, evidence: e });
    } else if (/(gmail|outlook|hotmail|yahoo|icloud|proton|aol|mail)\./.test(domain) && /paypal|support|security|billing|refund/.test(text)) {
      signals.push({ code: 'email_free_provider', severity: 'high', title: 'A free email address claims to be support', detail: 'Companies like PayPal do not use Gmail, Outlook or Yahoo for support.', evidence: e });
    }
  }

  if (phones.length) {
    signals.push({ code: 'phone_unverified', severity: /call|ring|phone|contact/.test(text) ? 'medium' : 'info', title: 'A phone number we cannot verify', detail: 'Do not call numbers from messages. Use the official PayPal contact page instead.', evidence: phones.join(', ') });
  }

  const hits = (words: string[]) => words.filter((w) => text.includes(w));
  const urgent = hits(URGENCY);
  if (urgent.length) signals.push({ code: 'urgency', severity: urgent.length > 1 ? 'high' : 'medium', title: 'It pressures you to act fast', detail: 'Scammers rush you so you do not stop and check.', evidence: urgent.slice(0, 4).join(', ') });
  const sens = hits(SENSITIVE);
  if (sens.length) signals.push({ code: 'sensitive_request', severity: 'high', title: 'It asks for private details', detail: 'PayPal never asks for your password, codes or card details in a message.', evidence: sens.slice(0, 4).join(', ') });
  const gift = hits(GIFT_CARD);
  if (gift.length) signals.push({ code: 'gift_card', severity: 'high', title: 'It asks for gift cards or crypto', detail: 'No real company asks to be paid in gift cards or crypto.', evidence: gift.join(', ') });
  const pay = hits(PAY_DEMAND);
  const amount = input.match(/[€$£]\s?\d[\d,.]*|\d[\d,.]*\s?(?:eur|euro|usd|gbp)/i);
  if (pay.length && amount) signals.push({ code: 'payment_demand', severity: 'medium', title: 'It demands a payment', detail: 'Check any payment request inside the PayPal app, never from a link.', evidence: amount[0] });
  const inv = hits(INVOICE_SCAM);
  if (inv.length) {
    const strong = phones.length > 0 || links.some((l) => l.officialKind === 'user_content');
    signals.push({ code: 'invoice_scam', severity: strong ? 'high' : 'medium', title: 'It looks like a fake invoice or charge', detail: 'Scammers send scary "you were charged" invoices so you call them. Check your real activity in the PayPal app. Never call a number on an invoice.', evidence: inv.slice(0, 3).join(', ') });
  }
  const callUs = hits(CALL_US);
  if (callUs.length) signals.push({ code: 'call_us', severity: 'medium', title: 'It tells you to call or contact "support"', detail: 'Fake support lines are a common trick.', evidence: callUs.join(', ') });
  if (/\b(dear (customer|user|client|member))\b/.test(text)) signals.push({ code: 'generic_greeting', severity: 'info', title: 'It does not use your name', detail: 'Real PayPal emails usually greet you by your name.', evidence: 'dear customer' });

  return { verdict: decideVerdict(signals, officialMatches, links, input), signals, links, emails, phones, officialMatches };
}

/**
 * Verdict policy (deterministic):
 * - any high signal, or 2+ medium  -> suspicious
 * - the input is ONLY an exact official resource (link/email) with no other content signals -> verified_official_contact
 * - otherwise -> needs_verification (never "safe")
 */
export function decideVerdict(signals: Signal[], officialMatches: string[], links: ExtractedLink[], input: string): Verdict {
  const high = signals.filter((s) => s.severity === 'high').length;
  const med = signals.filter((s) => s.severity === 'medium').length;
  if (high > 0 || med >= 2) return 'suspicious';
  const trimmed = input.trim();
  const isSingleToken = !/\s/.test(trimmed);
  // Only pages we verified (help pages, home page) count. Invoices, requests and other PayPal pages never do.
  const allLinksOfficial = links.length > 0 && links.every((l) => l.isOfficialPayPal && (l.officialKind === 'help' || l.officialKind === 'home'));
  if (isSingleToken && officialMatches.length > 0 && (links.length === 0 || allLinksOfficial) && med === 0) {
    return 'verified_official_contact';
  }
  return 'needs_verification';
}

/** AI may only escalate, never downgrade. */
export function mergeVerdict(rules: Verdict, ai: Verdict | null | undefined): Verdict {
  const rank: Record<Verdict, number> = { verified_official_contact: 0, needs_verification: 1, suspicious: 2 };
  if (!ai || ai === 'verified_official_contact') return rules; // AI can never grant "verified"
  // Rules only say "verified" for a bare official PayPal help/home page with no warning signals.
  // A model's vague doubt about that can lower it to "needs checking", but not to "scam".
  if (rules === 'verified_official_contact' && ai === 'suspicious') return 'needs_verification';
  return rank[ai] > rank[rules] ? ai : rules;
}
