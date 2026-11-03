/**
 * Payment companion: shared zod schemas for the server API and the Assistant cards.
 *
 * Everything here is PRIVATE to the elder who saved it. Family members never see it (no family endpoint,
 * no insights, no activity feed). Manual records and contacts are "saved by you — not verified".
 * SaySafe never pays, blocks, or cancels anything from these records.
 */
import { z } from 'zod';

export const COMPANION_LABELS = {
  manual: 'Recorded by you, not verified',
  contact: 'Saved by you — not verified',
  sandbox: 'SaySafe Demo Shop (PayPal sandbox)',
  prototype: 'Prototype: you enter these yourself. SaySafe cannot see your bank or cancel anything for you.',
  confirmed: 'You confirmed',
  sample: 'Sample data — illustrative, not a real record',
  sampleEvidence: 'Illustrative — no PayPal record',
  realSandbox: 'Real PayPal Sandbox transaction',
} as const;

/** PayPal's own public "Send money" page (HTTP 200, title "Send Money Online Instantly | PayPal IE", checked 2026-11-03). */
export const PAYPAL_SEND_MONEY_URL = 'https://www.paypal.com/ie/digital-wallet/send-receive-money/send-money';
export const SEND_MONEY_NOTICE = 'Nothing is sent by SaySafe. SaySafe can’t move money from your PayPal account to a person: you send it yourself in PayPal, signed in to PayPal.';

export const DEMO_SHOP_RECIPIENT = 'SaySafe Demo Shop';
export const MAX_CONTACTS = 50;
export const MAX_MANUAL_PAYMENTS = 500;
export const MAX_SUBSCRIPTIONS = 100;
/** Dates further than this from what was asked get a "date is off" caveat. */
export const DATE_TOLERANCE_DAYS = 3;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'invalid date');
const text = (max: number) => z.string().trim().max(max);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR');
const cents = z.number().int().positive().max(100_000_000);

export const IsoDate = isoDate;

// ---------- Manual payment records ----------
export const PAY_METHODS = ['bank_transfer', 'cash', 'card', 'paypal', 'cheque', 'other'] as const;
export const ManualPaymentInput = z.object({
  recipient: text(80).min(1),
  amountCents: cents,
  currency,
  paidOn: isoDate,
  method: z.enum(PAY_METHODS).default('other'),
  note: text(200).optional().nullable(),
}).strict();
export type ManualPaymentInputT = z.infer<typeof ManualPaymentInput>;
export const ManualPaymentPatch = ManualPaymentInput.partial().strict();

export const ManualPayment = z.object({
  id: z.string(),
  recipient: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  paidOn: z.string(),
  method: z.enum(PAY_METHODS),
  note: z.string().nullable(),
  label: z.literal(COMPANION_LABELS.manual),
  /** Deterministic "Try as Mary" sample row (shown with a "Sample data" badge). */
  sample: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManualPaymentT = z.infer<typeof ManualPayment>;

// ---------- Payment search ----------
export const PaymentSearchQuery = z.object({
  q: text(80).optional(),
  /** Major units, e.g. "80" or "80.50". */
  amount: z.coerce.number().positive().max(1_000_000).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
}).strict();
export type PaymentSearchQueryT = z.infer<typeof PaymentSearchQuery>;

export const PaymentEvidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paypal_sandbox'), captureStatus: z.string().nullable(), webhookVerified: z.boolean(), orderState: z.string() }),
  z.object({ kind: z.literal('manual'), label: z.literal(COMPANION_LABELS.manual), method: z.enum(PAY_METHODS) }),
  /** "Try as Mary" sample data: never a real payment. basis = which kind of record it illustrates. */
  z.object({ kind: z.literal('sample'), label: z.literal(COMPANION_LABELS.sampleEvidence), basis: z.enum(['shop', 'record']), method: z.enum(PAY_METHODS).nullable(), orderState: z.string().nullable() }),
]);

