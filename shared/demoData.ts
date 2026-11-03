/**
 * "Try as Mary" sample data. Deterministic and clearly labelled: every row the server seeds from this file is
 * stored with example=1, shown with a "Sample data" badge, and carries NO PayPal ids (no order, capture, refund
 * or webhook). Dates are offsets in days from the moment the household was seeded.
 *
 * Contact details are deliberately non-routable: phone numbers are in Ofcom's ranges reserved for TV/radio drama
 * (07700 900000–900999 mobile, 020 7946 0000–0999 London) and emails use example.com (RFC 2606).
 */
export const DEMO_SEED_VERSION = 2;

export const SAMPLE_BADGE = 'Sample data';
export const SAMPLE_EVIDENCE = 'Illustrative — no PayPal record';

export interface SampleContact { key: string; name: string; relation: string; phone: string; email: string | null; note: string }
export const SAMPLE_CONTACTS: SampleContact[] = [
  { key: 'alex', name: 'Alex Byrne', relation: 'family helper', phone: '+44 7700 900101', email: 'alex.byrne@example.com', note: 'Trusted family helper. Reviews bigger purchases in SaySafe.' },
  { key: 'sarah', name: 'Sarah', relation: 'daughter', phone: '+44 7700 900102', email: 'sarah@example.com', note: 'Daughter. Lives in Galway.' },
  { key: 'pat', name: 'Pat Doyle', relation: 'gardener', phone: '+44 7700 900103', email: null, note: 'Regular gardener, every second Friday.' },
  { key: 'pharmacy', name: 'Riverside Pharmacy', relation: 'pharmacy', phone: '+44 20 7946 0104', email: 'hello@riverside-pharmacy.example.com', note: 'Repeat prescriptions.' },
  { key: 'boiler', name: 'Shannon Boiler Services', relation: 'boiler service', phone: '+44 20 7946 0105', email: 'bookings@shannon-boiler.example.com', note: 'Annual boiler service.' },
];

export interface SampleRecord { key: string; recipient: string; amountCents: number; method: 'bank_transfer' | 'cash' | 'card' | 'paypal' | 'cheque' | 'other'; daysAgo: number; note: string }
/** Records Mary "typed in" (illustrated). John Smith x2 within 3 days = the possible-duplicate pair. */
export const SAMPLE_RECORDS: SampleRecord[] = [
  { key: 'john1', recipient: 'John Smith', amountCents: 8000, method: 'bank_transfer', daysAgo: 12, note: 'Fence repair' },
  { key: 'john2', recipient: 'John Smith', amountCents: 8000, method: 'bank_transfer', daysAgo: 10, note: 'Fence repair (paid again?)' },
  { key: 'currys', recipient: 'Currys', amountCents: 8900, method: 'card', daysAgo: 24, note: 'Microwave' },
  { key: 'pat', recipient: 'Pat Doyle', amountCents: 4000, method: 'cash', daysAgo: 5, note: 'Hedge trimming' },
  { key: 'pharmacy', recipient: 'Riverside Pharmacy', amountCents: 1850, method: 'card', daysAgo: 2, note: 'Prescription' },
  // Flagship story ("a message says I owe €120"): an illustrative record Mary typed, a POSSIBLE match only. v2.
  { key: 'boiler', recipient: 'Shannon Boiler Services', amountCents: 12000, method: 'bank_transfer', daysAgo: 9, note: 'Annual boiler service' },
];

export interface SampleSub { key: string; merchant: string; amountCents: number; frequency: 'weekly' | 'monthly' | 'yearly'; nextInDays: number; note: string }
/** Illustrative amounts, not the companies' current prices. */
export const SAMPLE_SUBS: SampleSub[] = [
  { key: 'netflix', merchant: 'Netflix', amountCents: 1299, frequency: 'monthly', nextInDays: 6, note: 'Illustrative amount' },
  { key: 'spotify', merchant: 'Spotify Premium', amountCents: 1199, frequency: 'monthly', nextInDays: 13, note: 'Illustrative amount' },
  { key: 'irishtimes', merchant: 'The Irish Times digital', amountCents: 999, frequency: 'monthly', nextInDays: 20, note: 'Illustrative amount' },
  { key: 'prime', merchant: 'Amazon Prime', amountCents: 9500, frequency: 'yearly', nextInDays: 41, note: 'Illustrative amount' },
];

