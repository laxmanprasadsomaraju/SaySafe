/**
 * Trusted official PayPal resources.
 * Every entry was checked by hand against the source URL on the date shown.
 * Rule: only add an entry after opening the official page yourself.
 * Never add phone numbers or emails copied from search snippets.
 */
export interface TrustedResource {
  id: string;
  kind: 'domain' | 'email' | 'help_page';
  value: string;
  label: string;
  sourceUrl: string;
  verifiedOn: string; // YYYY-MM-DD
  note?: string;
}

export const TRUSTED_DOMAINS: TrustedResource[] = [
  {
    id: 'dom-paypal-com',
    kind: 'domain',
    value: 'paypal.com',
    label: 'PayPal official website',
    sourceUrl: 'https://www.paypal.com/',
    verifiedOn: '2026-11-02',
    note: 'Registrable domain. Subdomains like www.paypal.com are official; lookalikes such as paypal.com.secure-login.net are not.',
  },
];

export const TRUSTED_EMAILS: TrustedResource[] = [
  {
    id: 'email-phishing',
    kind: 'email',
    value: 'phishing@paypal.com',
    label: 'PayPal phishing report address (forward suspicious emails and texts here)',
    sourceUrl: 'https://www.paypal.com/ie/security/report-suspicious-messages',
    verifiedOn: '2026-11-02',
    note: 'This is a REPORTING address. PayPal never asks you to pay or share codes by email.',
  },
];

export const TRUSTED_HELP_PAGES: TrustedResource[] = [
  {
    id: 'help-report',
    kind: 'help_page',
    value: 'https://www.paypal.com/ie/security/report-suspicious-messages',
    label: 'Report a suspicious message to PayPal',
    sourceUrl: 'https://www.paypal.com/ie/security/report-suspicious-messages',
    verifiedOn: '2026-11-02',
  },
  {
    id: 'help-contact',
    kind: 'help_page',
    value: 'https://www.paypal.com/ie/cshelp/contact-us',
    label: 'Contact PayPal (Ireland help centre)',
    sourceUrl: 'https://www.paypal.com/ie/cshelp/contact-us',
    verifiedOn: '2026-11-02',
  },
  {
    id: 'help-resolution',
    kind: 'help_page',
    value: 'https://www.paypal.com/disputes/',
    label: 'PayPal Resolution Centre (report a problem with a purchase)',
    sourceUrl: 'https://www.paypal.com/disputes/',
    verifiedOn: '2026-11-02',
    note: 'Redirects to /disputes/dashboard behind PayPal sign-in. Disputes are started by the buyer inside PayPal, not by SaySafe.',
  },
  {
    id: 'help-fake-messages',
    kind: 'help_page',
    value: 'https://www.paypal.com/ie/security/learn-about-fake-messages',
    label: 'How to spot fake PayPal messages',
    sourceUrl: 'https://www.paypal.com/ie/security/learn-about-fake-messages',
    verifiedOn: '2026-11-02',
  },
];

/** Brands scammers impersonate, used for lookalike detection. */
export const PROTECTED_BRANDS = ['paypal'];

/** Known URL shorteners: real links can use them, but they hide the destination. */
export const URL_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'lnkd.in', 's.id', 'v.gd', 't.ly',
]);

export const PAYPAL_PHONE_POLICY =
  'SaySafe does not keep a list of PayPal phone numbers. A number in a message cannot be verified here. Use the official contact page instead of calling a number from a message.';