export const PaymentMatch = z.object({
  id: z.string(),
  source: z.enum(['paypal_sandbox', 'manual']),
  recipient: z.string(),
  description: z.string().nullable(),
  amountCents: z.number().int(),
  currency: z.string(),
  date: z.string(),
  score: z.number().min(0).max(1),
  matchReasons: z.array(z.string()),
  caveats: z.array(z.string()),
  evidence: PaymentEvidence,
  sample: z.boolean().optional(),
});
export type PaymentMatchT = z.infer<typeof PaymentMatch>;

/**
 * Two records with the same payee, amount and currency, classified (server/companion/match.ts classifyRepeat):
 *  - identical_entries: same day AND same note -> may be ONE payment typed in twice (or two; ask before deleting).
 *  - possible_duplicate: close dates (<= DUPLICATE_WINDOW_DAYS) and the same kind of work -> ask before paying again.
 *  - separate_payments: far apart, or clearly different work -> mentioned calmly, no warning.
 * (The same record reached twice is never a pair: candidates are de-duplicated by id first.)
 */
export const REPEAT_KINDS = ['identical_entries', 'possible_duplicate', 'separate_payments'] as const;
export const DUPLICATE_WINDOW_DAYS = 14;
export const RepeatGroup = z.object({
  kind: z.enum(REPEAT_KINDS),
  ids: z.array(z.string()).length(2),
  recipient: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  daysApart: z.number().int().min(0),
  message: z.string(),
});
export type RepeatGroupT = z.infer<typeof RepeatGroup>;

export const PaymentSearchResult = z.object({
  query: z.object({ q: z.string().nullable(), amountCents: z.number().int().nullable(), from: z.string().nullable(), to: z.string().nullable() }),
  matches: z.array(PaymentMatch),
  repeats: z.array(RepeatGroup).optional(),
  /** Plain, calm uncertainty text: what this does and does not prove. */
  guidance: z.string(),
  notes: z.array(z.string()),
});
export type PaymentSearchResultT = z.infer<typeof PaymentSearchResult>;

// ---------- Subscriptions (prototype) ----------
export const FREQUENCIES = ['weekly', 'monthly', 'yearly'] as const;
export const SUB_STATUSES = ['tracking', 'instructions_opened', 'user_reported_cancelled', 'cancellation_requested', 'provider_confirmed'] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];
export const SUB_SOURCES = ['manual', 'paypal_sandbox_subscription'] as const;
export type SubSource = (typeof SUB_SOURCES)[number];
/**
 * Moves the USER may make on a subscription they entered themselves (source "manual", i.e. external merchants).
 * SaySafe can't cancel those, so the furthest it goes is "user_reported_cancelled". Never "provider_confirmed".
 */
export const SUB_TRANSITIONS: Record<SubStatus, readonly SubStatus[]> = {
  tracking: ['instructions_opened'],
  instructions_opened: ['user_reported_cancelled', 'tracking'],
  user_reported_cancelled: ['tracking'],
  cancellation_requested: [],
  provider_confirmed: [],
};
/** Only the server sets these, for the SaySafe Demo Membership (PayPal sandbox subscription), after PayPal answers. */
export const SERVER_ONLY_STATUSES: readonly SubStatus[] = ['cancellation_requested', 'provider_confirmed'];
export const SUB_STATUS_LABEL: Record<SubStatus, string> = {
  tracking: 'Tracking',
  instructions_opened: 'Cancel steps opened',
  user_reported_cancelled: 'You told SaySafe this is cancelled — not confirmed by the provider',
  cancellation_requested: 'Cancelling with PayPal — not confirmed yet',
  provider_confirmed: 'PayPal confirmed the billing authorisation is cancelled',
};

