/**
 * Text for "Share warning on WhatsApp". Built ONLY from the verdict and generic phrases chosen by
 * signal code. It never uses the message, the evidence, signal titles or anything the sender wrote,
 * so it cannot carry names, payment/order/capture IDs, phone numbers, emails or links from the message.
 * sanitizeShareText() runs on the final text as a second safety net.
 */
export const PUBLIC_SAYSAFE_URL = 'https://saysafe.onrender.com/guide';

export type ShareVerdict = 'suspicious' | 'needs_checking' | 'no_obvious_warning_signs';
export interface ShareInput { verdict: string; signals: { code: string; severity: string }[] }

const LABEL: Record<ShareVerdict, string> = { suspicious: 'Suspicious', needs_checking: 'Needs checking', no_obvious_warning_signs: 'No obvious warning signs' };
const LEGACY: Record<string, ShareVerdict> = { needs_verification: 'needs_checking', verified_official_contact: 'no_obvious_warning_signs' };

/** Generic wording per signal code. Nothing here comes from the message. */
const GENERIC: Record<string, string> = {
  phone_with_charge: 'a phone number next to a charge you may not have made',
  invoice_scam: 'a charge or renewal you may not have made',
  call_to_cancel: 'it tells you to call to cancel or get a refund',
  call_us: 'it tells you to call "support"',
  phone_unverified: 'a phone number to call',
  sensitive_request: 'it asks for codes, passwords or card details',
  otp_present: 'it contains a one-time code',
  remote_access: 'it asks you to install an app or share your screen',
  gift_card: 'it asks for gift cards',
  crypto: 'it mentions crypto',
  payment_via_link: 'it asks you to pay through a link',
  payment_demand: 'it asks for money',
  paypal_user_content: 'a PayPal invoice or money request that anyone can send',
  urgency: 'it pressures you to act fast',
  account_problem: 'it claims there is a problem with your account',
  secrecy: 'it asks you to keep it secret',
  safe_account: 'it asks you to move money to a "safe account"',
  family_impersonation: 'someone may be pretending to be family',
  overpayment_story: 'a refund or "paid too much" story',
  romance_investment: 'a romance or investment story',
  prize: 'it says you have won something',
  qr_code: 'it asks you to scan a QR code',
  threat_intel: 'a link on a known scam list',
  url_at_trick: 'a link that hides its real address',
  url_ip: 'a link to a number address',
  url_idn: 'a link with look-alike letters',
  url_brand_in_subdomain: 'a link pretending to be a real company',
  url_brand_lookalike: 'a link imitating a real company',
  url_typosquat: 'a link spelled almost like a real company',
  url_brand_in_path: 'a link that mentions a company but goes elsewhere',
  url_shortener: 'a short link that hides where it goes',
  url_login_words: 'a link asking you to sign in on another site',
  link_unverified: 'a link SaySafe cannot check',
  email_brand_lookalike: 'an email address pretending to be a company',
  email_free_provider: 'a free email address claiming to be support',
};
const RANK: Record<string, number> = { high: 0, medium: 1, info: 2 };

export function shareVerdict(v: string): ShareVerdict {
  return (v in LABEL ? v : LEGACY[v] ?? 'needs_checking') as ShareVerdict;
}

/** Remove anything that looks like a link, email, phone number or long ID, except SaySafe's own public link. */
export function sanitizeShareText(text: string): string {
  const keep = '\u0000SAYSAFE\u0000';
  const keepPP = '\u0000PAYPAL\u0000';
  // Only SaySafe's public page and the bare words "paypal.com" (our own advice) survive.
  let s = text.split(PUBLIC_SAYSAFE_URL).join(keep).replace(/(?<![\w.@/-])paypal\.com(?![\w.@/-])/gi, keepPP);
  s = s.replace(/\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[removed]'); // emails
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[removed]'); // urls with scheme
  s = s.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:[a-z]{2,24}|xn--[a-z0-9-]+)(?:\/\S*)?/gi, (m) => (/^\d+(?:\.\d+)+$/.test(m) ? m : '[removed]')); // bare domains
  s = s.replace(/(?:\+|00)?\(?\d[\d\s().-]{6,}\d/g, '[removed]'); // phone numbers and long digit runs
  s = s.replace(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{7,}\b/gi, '[removed]'); // IDs like 7HG23456KL890123M, INV2-7KQ4-PL93
  return s.split(keep).join(PUBLIC_SAYSAFE_URL).split(keepPP).join('paypal.com');
}

export function buildShareText(r: ShareInput): string {
  const v = shareVerdict(r.verdict);
  const phrases: string[] = [];
  for (const sg of [...r.signals].sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3))) {
    const p = GENERIC[sg.code];
    if (p && !phrases.includes(p) && sg.severity !== 'info') phrases.push(p);
    if (phrases.length === 2) break;
  }
  const lines = [`SaySafe check: ${LABEL[v]}`];
  if (v === 'no_obvious_warning_signs') {
    lines.push("SaySafe can't confirm who sent this or whether a payment is real. Check in the official PayPal app.");
  } else if (phrases.length) {
    lines.push(`Warning signs: ${phrases.join('; ')}.`);
  }
  lines.push("Safe next step: open the PayPal app or type paypal.com yourself. Don't use links or call numbers in the message, and never share codes or passwords.");
  lines.push(`Check a message yourself: ${PUBLIC_SAYSAFE_URL}`);
  return sanitizeShareText(lines.join('\n'));
}

/** wa.me with no phone number: WhatsApp asks the user which contact to send it to. */
export function whatsappUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
