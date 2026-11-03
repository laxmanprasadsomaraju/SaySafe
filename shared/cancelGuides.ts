/**
 * Small curated directory of OFFICIAL cancellation help pages for common Irish/EU subscriptions.
 *
 * SaySafe cannot cancel anyone else's subscription. "Help me cancel" only opens the provider's own help page,
 * and the user does the cancelling there. Every URL was fetched on `verifiedOn` (see docs/COMPANION.md for
 * how it was checked). Anything not in this list gets GENERIC_CANCEL_STEPS, never a guessed link.
 */
export interface CancelGuide {
  id: string;
  name: string;
  /** Lower-case names people say or see on a statement. Matched on word boundaries. */
  aliases: string[];
  url: string;
  /** Short, plain steps. Taken from the official page on verifiedOn. */
  steps: string[];
  /** Anything the user should know before cancelling (notice periods, billed by someone else). */
  note: string | null;
  verifiedOn: string;
  /** How the URL was checked. */
  check: string;
}

export const CANCEL_GUIDES_VERIFIED_ON = '2026-11-03';

export const CANCEL_GUIDES: readonly CancelGuide[] = [
  {
    id: 'netflix', name: 'Netflix', aliases: ['netflix'],
    url: 'https://help.netflix.com/en/node/407',
    steps: ['Sign in at netflix.com yourself.', 'Open Account, then Membership.', 'Choose Cancel membership and confirm.'],
    note: 'If Netflix is billed by another company (for example your TV or phone provider), cancel with them instead.',
    verifiedOn: '2026-11-03', check: 'HTTP 200, page title "How to cancel Netflix | Netflix Help Center"',
  },
  {
    id: 'spotify', name: 'Spotify Premium', aliases: ['spotify'],
    url: 'https://support.spotify.com/ie/article/cancel-premium/',
    steps: ['Sign in to your account page on spotify.com yourself.', 'Open your plan.', 'Choose Cancel Premium and confirm.'],
    note: 'You keep Premium until the end of the period you paid for.',
    verifiedOn: '2026-11-03', check: 'HTTP 200, page title "How to cancel Premium plans - Spotify"',
  },
  {
    id: 'disney_plus', name: 'Disney+', aliases: ['disney+', 'disney plus', 'disneyplus', 'disney'],
    url: 'https://help.disneyplus.com/article/disneyplus-cancel-subscription',
    steps: ['Sign in at disneyplus.com yourself.', 'Open your Profile, then Account.', 'Choose your subscription, then Cancel subscription.'],
    note: 'If you pay through Apple, Google, Amazon or your TV provider, cancel there instead.',
    verifiedOn: '2026-11-03', check: 'HTTP 200 on the official help domain; the article body is rendered by JavaScript, so its text could not be read by a plain fetch',
  },
  {
    id: 'amazon_prime', name: 'Amazon Prime', aliases: ['amazon prime', 'prime video', 'prime membership', 'amazon'],
    url: 'https://www.amazon.co.uk/gp/help/customer/display.html?nodeId=GTJQ7QZY7QL2HK4Y',
    steps: ['Sign in to Amazon yourself.', 'Open Your Amazon Prime Membership.', 'Choose Manage, then Update, Cancel and More, and follow the steps.'],
    note: 'Irish customers usually use amazon.co.uk. If you signed up in the Android app, it is managed through Google Play.',
    verifiedOn: '2026-11-03', check: 'HTTP 200, page heading "Cancel Your Amazon Prime Membership"',
  },
  {
    id: 'apple', name: 'Apple subscriptions (Apple TV+, Apple Music, iCloud+, App Store)', aliases: ['apple', 'apple tv', 'apple tv+', 'apple music', 'icloud', 'icloud+', 'app store', 'itunes'],
    url: 'https://support.apple.com/en-ie/118428',
    steps: ['On your iPhone or iPad, open Settings.', 'Tap your name, then Subscriptions.', 'Tap the subscription, then Cancel Subscription.'],
    note: null,
    verifiedOn: '2026-11-03', check: 'HTTP 200, page title "Cancel a subscription from Apple - Apple Support (IE)"',
  },
  {
    id: 'google_one', name: 'Google One', aliases: ['google one', 'google storage', 'google drive storage'],
    url: 'https://support.google.com/googleone/answer/9056360?hl=en-GB',
    steps: ['Go to one.google.com yourself, or open the Google One app.', 'Open Settings.', 'Choose Cancel membership and confirm.'],
    note: 'If you signed up through the App Store on an iPhone, cancel there instead.',
    verifiedOn: '2026-11-03', check: 'HTTP 200, page title "Cancel your Google One membership - Computer - Google One Help"',
  },
  {
    id: 'now_tv', name: 'NOW (NOW TV)', aliases: ['now tv', 'nowtv', 'now membership', 'now entertainment'],
    url: 'https://www.nowtv.com/ie/help/article/how-do-i-cancel-now',
    steps: ['Sign in at nowtv.com yourself.', 'Open Membership & Payment.', 'Choose the membership, then Cancel membership.'],
    note: 'On a minimum-term plan the cancellation only takes effect when the plan ends. If you pay through Vodafone or Amazon, cancel with them.',
    verifiedOn: '2026-11-03', check: 'HTTP 200, page title "How to cancel your NOW Membership"',
  },
  {
    id: 'sky_ireland', name: 'Sky TV (Ireland)', aliases: ['sky', 'sky tv', 'sky ireland', 'sky sports', 'sky cinema'],
    url: 'https://www.sky.com/help/articles/cancel-sky-tv-roi',
    steps: ['Open the Sky help page yourself.', 'Sky TV needs 31 days notice.', 'Use the contact options on that page (check the flag shows Ireland).'],
    note: 'Early termination charges can apply inside a minimum term.',
    verifiedOn: '2026-11-03', check: 'HTTP 200, page title "Cancelling Sky TV | Sky Help"; mentions the 31 days notice',
  },
];

export const GENERIC_CANCEL_STEPS: readonly string[] = [
  "Open the company's own website or app yourself. Don't use links from emails or texts.",
  'Look for Account, Membership or Subscriptions, then Cancel.',
  'If you pay through Apple, Google, PayPal or your phone or TV provider, cancel there instead.',
  'Keep the confirmation email. You can note it in SaySafe when it arrives.',
];

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

/** Best guide for a merchant name, or null. Longest alias wins (so "amazon prime" beats "amazon"). */
export function findCancelGuide(merchant: string | null | undefined): CancelGuide | null {
  if (!merchant) return null;
  const m = norm(merchant);
  if (!m) return null;
  let best: { g: CancelGuide; len: number } | null = null;
  for (const g of CANCEL_GUIDES) {
    for (const a of g.aliases) {
      const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(m) && (!best || a.length > best.len)) best = { g, len: a.length };
    }
  }
  return best?.g ?? null;
}

export function getCancelGuide(id: string | null | undefined): CancelGuide | null {
  return CANCEL_GUIDES.find((g) => g.id === id) ?? null;
}