export const PAYPAL_AUTOPAY_URL = 'https://www.paypal.com/myaccount/autopay/';
export const PAYPAL_AUTOPAY_HELP_URL = 'https://www.paypal.com/ie/cshelp/article/what-is-an-automatic-payment-and-how-do-i-update-or-cancel-one-help240';
export const DEMO_MEMBERSHIP = {
  name: 'SaySafe Demo Membership',
  merchant: 'SaySafe Demo Shop',
  amountCents: 299,
  currency: 'EUR',
  frequency: 'monthly' as const,
  /** Exact text on the confirmation card. The cancel call needs a tap on it (a token), never a spoken "yes". */
  cancelConfirmText: 'Cancel SaySafe Demo Membership billing via PayPal',
  cancelTokenTtlSeconds: 300,
};

/**
 * Two different things get cancelled. A PayPal billing authorisation (automatic payment) only stops PayPal paying
 * the merchant; the service contract is between the user and the merchant.
 */
export const CANCELLATION_SCOPE = {
  demo: {
    billingAuthorisation: 'PayPal billing authorisation: SaySafe cancels it through the PayPal API after you tap to confirm, then checks with PayPal.',
    serviceContract: 'Service contract: the merchant is SaySafe Demo Shop itself, so the membership ends with the billing.',
  },
  external: {
    billingAuthorisation: "PayPal billing authorisation: if you pay this company through PayPal, you can stop PayPal paying them in PayPal's automatic payments page. You do this yourself, signed in to PayPal.",
    serviceContract: "Service contract: that is between you and the company. Cancel with them too, or they may keep charging another way or ask for payment.",
  },
} as const;

export const SubscriptionInput = z.object({
  merchant: text(80).min(1),
  amountCents: cents,
  currency,
  frequency: z.enum(FREQUENCIES),
  nextOn: isoDate.optional().nullable(),
  note: text(200).optional().nullable(),
}).strict();
export const SubscriptionPatch = SubscriptionInput.partial().strict();

/** User status changes for MANUAL (external) subscriptions only. */
export const SubscriptionStatusChange = z.discriminatedUnion('to', [
  z.object({ to: z.literal('tracking') }).strict(),
  z.object({ to: z.literal('instructions_opened') }).strict(),
  z.object({ to: z.literal('user_reported_cancelled'), note: text(300).optional().nullable(), reportedOn: isoDate.optional().nullable() }).strict(),
]);

export const DemoCancelBody = z.object({ token: z.string().min(20).max(100) }).strict();

