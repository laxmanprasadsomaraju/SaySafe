/**
 * Evidence helpers: exact quotes from the message, safe truncation, extraction of links and
 * phone numbers, and the safe next steps / "could not verify" lines shown with every result.
 *
 * Nothing here opens a link, calls a number or contacts anyone.
 */
import { parse as parseDomain } from 'tldts';

/** Characters that can disguise text: bidi overrides/isolates, zero-width chars, C0/C1 controls (except \n, \t). */
const DISGUISE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function stripDisguise(s: string): string {
  return s.replace(DISGUISE_RE, '');
}

/** HTML-escape for any place evidence is put into markup outside React (React text nodes escape already). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
}

/** Truncate by code points (never splits an emoji / surrogate pair), collapse whitespace. */
export function truncateSafe(s: string, max = 140): string {
  const clean = stripDisguise(s).replace(/\s+/g, ' ').trim();
  const cps = Array.from(clean);
  return cps.length <= max ? clean : cps.slice(0, max - 1).join('') + '…';
}

/** The exact matched span, with a little context, safe to show. */
export function quoteSpan(src: string, start: number, end: number, pad = 28, max = 140): string {
  const a = Math.max(0, start - pad);
  const b = Math.min(src.length, end + pad);
  let s = src.slice(a, b);
  // Do not start/end mid-word in the context part.
  if (a > 0) s = s.replace(/^\S*\s/, '');
  if (b < src.length) s = s.replace(/\s\S*$/, '');
  const text = truncateSafe(s, max);
  return `${a > 0 ? '…' : ''}${text}${b < src.length ? '…' : ''}`;
}