export type SampleApproval = 'pending' | 'approved' | 'declined' | 'expired' | null;
export interface SampleShop { key: string; productId: string; state: string; daysAgo: number; approval: SampleApproval; what: string }
/** Demo Shop-style purchases (illustrated): no PayPal order/capture ids, so they can never be checked out or refunded. */
export const SAMPLE_SHOP: SampleShop[] = [
  { key: 'kettle', productId: 'kettle-classic', state: 'CAPTURED', daysAgo: 52, approval: null, what: 'Completed demo purchase' },
  { key: 'radio', productId: 'radio', state: 'PAYER_APPROVAL_PENDING', daysAgo: 1, approval: null, what: 'Pending: waiting for approval at PayPal' },
  { key: 'toaster', productId: 'toaster', state: 'CANCELLED', daysAgo: 33, approval: null, what: 'Cancelled purchase' },
  { key: 'microwave', productId: 'microwave', state: 'CAPTURED', daysAgo: 40, approval: 'approved', what: 'Family-approved purchase' },
  { key: 'lamp', productId: 'reading-lamp', state: 'CAPTURE_PENDING', daysAgo: 3, approval: null, what: 'Awaiting verification from PayPal' },
  { key: 'pills', productId: 'pill-organiser', state: 'REFUNDED', daysAgo: 45, approval: null, what: 'Illustrative refund' },
  { key: 'throw', productId: 'heated-throw', state: 'FAMILY_APPROVAL_PENDING', daysAgo: 0, approval: 'pending', what: 'Family review: pending (sample, not actionable)' },
  { key: 'coffee', productId: 'coffee-maker', state: 'CANCELLED', daysAgo: 18, approval: 'declined', what: 'Family review: declined' },
  { key: 'phone', productId: 'phone-big-button', state: 'FAMILY_APPROVAL_PENDING', daysAgo: 27, approval: 'expired', what: 'Family review: expired' },
];

/** Tap-to-try scam checks. Fictional, labelled "Training example". Numbers are Ofcom drama numbers. */
export const TRAINING_EXAMPLES = [
  {
    id: 'fake_invoice', label: 'Training example: PayPal invoice with a support number',
    howToTest: 'Expect "Suspicious": a real-looking invoice that asks you to phone a number to cancel.',
    text: 'PayPal: You have a new invoice from Geek Support Services. Invoice INV-2026-88412: Norton 360 renewal €389.99, paid automatically today. If you did not authorise this payment, call PayPal Billing on +44 20 7946 0999 within 24 hours to cancel and get a refund.',
  },
  {
    id: 'hi_mum', label: 'Training example: "Hi Mum, new number"',
    howToTest: 'Expect a warning that the number is not the one saved for Sarah, and advice to call her saved number.',
    text: 'Hi Mum, it’s Sarah. I dropped my phone and this is my new number +44 7700 900999. Can you send €250 today for a bill? I’ll pay you back Friday. Please don’t call, the line is bad.',
  },
  {
    id: 'order_notice', label: 'Training example: ordinary order notice',
    howToTest: 'Expect no obvious warning signs: no link, no number to call, no request for money or details. Still check in the app yourself.',
    text: 'Your SaySafe Demo Shop order of 1 Easy-Pour Electric Kettle (€32.00) has been dispatched. You can see it in the SaySafe app under Activity. We will never ask for your password.',
  },
] as const;

/** The six welcome prompts. Each one is answered from the seeded data (tested in tests/demo-assistant.test.ts). */
export const WELCOME_PROMPTS = [
  'Check this suspicious message',
  'Show my last payment',
  'Did I already pay for the microwave?',
  'Show my subscriptions',
  'Find Alex in my contacts',
  'Help me buy a demo item',
] as const;