export const Subscription = z.object({
  id: z.string(),
  merchant: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  frequency: z.enum(FREQUENCIES),
  nextOn: z.string().nullable(),
  nextPaymentInDays: z.number().int().nullable(),
  note: z.string().nullable(),
  source: z.enum(SUB_SOURCES),
  status: z.enum(SUB_STATUSES),
  statusLabel: z.string(),
  /** The user's own note when they reported it cancelled (external), or PayPal's confirmation (demo). */
  evidenceNote: z.string().nullable(),
  confirmedOn: z.string().nullable(),
  /** Who confirmed: the user (external) or PayPal (demo: paypal_api after a GET, or a signed webhook). */
  confirmedBy: z.enum(['user', 'paypal_api', 'paypal_webhook']).nullable(),
  /** Only for the PayPal sandbox Demo Membership. */
  paypal: z.object({
    subscriptionId: z.string(),
    status: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
    webhookVerified: z.boolean(),
    approveUrl: z.string().nullable(),
    cancel: z.object({ state: z.enum(['none', 'in_progress', 'retry_needed', 'confirmed']), error: z.string().nullable() }),
  }).nullable(),
  cancellationScope: z.object({ billingAuthorisation: z.string(), serviceContract: z.string() }),
  /** Set when the user chose "Stop tracking". Not the same as cancelled. */
  stoppedTrackingAt: z.string().nullable(),
  guide: z.object({ id: z.string(), name: z.string(), url: z.string().url() }).nullable(),
  /** How it is managed: the merchant's checked official page, general steps (no checked link), or the PayPal API (Demo Membership). */
  managementMethod: z.enum(['official_link', 'generic_steps', 'paypal_api']).optional(),
  category: z.string().nullable().optional(),
  sample: z.boolean().optional(),
  label: z.literal(COMPANION_LABELS.prototype),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SubscriptionT = z.infer<typeof Subscription>;

export const CurrencyTotal = z.object({ currency: z.string(), count: z.number().int(), monthlyCents: z.number().int(), annualCents: z.number().int() });
export const SubscriptionSummary = z.object({
  /** One row per currency. Never converted between currencies. */
  totals: z.array(CurrencyTotal),
  counted: z.number().int(),
  excluded: z.object({ stoppedTracking: z.number().int(), providerConfirmed: z.number().int(), userReportedCancelled: z.number().int() }),
  upcoming: z.array(z.object({ id: z.string(), merchant: z.string(), amountCents: z.number().int(), currency: z.string(), nextOn: z.string(), inDays: z.number().int() })),
  label: z.literal(COMPANION_LABELS.prototype),
  method: z.string(),
});
export type SubscriptionSummaryT = z.infer<typeof SubscriptionSummary>;

// ---------- Trusted contacts ----------
export const ContactInput = z.object({
  name: text(60).min(1),
  relation: text(40).optional().nullable(),
  phone: z.string().trim().max(30).regex(/^[+()\d\s.-]*$/, 'phone').optional().nullable(),
  email: z.string().trim().toLowerCase().max(120).email().optional().nullable().or(z.literal('').transform(() => null)),
  note: text(200).optional().nullable(),
}).strict();
export const ContactPatch = ContactInput.partial().strict();
export const Contact = z.object({
  id: z.string(),
  name: z.string(),
  relation: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  note: z.string().nullable(),
  label: z.literal(COMPANION_LABELS.contact),
  sample: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ContactT = z.infer<typeof Contact>;

// ---------- Assistant intents + cards ----------
export const COMPANION_ACTIONS = ['payment_search', 'last_payment', 'monthly_costs', 'subscription_help', 'contact_lookup', 'subscription_list', 'send_money'] as const;
export const SUB_FOCUS = ['all', 'most', 'next'] as const;
export type CompanionAction = (typeof COMPANION_ACTIONS)[number];

/** What the AI may extract. It only names parameters: the server runs the query on the user's own records. */
export const CompanionIntentParams = z.object({
  // Each field falls back to null on a bad value, so a malformed parameter never breaks the whole intent.
  recipient: z.string().trim().max(80).nullable().optional().catch(null),
  amount: z.number().positive().max(1_000_000).nullable().optional().catch(null),
  date_hint: z.string().trim().max(60).nullable().optional().catch(null),
  merchant: z.string().trim().max(80).nullable().optional().catch(null),
  contact_name: z.string().trim().max(60).nullable().optional().catch(null),
  relation: z.string().trim().max(40).nullable().optional().catch(null),
  /** subscription_list: all, the most expensive, or the next to be charged. */
  focus: z.enum(SUB_FOCUS).nullable().optional().catch(null),
  /** subscription_help: a kind of subscription ("streaming") when no company was named. */
  category: z.string().trim().max(40).nullable().optional().catch(null),
  /** contact_lookup: list every saved contact. */
  list_all: z.boolean().nullable().optional().catch(null),
});
export const COMPANION_PARAM_KEYS = ['recipient', 'amount', 'date_hint', 'merchant', 'contact_name', 'relation', 'focus', 'category', 'list_all'] as const;
export type CompanionIntentParamsT = z.infer<typeof CompanionIntentParams>;

export const CancelGuideCard = z.object({ id: z.string(), name: z.string(), url: z.string().url().refine((u) => u.startsWith('https://')), steps: z.array(z.string()), note: z.string().nullable(), verifiedOn: z.string() });

/** Cards the server can return from /api/assistant for companion intents (UI registers these in phase 2). */
export const CompanionCard = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('payment_matches'), result: PaymentSearchResult }),
  z.object({ kind: z.literal('last_payment'), payment: PaymentMatch.nullable(), guidance: z.string() }),
  z.object({ kind: z.literal('monthly_costs'), summary: SubscriptionSummary }),
  z.object({
    kind: z.literal('subscription_help'), merchant: z.string().nullable(),
    subscription: Subscription.nullable(),
    guide: CancelGuideCard.nullable(),
    genericSteps: z.array(z.string()),
    paypalAutopayUrl: z.literal(PAYPAL_AUTOPAY_URL),
    cancellationScope: z.object({ billingAuthorisation: z.string(), serviceContract: z.string() }),
    disclaimer: z.string(),
  }),
  /** The ONLY cancel the assistant can produce: a confirmation card. Cancelling needs a tap that sends this token. */
  z.object({
    kind: z.literal('demo_cancel_intent'), subscriptionId: z.string(), confirmText: z.literal(DEMO_MEMBERSHIP.cancelConfirmText),
    token: z.string(), expiresAt: z.string(), cancelEndpoint: z.literal('/api/companion/subscriptions/demo/cancel'),
    cancellationScope: z.object({ billingAuthorisation: z.string(), serviceContract: z.string() }),
  }),
  z.object({ kind: z.literal('contact_card'), contacts: z.array(Contact), query: z.string().nullable(), advice: z.string() }),
  /** "Show my subscriptions" / "Which costs the most?" / "What's coming out next?" — from her own records. */
  z.object({
    kind: z.literal('subscriptions_list'), focus: z.enum(SUB_FOCUS), subscriptions: z.array(Subscription), summary: SubscriptionSummary,
    highlight: z.object({ mostMonthlyId: z.string().nullable(), largestChargeId: z.string().nullable(), nextId: z.string().nullable() }),
    demoOffer: z.boolean(),
  }),
  /** "Send Alex €50": choose the saved contact, review, then PayPal's own Send money page. SaySafe never sends money. */
  z.object({
    kind: z.literal('send_money'), query: z.string().nullable(), contacts: z.array(Contact), amountCents: z.number().int().positive().nullable(), currency: z.string(),
    paypalSendUrl: z.literal(PAYPAL_SEND_MONEY_URL), notice: z.literal(SEND_MONEY_NOTICE),
  }),
  z.object({ kind: z.literal('companion_sign_in'), message: z.string() }),
]);
export type CompanionCardT = z.infer<typeof CompanionCard>;