// ---------- Links ----------
// A candidate is anything that looks like a URL or a bare domain. Bare domains are validated with
// the public suffix list (tldts) so "bit.ly/x", "goo.gl/x", "paypal-help.shop" are found
// without a hand-written TLD list, while "e.g." or "file.pdf" are not.
const SCHEME_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]}]+/gi;
const BARE_DOMAIN_RE = /(?<![@\w.-])(?:[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?\.)+(?:xn--[a-z0-9-]{2,59}|[a-z\u00a1-\uffff]{2,24})(?::\d{2,5})?(?:\/[^\s<>"'`)\]}]*)?/gi;
const NOT_TLD = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip', 'exe', 'html', 'htm', 'php', 'js', 'ts', 'csv', 'mp3', 'mp4', 'mov', 'webp', 'heic']);

export function extractLinks(src: string): { raw: string; index: number }[] {
  const out: { raw: string; index: number }[] = [];
  const taken: [number, number][] = [];
  const clean = (s: string) => s.replace(/[.,;:!?]+$/, '');
  for (const m of src.matchAll(SCHEME_URL_RE)) {
    const raw = clean(m[0]);
    out.push({ raw, index: m.index! });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of src.matchAll(BARE_DOMAIN_RE)) {
    const i = m.index!;
    if (taken.some(([a, b]) => i >= a && i < b)) continue;
    const raw = clean(m[0]);
    const host = raw.split(/[/:]/)[0].toLowerCase();
    const tld = host.split('.').pop() ?? '';
    if (NOT_TLD.has(tld)) continue;
    if (/^\d+(\.\d+)+$/.test(host)) continue; // numbers like 3.50 or a version; IPs only count with a scheme
    const p = parseDomain(host);
    if (!p.domain || !p.isIcann) continue;
    out.push({ raw, index: i });
  }
  // de-duplicate, keep first position
  const seen = new Set<string>();
  return out.sort((a, b) => a.index - b.index).filter((l) => (seen.has(l.raw.toLowerCase()) ? false : (seen.add(l.raw.toLowerCase()), true)));
}

// ---------- Phone numbers ----------
const PHONE_CANDIDATE_RE = /(?<![\w#/@.-])(?:\+|00)?\(?\d[\d\s().-]{6,20}\d(?![\w@/-])/g;
const ID_LABEL_RE = /(?:\bid|\bno\.?|#|\bref(?:erence)?|\border|\binvoice|\btransaction|\btracking|\breceipt|\baccount|\biban|\bsort code|\bcase|\bnumber|\bcode|\bpin|\botp|\bdate|\bon|\bversion)\s*[:#.]?\s*$/i;
const PHONE_CONTEXT_RE = /\b(call|ring|phone|tel|telephone|dial|whatsapp|mobile|text|sms|helpline|hotline|toll[- ]?free|contact)\b/i;

export function extractPhones(src: string): { raw: string; index: number }[] {
  const out: { raw: string; index: number }[] = [];
  for (const m of src.matchAll(PHONE_CANDIDATE_RE)) {
    let raw = m[0].trim().replace(/[.\s-]+$/, '');
    if (raw.endsWith(')') && !raw.includes('(')) raw = raw.slice(0, -1).trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;
    const before = src.slice(Math.max(0, m.index! - 24), m.index!);
    const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
    if (/^\s?(?:eur|euro|usd|gbp|%)/i.test(after) || /[€$£]\s?$/.test(before)) continue; // amounts
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(raw) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(raw)) continue; // dates
    if (/^\d{1,2}[:.]\d{2}\s?[-–]\s?\d{1,2}[:.]\d{2}$/.test(raw)) continue; // time ranges
    const hasPhoneContext = PHONE_CONTEXT_RE.test(before);
    if (ID_LABEL_RE.test(before) && !hasPhoneContext) continue; // order/invoice/transaction ids
    const intl = /^(?:\+|00)/.test(raw);
    const local = /^0\d/.test(digits) || /^\(0/.test(raw);
    const grouped = /\d[\s().-]+\d/.test(raw);
    // A long run of plain digits without a phone shape or phone wording is far more likely an ID.
    if (!intl && !local && !grouped && !hasPhoneContext) continue;
    if (!intl && !local && !hasPhoneContext && digits.length > 11) continue;
    out.push({ raw, index: m.index! });
  }
  return out;
}

// ---------- Safe next steps (every URL/email below was opened on the official page on the date shown) ----------
export interface NextStep { id: string; text: string; url?: string; urlLabel?: string; sourceUrl: string; verifiedOn: string }

export const SAFE_NEXT_STEPS: NextStep[] = [
  {
    id: 'open-app',
    text: "Open the PayPal app, or type paypal.com into your browser yourself. Don't use any link in the message.",
    sourceUrl: 'https://www.paypal.com/ie/security/learn-about-fake-messages',
    verifiedOn: '2026-11-03',
  },
  {
    id: 'no-calls',
    text: 'Never call a phone number in the message. If you need PayPal, use the Contact page in their Help Centre.',
    url: 'https://www.paypal.com/ie/smarthelp/contact-us',
    urlLabel: 'PayPal Help Centre: contact',
    sourceUrl: 'https://www.paypal.com/ie/security/learn-about-fake-messages',
    verifiedOn: '2026-11-03',
  },
  {
    id: 'no-codes',
    text: "Don't share codes, passwords or card details with anyone, even someone who says they are PayPal.",
    sourceUrl: 'https://www.paypal.com/ie/security/learn-about-fake-messages',
    verifiedOn: '2026-11-03',
  },
  {
    id: 'report',
    text: 'Report it: forward the whole message to phishing@paypal.com, then delete it.',
    url: 'https://www.paypal.com/ie/security/report-suspicious-messages',
    urlLabel: "PayPal's report page",
    sourceUrl: 'https://www.paypal.com/ie/security/report-suspicious-messages',
    verifiedOn: '2026-11-03',
  },
  {
    id: 'garda',
    text: 'In Ireland: if you lost money or shared details, contact your bank straight away and report it to your local Garda station.',
    url: 'https://www.garda.ie/en/crime/fraud/what-are-the-6-most-common-types-of-fraud-in-ireland-today-and-how-to-avoid-becoming-a-victim-.html',
    urlLabel: 'Garda fraud advice',
    sourceUrl: 'https://www.garda.ie/en/crime/fraud/what-are-the-6-most-common-types-of-fraud-in-ireland-today-and-how-to-avoid-becoming-a-victim-.html',
    verifiedOn: '2026-11-03',
  },
];

export function nextStepsFor(verdict: string, has: { links: boolean; phones: boolean }): NextStep[] {
  const ids = ['open-app'];
  if (has.phones || verdict !== 'no_obvious_warning_signs') ids.push('no-calls');
  ids.push('no-codes');
  if (verdict !== 'no_obvious_warning_signs') ids.push('report', 'garda');
  return SAFE_NEXT_STEPS.filter((s) => ids.includes(s.id));
}

/** Plain list of what SaySafe did not and cannot check. Always shown. */
export function couldNotVerify(has: { links: boolean; phones: boolean; emails: boolean; money: boolean; fromImage?: boolean }): string[] {
  const out = ['Who really sent this message. Sender names, numbers and addresses can be faked.'];
  out.push('Whether any payment, invoice, refund or charge in it is real. Only the PayPal app shows your real activity.');
  if (has.links) out.push('Where the links really lead. SaySafe never opens them; it only reads the address.');
  if (has.phones) out.push('Who answers the phone numbers. SaySafe has no list of genuine PayPal numbers.');
  if (has.emails) out.push('Whether the email addresses belong to who they claim.');
  if (has.fromImage) out.push('That the screenshot was read perfectly. Letters like l and I, or 0 and O, can be misread.');
  return out;
}