// ---------- Subscription kinds (for "cancel my streaming subscription") ----------
export const SUB_CATEGORIES: { id: string; words: RegExp; merchants: RegExp }[] = [
  { id: 'streaming', words: /\b(streaming|tv|television|films?|movies?|box ?sets?|video)\b/i, merchants: /\b(netflix|disney|now ?tv|^now$|apple tv|prime video|paramount|sky)\b/i },
  { id: 'music', words: /\b(music|songs?|spotify)\b/i, merchants: /\b(spotify|apple music|deezer|tidal|youtube music)\b/i },
  { id: 'news', words: /\b(news|newspaper|paper)\b/i, merchants: /\b(irish times|irish independent|guardian|times|telegraph|examiner)\b/i },
  { id: 'shopping', words: /\b(shopping|delivery)\b/i, merchants: /\b(amazon|prime)\b/i },
];
/** The kind of a merchant's subscription, from its name only. */
export function categoryOf(merchant: string): string | null {
  return SUB_CATEGORIES.find((c) => c.merchants.test(merchant))?.id ?? null;
}
/** A kind of subscription named in a request ("my streaming subscription"), if any. */
export function categoryIn(text: string): string | null {
  return SUB_CATEGORIES.find((c) => c.words.test(text))?.id ?? null;
}
